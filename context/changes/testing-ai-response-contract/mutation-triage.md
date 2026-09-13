# Mutation triage — rollout Phase 1, plan Phase 5

Run 2026-09-13, Stryker 10, scope `src/lib/services/recommendations.ts` +
`src/lib/recommendation-guardrail.ts`, 513 mutants, existing Vitest suite.
Selective gate (test-plan §5) — run ad hoc, never wired into CI.

|                          | before triage | after       |
| ------------------------ | ------------- | ----------- |
| Mutation score (total)   | 42.34 %       | **46.60 %** |
| Mutation score (covered) | 48.18 %       | **52.27 %** |
| Killed                   | 196           | **216**     |
| Survived                 | 214           | 200         |
| No coverage              | 57            | 51          |

The score is **not** the goal. Per CLAUDE.md, a test that pins an
implementation detail to raise it is itself a vibe test. Every mutant below has
a verdict: killed, or ignored for a stated reason.

## Killed — six assertions added

| Mutant                                                                                           | Why it mattered                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.messages.create({})` (`:323`) and the `messages` / `output_config` literals (`:327-328`) | The stub never inspected the request, so dropping the JSON-schema `output_config` would have passed every test. Without it the model may answer in prose and every attempt fails the parse — **Risk #1**, which reached production on 2026-09-13. |
| `attempt === 1` → `true` / `false` / `!==` (`:317`), re-prompt body → ` ` `` (`:319`)            | A retry that repeats the first prompt verbatim gives the model no reason to answer differently; the `false` form tells the model its previous answer was rejected before it has given one.                                                        |
| `validateWorkoutStructure([alt], …)` → `validateWorkoutStructure([], …)` (`:408`)                | An empty array always validates, so the structure guardrail silently stops filtering **on the salvage path** — an implausibly paced workout could ship. PRD l. 42 / l. 53.                                                                        |
| `context: { … }` → `{}` (`:445`)                                                                 | The context is persisted with the chosen workout; emptying it strands the saved session from its goal and modifiers.                                                                                                                              |

## Ignored — with reasons

| #   | Category                                                                                                                                                                                             | Verdict                                                                                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~30 | **Error and log prose** — `LlmError` messages, `lastViolations` strings, re-prompt tails                                                                                                             | Locked decision: assertions key on the `reason` code, never on message prose. The run confirms this works — at `:313` the `"timeout"` → `""` mutant **dies** while the prose mutant survives, which is the designed split.                          |
| ~8  | **Boundary operators on ungrounded constants** — `>` → `>=` on `TOTAL_BUDGET_MS`, `>=` → `>` on `DAILY_CAP`, `<` → `<=` on `MAX_ATTEMPTS`, `<` → `<=` on `LOW_BODY_BATTERY`                          | Killing these requires a test that knows the constant's value. The plan forbids exactly that ("no test may pin a guardrail threshold constant"); research found every one of them ungrounded.                                                       |
| 13  | **Structured-log internals** (`:419-429`)                                                                                                                                                            | Observability surface, deliberately mocked out in tests. Pinning the log's shape is brittle and buys nothing a runner can feel. Revisit if the log becomes load-bearing for alerting.                                                               |
| 2   | **Token accounting** `+=` → `-=` (`:340-341`)                                                                                                                                                        | Cost/observability only; no runner-visible effect.                                                                                                                                                                                                  |
| 36  | **Prompt composition** — `buildUserContext`, `RECOVERY_CONFLICT_INSTRUCTION`                                                                                                                         | Prompt _wording_ is now partially guarded (the request-contract test pins structured output and that a retry differs), but asserting the prose itself would pin implementation detail. Prompt quality belongs to a dedicated effort, not this risk. |
| 64  | **Pace and duration band math** — `deriveEasyPace`, `derivePaceBand`, `deriveDurationBand`, `parsePaceToSeconds`, `formatPace`                                                                       | Every branch here is derived from the multipliers the plan excludes from assertion. `recommendation-guardrail.test.ts` covers the contract level; going deeper means pinning the ungrounded numbers.                                                |
| 19  | **Zod schema internals** — `recommendationResponseSchema`, `stepSchema` field constraints                                                                                                            | The contract-level cases (wrong count, malformed alternative, unknown field) are already asserted. Per-field constraint mutants restate the schema.                                                                                                 |
| ~29 | **Out-of-rollout branches** — daily cap (`readTodayCount`, `bumpTodayCount`, `todayIso`), `recoveryIsMissing`, `isRecoveryConflict`, `isHardWorkout`, `isRun`, `extractText`, `toWorkoutAlternative` | Assigned elsewhere: the 429 daily-cap path is test-plan §3 Phase 2; S-06 recovery conflict is its own slice. Not this rollout's risks (#1, #2, #7).                                                                                                 |
| 51  | **No coverage**                                                                                                                                                                                      | Code no test in scope reaches — chiefly prompt constants and recovery-conflict helpers. Same verdict as the row above: out of this rollout's risk scope, not an oversight.                                                                          |

## One thing the run proved beyond the score

`.length(3)` on the response schema (`recommendation-guardrail.ts:153`) means a
model returning two well-formed alternatives is a hard 502 — the salvage path
never sees it, because salvage runs only _after_ a successful parse. That
collides with Phase 2's decision that `MIN_ALTERNATIVES` is 1. Observed live on
2026-09-13. Not fixed here; no source settles whether the schema should accept
1–3 and let the guardrails decide.

## The `ignoreStatic` blind spot (checked 2026-09-13, impl-review F6)

`stryker.conf.json` sets `ignoreStatic: true`, which drops mutants in
module-level initializers — so the safety constants themselves
(`TOTAL_BUDGET_MS`, `TIMEOUT_MS`, `MAX_ATTEMPTS`, `MIN_ALTERNATIVES`,
`DAILY_CAP`, `SYSTEM_PROMPT`, `MIN_FACTOR` / `MAX_FACTOR` /
`EFFORT_PACE_MULTIPLIERS` / `ABS_*`) never appear in the report at all. The
concern is legitimate: constants exempt from the gate meant to probe them.

Measured, rather than assumed. One pass over `recommendation-guardrail.ts` with
`ignoreStatic: false`:

|               | `ignoreStatic: true` | `ignoreStatic: false` |
| ------------- | -------------------- | --------------------- |
| Mutants       | 229                  | 255                   |
| Killed        | 108                  | 119                   |
| Survived      | 100                  | 115                   |
| Score (total) | 47.16 %              | 46.67 %               |

So the flag hides 26 mutants, of which **11 are actually killed** by the
existing tests and 15 survive. The score overstatement is about half a point,
not an order of magnitude — and the 15 survivors fall squarely in the category
already ignored above: they are the ungrounded constants the plan forbids
pinning. Verdict: **keep `ignoreStatic: true` for routine runs** (it removes
noise that would all be ignored anyway), with this measurement on record so the
choice is informed rather than accidental. Re-measure if the constants ever
acquire a source.

## Reproducing

```bash
npx stryker run          # ~70 s, config at stryker.conf.json
```

Report: `reports/mutation/mutation.html` (gitignored, along with `.stryker-tmp/`).
