---
date: 2026-09-11T22:09:16+02:00
researcher: kzacha
git_commit: 90551fe68ced259539f1edc52c810b56423fa597
branch: garmin-credential-control
repository: gain-pace
topic: "Ground rollout Phase 1 of test-plan.md — AI response contract (risks #1, #2, #7)"
tags: [research, codebase, recommendations, guardrail, llm-contract, test-rollout]
status: complete
last_updated: 2026-09-11
last_updated_by: kzacha
---

# Research: Rollout Phase 1 — AI response contract

**Date**: 2026-09-11T22:09:16+02:00
**Researcher**: kzacha
**Git Commit**: `90551fe68ced259539f1edc52c810b56423fa597`
**Branch**: `garmin-credential-control`
**Repository**: gain-pace

## Research Question

Ground rollout Phase 1 of `context/foundation/test-plan.md`: risks #1 (prompt/schema change breaks parsing), #2 (implausible option reaches the runner, or one bad option dead-ends the request), #7 (AI error/timeout ends in an endless spinner or silent blank).

For each risk: find the real failure path in code, verify or correct the response guidance, locate existing tests, identify the cheapest useful test layer, and flag speculative risks or misleading hot-spot evidence.

**Scope boundary decided before research:** assertions stop at the service / API-endpoint layer. React islands are out of scope (Vitest is `environment: "node"`, `include: ["src/**/*.test.ts"]`; `jsdom` is not installed).

## Summary

All three risks survive research, but **two of the three were worded wrongly in §2** and one blocking contract conflict must be resolved by a human before any assertion about the degraded path can be written.

The decisive finding: **the shipped code contradicts every documented source about how many alternatives a runner receives.**

- PRD says three, in four separate places (`prd.md:33`, `:47`, `:79` FR-005, `:85` FR-007, `:95` Business Logic).
- The archived plan that built this loop says a persistent violation must fail hard — *"a violation triggers one re-prompt, and a persistent violation returns `{ status: "llm_error" }` (no fabricated workout)"* (`context/archive/2026-07-14-modifier-to-recommendation-loop/plan.md:99`).
- The live system prompt still instructs *"Return exactly 3 workout alternatives"* (`recommendations.ts:125`).
- The code ships **two** alternatives when one fails the guardrail, marks them `primary`/`alt_1`, and tells the client nothing (`recommendations.ts:332-340`).

Commit `d4cad20` introduced that reversal with **no test, no plan, no research document, and no PRD amendment**. Until a human decides which contract is real, a test for the degraded path has no oracle: asserting "two is fine" mirrors the code, asserting "must be three" fails against deliberate behaviour.

Second finding of equal practical weight: **the entire `recommendations.ts` module has zero tests.** The retry loop, the salvage path, the timeout branch, the refusal branch, and every HTTP status mapping are unexercised. The commit that fixed the dead-end bug shipped without a regression test, so reverting it would leave the suite green.

Third: **`context/foundation/test-plan.md` §7 contains a factual error** — it claims no rate limiting exists. A soft daily cap is implemented and enforced.

## Oracle verification

The four PRD lines were registered in `change.md` **before** any implementation was read, precisely so this table could be built without contamination.

| Oracle (source, not code) | Honoured by the implementation? | Evidence |
|---|---|---|
| PRD `:39` — "AI must not recommend unsafe workloads… Hallucinated loads are a hard regression" | **Yes, by construction** | Guardrail is check-then-filter; an out-of-band alternative is structurally excluded from the shipped set on both the fast path (`recommendations.ts:308`) and the salvage path (`recommendations.ts:332-336`) |
| PRD `:53` — "implausible given the runner's last 3–4 logged activities" | **Yes in effect**, but for an accidental reason | The Worker requests `?limit=4` (`garmin.ts:279`) and the sidecar defaults to 4 (`sidecar/src/routes/data.ts:111`), so the guardrail's unbounded read of `dashboard.activities` currently sees the same ≤4 items as the prompt's `slice(0, 4)`. See "Defused" below. |
| PRD `:51` — each option carries at minimum workout type, duration, and a one-sentence explanation | **Yes** | `workout_type`, `duration_minutes`, `ai_explanation` are all required and non-empty in the Zod schema (`recommendation-guardrail.ts:126`, `:153`) |
| PRD `:33`/`:47`/`:79`/`:85`/`:95` — the runner receives **three** alternatives | **NO — violated in the degraded path** | `MIN_ALTERNATIVES = 2` (`recommendations.ts:45`); two survivors ship as a normal success (`recommendations.ts:332-340`) |
| PRD `:90` — visible within 10 s p95; over 2 s must show continuous visible progress; "never wait in silence" | **NO — violated** | Worst case for a pure transport failure ≈ 61.5 s; worst case with app-level retries ≈ 184.5 s, plus up to ~40 s of Garmin prerequisite. The endpoint is a single POST with no progress channel. |

Two oracle violations, both real, neither covered by a test.

## Detailed Findings

### Risk #1 — response contract and parsing

**The contract lives in four layers**, which is itself the reason a prompt/schema change is dangerous:

1. **JSON Schema** sent to the model — `RECOMMENDATION_JSON_SCHEMA` (`recommendation-guardrail.ts:40-83`), `additionalProperties: false` at both object levels. A code comment states its limits explicitly (`recommendation-guardrail.ts:37-39`): *"Structured outputs do NOT support array length, enum, or numeric range constraints, so 'exactly 3', the effort enum, the pace format, and all range checks live in the Zod parse + guardrail."*
2. **Zod schema** — `recommendationResponseSchema` (`recommendation-guardrail.ts:120-154`), including the `.length(3)` constraint (`:153`).
3. **Prompt prose** — `SYSTEM_PROMPT` (`recommendations.ts:122-135`).
4. **Plausibility guardrails** — `validateAlternatives`, `validateWorkoutStructure`.

A change to any one layer can silently desynchronise the others. That is the mechanism behind risk #1, and it is more specific than §2's wording.

**Observable outcome per mismatch** (`recommendations.ts:258-341`):

| Mismatch | Outcome |
|---|---|
| Not valid JSON | caught, `lastViolations` set, `continue` → retry; after final attempt `LlmError` → 502 |
| Truncated JSON (`stop_reason === "max_tokens"`) | **indistinguishable from garbage** — `stop_reason` is only checked for `"refusal"` (`recommendations.ts:283-285`); truncation falls into the same generic branch |
| Markdown fences / prose around JSON | no fence-stripping code exists anywhere; `JSON.parse` throws → same branch |
| Required field missing / wrong type | Zod `safeParse` fails → whole attempt rejected → retry → 502 |
| Wrong number of alternatives | `.length(3)` fails at the top level → **never reaches the salvage path** |
| **Extra / unexpected fields** | **silently stripped** — `recommendationResponseSchema` is a bare `z.object()` with no `.strict()`; no error, no log, no signal |
| `training_arc_note` / `recovery_warning` missing or blank | never fails — `.nullish().transform(...)` collapses to `null` (`recommendation-guardrail.ts:130-146`), documented as intentional |

**Correction to §2 response guidance for #1.** The guidance said the protection to prove is that a contract-violating response *"ends in an explicit error, not a half-parsed card handed to the runner as complete."* Research shows a half-parsed card **cannot** reach the runner via a shape failure — shape failures are all-or-nothing and end in `LlmError`. The reachable failure modes are different and narrower:

- **silent field stripping** — a renamed or added field passes validation and disappears without trace, so contract drift is invisible;
- **whole-request failure** — shape drift burns all three attempts and surfaces a 502 carrying raw violation text, and no test covers that path;
- **truncation masquerading as garbage** — a `max_tokens` cut-off is diagnosed as "the output was not valid JSON", which sends debugging in the wrong direction.

### Risk #2 — guardrail seam and the degradation contract

**The guardrail itself is sound and already protected.** `validateAlternatives` filters per-alternative, so "an implausible option reaches the runner" is closed by construction. Two existing tests cover the rule and the parse, and both would fail correctly if the logic were broken (`recommendation-guardrail.test.ts:55-60`, `:105-108`).

**The open risk is the salvage seam, not the rule.** `git show d4cad20` — single file changed, `src/lib/services/recommendations.ts`, +83/−33, **no test file touched**. It introduced `MAX_ATTEMPTS = 3`, `MIN_ALTERNATIVES = 2`, and the survivor filter. Consequences:

- **Exactly one option fails** → two survivors ship as `{status:"ok"}`, re-ranked `primary`/`alt_1`. No response field indicates degradation; `degradedCount` goes only to the server log (`recommendations.ts:353`). `RecommendationResult` (`types.ts:69-84`) has no such field.
- **Two options fail** → one survivor exists and is **discarded entirely**; the request 502s. A perfectly valid alternative is thrown away because it is alone.
- **Silent re-ranking** — survivors are relabelled positionally (`RANKS[i]`, `recommendations.ts:338`). If the alternative the model ranked best is the one that fails validation, the runner sees the model's second choice labelled "Recommended", with no indication. Nothing in PRD or any plan addresses whether that is intended.
- **The fix has no regression test.** Reverting `MAX_ATTEMPTS` or `MIN_ALTERNATIVES` would leave `npm test` green.

**Correction to §2 wording for #2.** Both halves of the risk as written are mis-aimed. "An implausible option reaches the runner" is closed by construction. "One bad option dead-ends the whole request" was fixed by `d4cad20`. The genuinely open, testable risk is: **the degradation contract is undocumented, invisible to the client, contradicts the PRD, and is pinned by nothing — so it can be reverted or re-tuned silently.**

### Risk #7 — error and timeout behaviour

**Timeouts and retries compound across two independent layers.**

- SDK layer: `new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 2 })` (`recommendations.ts:239`), `TIMEOUT_MS = 20_000` (`:36`). The SDK applies the timeout **per HTTP attempt**, not per logical call, and retries on timeout, network error, 408/409/429 and ≥500.
- App layer: `MAX_ATTEMPTS = 3` (`:44`). Crucially, the app loop is re-entered **only** on malformed JSON, schema mismatch, or guardrail violation. A thrown transport error exits immediately.

Worst cases, computed from the constants:

| Scenario | Bound |
|---|---|
| Pure transport failure / timeout | 3 × 20 s + ~1.5 s backoff ≈ **61.5 s** |
| Repeated late-but-invalid responses | 3 app attempts × ~61.5 s ≈ **184.5 s** |
| Plus Garmin prerequisite stage | up to ~40 s more → outer bound **~3.5–4 min** |

Against PRD `:90` (10 s p95, visible progress above 2 s, "never wait in silence") this is a categorical miss. Nothing is literally infinite — every network stage is individually time-boxed — but **there is no top-level deadline for the request as a whole.**

**New finding not in §2 — provider error text is echoed to the client.** The generic catch interpolates `err.message` verbatim (`recommendations.ts:277`), and the route puts it straight into the response body (`index.ts:60`). The SDK builds `APIError.message` from the provider's raw error JSON, `JSON.stringify`-ing it when it is not a plain string. So an unexpected upstream error payload reaches the client unfiltered. No API key is exposed — keys do not appear in provider error bodies — but this is uncontrolled outbound information from an upstream service, and belongs on the abuse lens.

**HTTP status map** (`src/pages/api/recommendations/index.ts`), none of it tested:

| Condition | Status | Body |
|---|---|---|
| unauthenticated | 401 | `{status:"unauthorized"}` |
| Supabase unconfigured | 503 | `{status:"not_configured"}` |
| body fails Zod | 400 | `{status:"bad_request", ...}` |
| prerequisite missing (no Garmin / no goal) | **200** | `{status:"not_ready", reason}` — deliberate, comment says "gate, don't 500" |
| daily cap reached | 429 | `{status:"rate_limited"}` |
| `ANTHROPIC_API_KEY` missing | 503 | `{status:"not_configured"}` |
| any `LlmError` (timeout, refusal, parse exhaustion, guardrail exhaustion) | 502 | `{status:"llm_error", message}` |
| unmapped error | rethrown | framework default |

Two paths return a non-recommendation as HTTP 200: `not_ready` (by design) and the silently degraded two-alternative result (by accident of contract).

### Test harness — what is possible without touching configuration

- `vitest.config.ts`: `environment: "node"`, `include: ["src/**/*.test.ts"]`, `@` → `./src`, and `astro:env/server` aliased to `src/test/astro-env-stub.ts`.
- The stub supplies `ANTHROPIC_API_KEY = "test-anthropic-key"` (`src/test/astro-env-stub.ts:15`), so **`recommendations.ts` imports cleanly under Vitest today.** No config change is needed for Phase 1.
- `jsdom` and `happy-dom` are **not installed** — confirmed absent from `package.json`. React islands are genuinely out of reach without a new devDependency, which validates the scope decision taken before research.
- Repo idiom for isolating network: global `fetch` replacement — `const fetchMock = vi.fn<typeof fetch>()` then `vi.stubGlobal("fetch", fetchMock)` (`garmin.test.ts:59`, `:96-99`), with a small `reply()` helper (`:61-67`).
- **No injection seam exists for the Anthropic client** — it is constructed inside `generateRecommendation` (`recommendations.ts:239`) with `maxRetries: 2` hard-coded. A test that stubs `fetch` to fail therefore pays the SDK's own retry and backoff (~1.5 s per case). This is a real design decision for `/10x-plan`; see Open Questions.
- **The existing test contains an implementation mirror.** `recommendation-guardrail.test.ts:34-41` imports `ABS_MIN_MINUTES` / `ABS_MAX_MINUTES` from the module under test and asserts against them; changing those constants in the source would leave the assertions passing. The adjacent test at `:28-32` is the correct pattern — independent literals (`12`, `100`) with a comment showing the derivation. §6.1 of the test plan must point at `:28-32` as the reference and name `:34-41` as the anti-pattern.

### Defused — a flagged concern that is not a live defect

A sub-agent reported that the guardrail reads the **full** `dashboard.activities` array while the prompt uses `slice(0, 4)`, and flagged this against PRD `:53` ("last 3–4 logged activities"). Verified and **defused**: the Worker requests `?limit=4` (`garmin.ts:279`) and the sidecar defaults to 4, clamping at 20 (`sidecar/src/routes/data.ts:111`). Both paths see the same ≤4 activities, so no divergence is reachable today.

It remains a **latent coupling**, not a current bug: raising the fetch limit would silently widen the guardrail's band beyond what the PRD specifies, with no test to notice. Worth one cheap pin, but it is not a Phase 1 obligation and must not be written as though the defect exists now.

## Code References

- `src/lib/services/recommendations.ts:35` — `MODEL = "claude-haiku-4-5"`
- `src/lib/services/recommendations.ts:36,44,45` — `TIMEOUT_MS = 20_000`, `MAX_ATTEMPTS = 3`, `MIN_ALTERNATIVES = 2`
- `src/lib/services/recommendations.ts:38` — `DAILY_CAP = 10`
- `src/lib/services/recommendations.ts:122-135` — `SYSTEM_PROMPT`, incl. "Return exactly 3 workout alternatives"
- `src/lib/services/recommendations.ts:239` — Anthropic client construction (no injection seam)
- `src/lib/services/recommendations.ts:258-341` — the retry / parse / guardrail / salvage loop
- `src/lib/services/recommendations.ts:273-278` — the only error catch; `APIConnectionTimeoutError` special-cased
- `src/lib/services/recommendations.ts:283-285` — refusal branch, throws without retry
- `src/lib/services/recommendations.ts:332-340` — the survivor salvage (the contract conflict)
- `src/lib/services/recommendations.ts:344-358` — the only structured log; `degradedCount` lives here and nowhere else
- `src/lib/recommendation-guardrail.ts:40-83` — `RECOMMENDATION_JSON_SCHEMA`
- `src/lib/recommendation-guardrail.ts:120-154` — Zod schema; `.length(3)` at `:153`
- `src/lib/recommendation-guardrail.ts:130-146` — lenient nullish transforms for the two note fields
- `src/lib/recommendation-guardrail.ts:172-176` — `ABS_MIN_MINUTES`, `ABS_MAX_MINUTES`, `MIN_FACTOR`, `MAX_FACTOR`
- `src/lib/recommendation-guardrail.ts:184-201,213-232` — duration band derivation and application
- `src/pages/api/recommendations/index.ts:32-64` — the full status map
- `src/pages/api/recommendations/index.ts:60` — provider error text echoed into the response body
- `src/lib/services/garmin.ts:279` — `?limit=4`
- `src/test/astro-env-stub.ts:15` — `ANTHROPIC_API_KEY` stub that makes the module importable
- `src/lib/services/garmin.test.ts:59,61-67,96-99` — the repo's fetch-stubbing idiom
- `src/lib/recommendation-guardrail.test.ts:28-32` — the correct assertion pattern
- `src/lib/recommendation-guardrail.test.ts:34-41` — the implementation mirror
- `supabase/migrations/20260714000001_create_recommendation_usage.sql` — the rate-limit table §7 claims does not exist

## Architecture Insights

- **The contract is distributed across four layers with no single source of truth.** Structured output cannot express "exactly 3", an enum, or a numeric range, so those constraints were pushed into Zod and hand-rolled guardrails. That split is deliberate and documented, but it means a schema edit and a Zod edit can drift apart with nothing to detect it.
- **Two distinct retry philosophies coexist.** Transport errors fail fast; content errors retry. That is defensible, but the two layers' retry budgets multiply, and nobody appears to have computed the product until now.
- **Observability was chosen over contract.** `degradedCount`, attempt counts, and violations all exist — in `console.log`, readable via `wrangler tail`. The client-facing type carries none of it. The team consistently preferred server-side visibility to response-shape richness; whether that is right for degradation specifically is the open question below.
- **Every threshold governing "plausible" is ungrounded.** `MIN_FACTOR`, `MAX_FACTOR`, the absolute caps, the pace multipliers, the tolerances, `MIN_ALTERNATIVES`, `MAX_ATTEMPTS`, `DAILY_CAP`, `LOW_BODY_BATTERY` — none is derived from a cited source; several carry in-code comments admitting they are provisional ("Tune during manual verification"). **Tests must not pin these numbers**, or the suite becomes a lock on arbitrary constants. Assert against the PRD's own worked example instead — `:39`'s "30 km sprint for a 5 km/week runner" is a concrete, source-backed implausibility that survives any threshold retuning.

## Historical Context (from prior changes)

- `context/archive/2026-07-14-modifier-to-recommendation-loop/plan.md:43,99` — the original contract: one re-prompt, then a typed failure. Explicitly rejects fallback: *"a double-violation is a failure, not a fabrication… supersedes 'fall back to a safe default'."* Commit `d4cad20` reversed this without recording the reversal anywhere.
- `context/changes/workout-step-detail/plan.md:54-65` — reproduces `EFFORT_PACE_MULTIPLIERS` verbatim and labels it *"Starting point (tune during manual verification)"*, confirming the constants were never externally derived.
- `context/changes/workout-step-detail/reviews/impl-review.md:64` — independently records that the pace-guardrail helpers have zero tests, matching that plan's explicit "No new unit tests" decision.
- `context/archive/2026-07-21-recovery-conflict-warning/change.md:20` — says the body-battery threshold should "start 30"; the shipped constant is `20`. A small but telling instance of doc/code drift in the same module family.

## Related Research

None. This is the first research artifact under `context/changes/testing-ai-response-contract/`. No prior `research.md` exists for the recommendation loop — the archived S-03 slice went straight from plan to implementation.

## Corrections owed to `context/foundation/test-plan.md`

Findings that contradict the plan as written. All are §2/§7 edits; none introduces a file anchor into the plan.

1. **§7 is factually wrong about rate limiting.** It states no safeguard exists. `DAILY_CAP = 10` is enforced with a dedicated table and a 429 path. The exclusion must be removed; the 429 path is cheap to test and sits naturally in Phase 2 (API endpoint contract).
2. **Risk #2 wording** — both halves are mis-aimed (closed by construction / already fixed). Reword to the degradation-contract regression.
3. **Risk #1 response guidance** — "a half-parsed card handed to the runner" is unreachable for shape failures. Reword to silent field stripping, whole-request failure, and truncation misdiagnosis.
4. **Risk #7 scope** — larger than "endless spinner". Bounded but enormous worst case (61.5 s to ~4 min), no top-level deadline, and the PRD's "never wait in silence" is structurally unmet by a single POST with no progress channel.
5. **New abuse-lens candidate** — provider error payload echoed verbatim into the response body. Uncontrolled outbound information from an upstream service.
6. **§6.1 reference test** — must name `recommendation-guardrail.test.ts:28-32` as the pattern and `:34-41` as the mirror to avoid.

## Open Questions

**RESOLVED 2026-09-11 — the contract decision.**

1. ~~**How many alternatives is the contract?**~~ **Decided: degradation stays, but it must be visible.**
   The salvage path is kept — a runner must not lose their whole session because one option missed the band. But shipping two alternatives while every document promises three, and saying nothing, is not acceptable. Consequences:
   - `RecommendationResult` gains a field signalling that the set was degraded. `degradedCount` already exists in the service (`recommendations.ts:353`) and currently dies in the log; it needs to reach the client.
   - PRD `:33`/`:47`/`:79`/`:85`/`:95` and `SYSTEM_PROMPT` (`recommendations.ts:125`) must be amended to describe "three, or a flagged smaller set" rather than an unqualified three.
   - **The oracle for the degraded path is now settled**, so the assertion can be written: a set with a rejected option ships the survivors *and* carries the degradation marker.
   - This is a small product change riding inside a testing phase. `/10x-plan` decides whether it becomes a sub-phase of Phase 1 (recommended — it is a clean red-test-first candidate: *"when one option is rejected, the response carries a degradation marker"*) or a separate roadmap slice with the assertion deferred.

**Still open — not blocking Phase 1, but unresolved by any source.**

2. **Should the single-survivor case really discard a valid workout?** Today one plausible alternative is thrown away and the runner gets a 502 rather than the one workout that passed. No source states this is intended. Left as-is for now; the decision above does not settle it.
3. **Is silent re-ranking acceptable?** When the model's best-fit option fails validation, its second choice is relabelled `primary` with no trace. Arguably the degradation marker from decision 1 partly mitigates this, but the ranking semantics themselves remain unspecified.

**Non-blocking — for `/10x-plan` to settle.**

4. **How to isolate the Anthropic client.** No injection seam exists. Either `vi.mock("@anthropic-ai/sdk")` (fast, but mocks a third-party module boundary) or the repo's existing global-`fetch` idiom (consistent with `garmin.test.ts`, but pays ~1.5 s of SDK retry per failure case). Consistency argues for `fetch`; suite speed argues for `vi.mock`.
5. **Should the latent activity-limit coupling be pinned now** (one cheap test that the guardrail's band is derived from no more than the last four activities), or left to `--refresh` since no divergence is currently reachable?
