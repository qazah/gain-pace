# Test Rollout Phase 1 — AI Response Contract — Plan Brief

> Full plan: `context/changes/testing-ai-response-contract/plan.md`
> Research: `context/changes/testing-ai-response-contract/research.md`

## What & Why

Rollout Phase 1 of `context/foundation/test-plan.md` §3 protects the runner against three failures: a response-contract change that silently breaks parsing (#1), a degradation contract that can be reverted unnoticed (#2), and an AI call that fails slowly and opaquely (#7). Research found that `src/lib/services/recommendations.ts` has **zero tests** and that three of its contracts are not merely untested but wrong against the PRD — so pinning today's behaviour would lock in the defects. This change fixes the three contracts and writes the tests that hold them.

## Starting Point

`generateRecommendation` (373 lines) makes one Claude Haiku structured-output call, retries up to three times on content failures, and on the last attempt salvages whatever individually clears the guardrails. The guardrail *rule* is sound and already covered by `recommendation-guardrail.test.ts`. The *seam* around it is not: the salvage path, the retry loop, and every error branch are unexercised, and the commit that introduced the salvage (`d4cad20`) touched no test file — reverting it today leaves `npm test` green.

## Desired End State

A runner who gets fewer than three options **sees that they did**, in the same amber banner that already reports stale data — and a single plausible workout is offered rather than discarded. An AI failure returns a stable reason code instead of five different failures wearing the same 502. The request cannot silently run for minutes. Each of these is held by a hermetic test that fails if it regresses.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| How many alternatives is the contract | Degradation stays, but must be visible | Shipping two while every document promises three, and saying nothing, is the condition that made the risk untestable | Research |
| Degradation marker reach | Result field **and** banner render | The existing `recoveryMissing`/`stale` banner makes this a ~5-line change that actually reaches the runner | Plan |
| Client isolation | Real injection seam (optional deps parameter) | Mirrors the session-store seam this repo accepted last change; lets failure cases cost milliseconds instead of the SDK's retry budget | Plan |
| Failure classes | Typed `reason` code on `LlmError`, surfaced in the 502 | Lets tests assert a code instead of a message substring — the anti-pattern §2 names for risk #8 | Plan |
| Unknown fields in the response | Keep stripping; pin it with a test | A `.strict()` schema would 502 the runner when the model adds a field, an outage triggered by a change we do not control | Plan |
| Truncated response | Own failure class | A `max_tokens` cut-off is currently reported as invalid JSON, sending debugging the wrong way | Research |
| Single surviving option | Ship it, flagged (floor 1, was 2) | PRD l. 39 forbids shipping an implausible load, not withholding a plausible one | Plan |
| Overall deadline | Wall-clock budget checked before each retry | Turns an effectively unbounded loop into a bound a test can assert behaviourally | Plan |
| Presentation assertions | Out of scope | `jsdom` is not installed and §3 assigns the presentation layer to Phase 3 | Research |

## Scope

**In scope:** the injection seam and a shared hermetic test environment; `RecommendationResult.degraded` through to the banner; `MIN_ALTERNATIVES` 2 → 1; typed failure reasons surfaced by the route; truncation as its own class; a wall-clock budget; a selective Stryker run; PRD and cookbook updates.

**Out of scope:** rendered-React assertions; `.strict()` on the response schema; any change to guardrail threshold constants (all ungrounded — no test may pin them); the activity-limit coupling pin; scrubbing provider error text (risk #8); endpoint input-validation tests (Phase 2); e2e, UI snapshots, LLM-as-judge (§7).

## Architecture / Approach

One seam, three contract fixes, each driven red-first through it.

```
generateRecommendation(supabase, userId, modifiers, deps?)
                                              │
              ┌───────────────────────────────┴──────────────┐
              │ deps.client  (Pick<Anthropic,"messages">)     │  ← Phase 1
              │ deps.now     (() => number)                   │  ← Phase 4
              └──────────────────────────────────────────────┘
   test env: table-aware fake Supabase + stubbed sidecar fetch + queued model stub

   result ──► route (pass-through) ──► useRecommendation (cast, not parse) ──► amber banner
```

Nothing persists a result-level flag, so `degraded` touches no migration and no JSONB column.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Client injection seam | Optional deps parameter, shared test env, happy-path test | The fake Supabase must branch on table name — the existing one does not, and gets it wrong as a "not ready" error |
| 2. Degradation made visible | `degraded` field, floor at 1, banner render | The banner is a single-slot ternary today; it must stack once a third flag exists |
| 3. Failure taxonomy | Reason codes, truncation branch, route surfacing | The truncation check must precede `JSON.parse` or it never fires |
| 4. Wall-clock budget | Budget guard + injected clock | The guard must sit at the top of the loop, and the test must assert attempt count, not milliseconds |
| 5. Stryker selective gate | Mutation run on two modules, triaged | Chasing the score by pinning ungrounded constants would undo the plan's own rule |
| 6. Docs, prompt and cookbook | PRD amendment, §6.1 cookbook, §3 status | §6.1 is what Phases 2–4 copy; a vague one forfeits the rollout's compounding value |

**Prerequisites:** none — no Docker, no local Supabase, no new runtime config. `src/test/astro-env-stub.ts` already makes the module importable under Vitest.
**Estimated effort:** ~3–4 sessions. Phases 2–4 are independent of each other and can be reordered or split across sessions; all depend only on Phase 1.

## Open Risks & Assumptions

- Phases 2, 3 and 4 each change production behaviour inside a phase framed as testing. That was a deliberate call — the alternative was writing mirror tests against known-wrong contracts — but it means this change is larger than "Phase 1 adds tests" implies.
- Silent positional re-ranking is knowingly left unresolved: when the model's best-fit option is the one rejected, its second choice is relabelled `primary` with no trace. No source specifies the ranking semantics; the degradation marker only partly mitigates it.
- Risk #8 (provider error text echoed verbatim into the response body) stays assigned to no rollout phase after this change.
- `TOTAL_BUDGET_MS` is one more ungrounded constant in a module already full of them. The test asserts the *behaviour* (no further attempt opened), never the value — but the value itself will want tuning against real latency.

## Success Criteria (Summary)

- A runner offered fewer than three options is told so, and one plausible workout is never withheld for being alone.
- Every AI failure class returns its own stable reason code, and a truncated response says truncated.
- Reverting `MIN_ALTERNATIVES`, the salvage filter, or the truncation branch turns `npm test` red — which is the whole point of the phase.
