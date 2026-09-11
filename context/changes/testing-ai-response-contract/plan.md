# Test Rollout Phase 1 — AI Response Contract: Implementation Plan

## Overview

Rollout Phase 1 of `context/foundation/test-plan.md` §3 covers risks #1 (contract layers desynchronise), #2 (the degradation contract changes silently) and #7 (failure and timeout behaviour is untested and unbounded).

Research (`research.md`, 2026-09-11) established that `src/lib/services/recommendations.ts` has **zero tests** and that three of its contracts are not merely untested but wrong against their sources: a reduced set of alternatives ships with nothing telling the runner, five distinct failure classes collapse into one opaque 502, and no deadline wraps the request. Writing tests that pin today's behaviour would therefore lock in the defects.

This plan does both halves: it fixes the three contracts against their PRD oracle, and it writes the tests that hold them — each contract test written red-first.

## Current State Analysis

**The module under test.** `generateRecommendation` (`src/lib/services/recommendations.ts:214-373`) gates prerequisites, enforces a soft daily cap, then runs a bounded loop (`:258-341`): up to `MAX_ATTEMPTS = 3` model calls, retrying on content failures, and on the final attempt salvaging alternatives that individually clear both guardrails.

**What already works and needs no change.** The guardrail rule itself is sound and covered — `validateAlternatives` filters per alternative, so an implausible option is structurally excluded from the shipped set on both paths (`:308`, `:332-336`). `src/lib/recommendation-guardrail.test.ts` exercises it and would fail correctly if broken.

**The three gaps.**

1. **Degradation is invisible.** `degradedCount` is computed at `:339` and dies in a `console.log` at `:353`. `RecommendationResult` (`src/types.ts:69-84`) has no field for it. Meanwhile `MIN_ALTERNATIVES = 2` (`:45`) means a lone surviving valid workout is discarded and the request 502s.
2. **Failure classes are indistinguishable.** Timeout, transport error, refusal, shape exhaustion and guardrail exhaustion all become `LlmError` → 502 with free text (`:274-277`, `:284`, `:361`; route at `src/pages/api/recommendations/index.ts:59-61`). A truncated response (`stop_reason === "max_tokens"`) is diagnosed as "the output was not valid JSON" because `stop_reason` is only checked for `"refusal"` (`:283`).
3. **No overall deadline.** The SDK applies `TIMEOUT_MS = 20_000` per HTTP attempt with `maxRetries: 2` (`:239`); the app loop adds up to 3 attempts on top. Research computed ~61.5 s for a pure transport failure and ~184.5 s with app-level retries, against PRD l. 90's 10 s p95.

**Test harness.** No configuration change is needed. `vitest.config.ts` is `environment: "node"`, `include: ["src/**/*.test.ts"]`, and `src/test/astro-env-stub.ts:15` supplies `ANTHROPIC_API_KEY`, so the service imports cleanly today. `jsdom` is not installed, which is why presentation assertions stay out of scope.

**No seam.** The Anthropic client is constructed inside the function (`:239`) with `maxRetries: 2` hard-coded, so a `fetch`-level failure stub would pay the SDK's retry budget on every failure case.

## Desired End State

`generateRecommendation` accepts injected dependencies, and `src/lib/services/recommendations.test.ts` exercises its contract hermetically — no network, no database, no model call. Three behaviours that were wrong are right, and each is held by a test that fails if it regresses:

- A reduced set of alternatives ships **and says so**, all the way to the amber banner the runner is looking at. One surviving valid workout is offered, not discarded.
- Every failure class carries its own stable reason code in the 502 body; a truncated response reports truncation.
- The loop refuses to open a further attempt past a stated wall-clock budget.

Verify by: `npm test` green with the new file present; `npm run lint` and `npm run build` clean; and a manual pass in `npm run preview` showing the degraded banner on a real reduced set.

### Key Discoveries:

- The route passes the service result straight through (`src/pages/api/recommendations/index.ts:47-48`) and `src/components/hooks/useRecommendation.ts:65` is a **cast, not a parse** — a new field on `RecommendationResult` reaches the client with no plumbing.
- The "boolean flag → amber banner" pattern already exists in exactly one place: `src/components/recommendations/RecommendationResults.tsx:87-94`, gated on `result.stale || result.recoveryMissing` with a ternary choosing the copy at `:90`.
- **A single-card layout already works.** `RecommendationResults.tsx:111` guards the "If you prefer" section with `alternatives.length > 0`, so shipping one alternative needs no layout change.
- No top-level result flag is persisted — `useRecommendation.ts:99-103` sends only `{ alternative, context }` to the select endpoint, so a new field touches no migration and no JSONB column.
- No `.strict()` exists anywhere in `src`; `select.ts:15-44` strips unknown keys silently rather than rejecting them.
- The correct assertion pattern for this repo is `src/lib/recommendation-guardrail.test.ts:28-32` — independent literals with the derivation in a comment. `:34-41` in the same file is the implementation mirror this rollout exists to avoid.

## What We're NOT Doing

- **No assertions on rendered React output.** `jsdom` stays uninstalled; the banner render is verified manually. The presentation layer belongs to test-plan §3 Phase 3.
- **No `.strict()` on the response schema.** Unknown fields keep being stripped; a test documents that as deliberate leniency. Making a model-added field burn all three attempts is a production outage we do not control.
- **No change to guardrail thresholds.** `MIN_FACTOR`, `MAX_FACTOR`, the pace multipliers, `LOW_BODY_BATTERY`, `DAILY_CAP` are untouched, and **no test asserts their values** — research showed every one of them is ungrounded.
- **No pin of the latent activity-limit coupling** (research open question 5). No divergence is reachable today; deferred to `--refresh`.
- **No scrubbing of provider error text** (risk #8). It stays unassigned in §3 and is not this phase's job.
- **No API-endpoint input-validation tests** — that is §3 Phase 2, including the 429 daily-cap path.
- **No e2e, no UI snapshots, no LLM-as-judge** — §7 negative space.

## Implementation Approach

Establish the seam first as a behaviour-free refactor, then drive each contract fix red-first through the seam. The three contract phases are independent of one another and all depend only on Phase 1, so a failure in any one of them does not block the others.

Tests assert against the **PRD oracle**, never against the implementation:

- Implausible load uses PRD l. 39's own worked example — a ~180-minute option for a runner whose recent sessions are ~40 minutes — so the assertion survives any retuning of the band multipliers.
- Degradation asserts "the survivors ship *and* the marker is present", which comes from the contract decision recorded in `research.md`, not from reading `:339`.
- The deadline asserts "no further attempt was opened", not an elapsed-time measurement and not the budget constant.

## Critical Implementation Details

**The fake Supabase must be table-aware.** `generateRecommendation` reaches the database through three different tables before it ever calls the model: `garmin_credentials` (via `getDashboardData`), `race_goals` (via `getActiveRaceGoal`) and `recommendation_usage` (the daily cap). The existing fake at `src/lib/services/garmin.test.ts:19-36` returns one canned row from `from()` regardless of table and will not serve this. The shared helper introduced in Phase 1 must branch on the table name, and must also stub global `fetch` for the sidecar call inside `getDashboardData`. Getting this wrong surfaces as a `RecommendationNotReadyError` instead of the behaviour under test.

**Ordering inside the loop.** The truncation check (Phase 3) must sit **after** the refusal check and **before** `JSON.parse` (`:287-293`); placed after the parse it never fires, because a truncated body throws first and is swallowed by the existing `catch`. The budget check (Phase 4) must sit at the **top** of the loop body guarding attempts 2 and 3 — placed at the end it cannot prevent the attempt that overruns.

## Phase 1: Client injection seam

### Overview

Give `generateRecommendation` an injection point for the model client, and build the shared test environment every later phase uses. No behaviour changes; the existing suite must stay green and production call sites must stay untouched.

### Changes Required:

#### 1. Dependency parameter on the service

**File**: `src/lib/services/recommendations.ts`

**Intent**: Let a test supply the model client instead of having one constructed inline at `:239`, so failure cases cost milliseconds rather than the SDK's retry budget, and so no third-party module is mocked.

**Contract**: `generateRecommendation` gains an optional fourth parameter of a new exported type `RecommendationDeps`, with one member for now: `client?: AnthropicClient`. Define `AnthropicClient` as the structural slice actually used — `Pick<Anthropic, "messages">` — so the real SDK client satisfies it without a cast and a stub needs only `messages.create`. When the member is absent the function constructs today's client with today's options, unchanged. The route at `src/pages/api/recommendations/index.ts:47` is not modified.

#### 2. Shared hermetic test environment

**File**: `src/test/recommendation-env.ts`

**Intent**: One helper that assembles everything `generateRecommendation` needs before it reaches the model — a table-aware fake Supabase, a stubbed sidecar `fetch`, an active race goal, and a runner whose recent runs are ~40 minutes — so each test file states only what it is actually testing.

**Contract**: Exports a factory returning the fake typed Supabase client plus recorded writes (following the `FakeDb` shape at `src/lib/services/garmin.test.ts:19-36`, extended to branch on table name), and a queued-response Anthropic stub whose `messages.create` returns or throws the next queued item and records its call count. Fixture activity durations are stated as independent literals with the median noted in a comment, matching `src/lib/recommendation-guardrail.test.ts:25`.

#### 3. First contract test — the happy path

**File**: `src/lib/services/recommendations.test.ts`

**Intent**: Prove the seam works end to end and pin the baseline contract: a well-formed, in-band model response yields three alternatives in rank order.

**Contract**: Asserts `alternatives` has length 3 with ranks `primary`, `alt_1`, `alt_2` in that order, and that the model-supplied `summary` and `steps` survive onto the DTO. Rank values are written as literals, not imported from `RANKS`.

### Success Criteria:

#### Automated Verification:

- Existing suite still passes: `npm test`
- The new test file runs and passes: `npm test`
- Lint and type-checked rules pass: `npm run lint`
- Production build compiles: `npm run build`

#### Manual Verification:

- `npm run preview` — requesting a recommendation still returns three options, confirming the default (no-deps) path is unchanged

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human before proceeding.

---

## Phase 2: Degradation made visible

### Overview

Carry the reduction the service already computes all the way to the runner, and stop discarding a lone valid workout. This is the contract decision recorded in `research.md` — degradation stays, but it must be visible.

### Changes Required:

#### 1. The result carries the reduction

**File**: `src/types.ts`

**Intent**: Give the client a way to tell a reduced set from a full one, which it currently cannot do at all.

**Contract**: `RecommendationResult` gains `degraded: number | null` — the number of alternatives shipped when fewer than three cleared the guardrails, and `null` on the clean path. Documented alongside `stale` and `recoveryMissing` as the third result-level flag.

#### 2. Service populates it and ships a lone survivor

**File**: `src/lib/services/recommendations.ts`

**Intent**: Stop throwing away a plausible workout because it is alone — PRD l. 39 forbids shipping an implausible load, not withholding a plausible one — and surface the count that already exists.

**Contract**: `MIN_ALTERNATIVES` becomes `1`; `degradedCount` is returned on the result as `degraded` rather than only logged at `:353`. The `console.log` keeps its existing `degraded` key unchanged. The comment block at `:40-43` is updated so it no longer describes a two-alternative floor.

#### 3. The banner shows it

**File**: `src/components/recommendations/RecommendationResults.tsx`

**Intent**: Put the marker where the runner is actually looking, following the existing flag-to-banner pattern.

**Contract**: The amber notice block at `:87-94` renders a degradation line when `result.degraded != null`. Because degradation can co-occur with staleness, the block stacks its active notices rather than keeping the current single-slot ternary. Copy names how many options are being offered and why it is fewer than three. No layout change is needed for a single card — `:111` already guards the "If you prefer" section on `alternatives.length > 0`.

### Success Criteria:

#### Automated Verification:

- One alternative rejected → two ship with the marker set: `npm test`
- Two alternatives rejected → one ships with the marker set (the former dead-end): `npm test`
- All three valid → marker is `null`: `npm test`
- All three rejected → `LlmError`, nothing shipped: `npm test`
- Implausible options are absent from the shipped set, asserted against PRD l. 39's worked example: `npm test`
- Lint passes: `npm run lint`
- Build compiles: `npm run build`

#### Manual Verification:

- `npm run preview` — a reduced set renders the degraded banner above the cards, and a single-option result reads sensibly with no empty "If you prefer" section
- The banner stacks correctly when the Garmin snapshot is also stale

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 3: Failure taxonomy

### Overview

Make each failure class diagnosable by its own stable code rather than by prose, and stop truncation masquerading as garbage JSON.

### Changes Required:

#### 1. Typed reason on the error

**File**: `src/lib/services/recommendations.ts`

**Intent**: Give callers and tests something stable to branch on, so assertions key on a code instead of a message substring — the anti-pattern test-plan §2 names for risk #8.

**Contract**: `LlmError` gains a `reason` of `"timeout" | "transport" | "refusal" | "truncated" | "invalid_shape" | "implausible"`. Each existing throw site supplies its own: the `APIConnectionTimeoutError` branch (`:274`) is `timeout`, the generic catch (`:277`) is `transport`, the refusal branch (`:284`) is `refusal`, and the final throw (`:361`) reports whichever content failure ended the last attempt. Messages stay as they are — the code is added, not substituted.

#### 2. Truncation is its own class

**File**: `src/lib/services/recommendations.ts`

**Intent**: A `max_tokens` cut-off currently sends debugging in the wrong direction by reporting invalid JSON.

**Contract**: A branch on `message.stop_reason === "max_tokens"`, placed after the refusal check at `:283` and **before** `JSON.parse` at `:289`, records a truncation violation and continues the retry loop. Exhausting attempts this way surfaces `reason: "truncated"`.

#### 3. Route surfaces the code

**File**: `src/pages/api/recommendations/index.ts`

**Intent**: The reason must survive to the client, otherwise the taxonomy stops at the service boundary.

**Contract**: The `LlmError` branch at `:59-61` adds `reason` to the 502 body alongside the existing `status` and `message`. Status code and existing fields are unchanged.

#### 4. Pin the deliberate leniency

**File**: `src/lib/services/recommendations.test.ts`

**Intent**: Record that unknown fields are stripped by design, so a future reader does not mistake it for an oversight — and so a change to `.strict()` becomes a conscious decision that breaks a test.

**Contract**: A test asserting that an alternative carrying an unknown key still parses, and that the key is absent from the resulting DTO, with a comment naming this as intentional leniency toward model-side additions.

### Success Criteria:

#### Automated Verification:

- A timeout yields `reason: "timeout"`: `npm test`
- A transport error yields `reason: "transport"`: `npm test`
- A refusal yields `reason: "refusal"` without consuming further attempts: `npm test`
- A `max_tokens` response yields `reason: "truncated"`, not invalid-JSON: `npm test`
- Shape drift across every attempt yields `reason: "invalid_shape"`: `npm test`
- Persistent guardrail violation yields `reason: "implausible"`: `npm test`
- Unknown-field leniency pinned: `npm test`
- Lint passes: `npm run lint`
- Build compiles: `npm run build`

#### Manual Verification:

- With `ANTHROPIC_API_KEY` set to an invalid value in `.dev.vars`, `npm run preview` returns a 502 whose body carries a `reason`, and the UI still shows a readable error state

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 4: Wall-clock budget

### Overview

Wrap the whole generation in a stated bound, so the request cannot run to the ~184.5 s worst case research computed against PRD l. 90's 10 s p95.

### Changes Required:

#### 1. Clock seam

**File**: `src/lib/services/recommendations.ts`

**Intent**: Let a test advance time without waiting, using the parameter Phase 1 already introduced.

**Contract**: `RecommendationDeps` gains `now?: () => number`, defaulting to `Date.now`. The existing `started` timestamp at `:248` and the latency figure in the structured log read through it.

#### 2. Budget guard

**File**: `src/lib/services/recommendations.ts`

**Intent**: Refuse to open another model call once the elapsed budget is spent, rather than discovering it after a third 20-second attempt.

**Contract**: A new `TOTAL_BUDGET_MS` constant, checked at the **top** of the loop body for attempts after the first; when exceeded the loop stops and an `LlmError` with `reason: "timeout"` is thrown. The first attempt always runs — a budget that can reject before any call would turn a slow prerequisite into a silent no-op.

#### 3. Budget test

**File**: `src/lib/services/recommendations.test.ts`

**Intent**: Assert the bound behaviourally, without measuring elapsed time and without pinning the constant.

**Contract**: With an injected clock that jumps past the budget after the first response, assert the stub's `messages.create` was called exactly **once** and the thrown error carries `reason: "timeout"`. The assertion names the attempt count, never the millisecond value.

### Success Criteria:

#### Automated Verification:

- Past the budget the loop opens no further attempt and reports `reason: "timeout"`: `npm test`
- Within the budget the retry loop still uses all attempts as before: `npm test`
- Whole suite passes: `npm test`
- Lint passes: `npm run lint`
- Build compiles: `npm run build`

#### Manual Verification:

- `npm run preview` — a normal recommendation is unaffected and still completes well inside the budget

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 5: Stryker selective gate

### Overview

Prove the new tests would actually fail if the logic broke. Scoped narrowly to the two modules this phase touched, run once — never wired into CI.

### Changes Required:

#### 1. Narrow-scope mutation run

**File**: `package.json` (devDependency) and a Stryker config at the repo root

**Intent**: Coverage says a line ran; mutation score says a test would have caught it breaking. This is the only check that distinguishes the two.

**Contract**: Stryker installed as a devDependency and configured with `mutate` limited to `src/lib/services/recommendations.ts` and `src/lib/recommendation-guardrail.ts`, running the existing Vitest suite. No npm script is added to the CI path and no gate is added to `.github/workflows/ci.yml` — test-plan §5 marks this gate **selective**, not per-commit.

#### 2. Triage

**File**: `src/lib/services/recommendations.test.ts` (assertions added as warranted)

**Intent**: Kill the mutants that represent a real regression for a runner; consciously ignore the rest.

**Contract**: For each survived mutant, the question is whether the change would hurt a runner or the business. Yes → add an assertion. No → leave it and note why in the phase notes. **Do not** add assertions that pin the ungrounded constants listed in "What We're NOT Doing" — a test that pins a magic number to raise a score is itself a vibe test.

### Success Criteria:

#### Automated Verification:

- Mutation run completes against the two-module scope: `npx stryker run`
- Suite still green after any added assertions: `npm test`
- Lint passes: `npm run lint`

#### Manual Verification:

- The HTML report has been opened and every survived mutant has an explicit verdict — killed, or ignored with a stated reason
- No added assertion pins a guardrail threshold constant

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 6: Docs, prompt and cookbook

### Overview

Close the contradiction between the code and every document that describes it, and write down what the phase established so §3 Phases 2–4 can copy it.

### Changes Required:

#### 1. PRD amendment

**File**: `context/foundation/prd.md`

**Intent**: Five places promise the runner three alternatives unconditionally, which the salvage path has contradicted since commit `d4cad20`. Now that degradation is deliberate and visible, the documents must say so.

**Contract**: Lines 33, 47, 79 (FR-005), 85 (FR-007) and 95 (Business Logic) are amended to describe three alternatives, or a smaller set that is flagged to the runner. The guardrail at l. 39 and the acceptance criterion at l. 53 are **not** weakened — they are what justifies the reduction.

#### 2. System prompt note

**File**: `src/lib/services/recommendations.ts`

**Intent**: `SYSTEM_PROMPT` at `:125` says "Return exactly 3 workout alternatives" and the re-prompt tail at `:262` repeats it. The model should keep being asked for three — the generation contract and the shipping contract are different things, and that distinction is currently written down nowhere.

**Contract**: The instruction text is unchanged. A short comment records that `SYSTEM_PROMPT` plus the Zod `.length(3)` are the *generation* contract, while the *shipped* set may be smaller by way of the salvage path and is flagged when it is.

#### 3. Cookbook §6.1

**File**: `context/foundation/test-plan.md`

**Intent**: §6.1 is the artifact §3 Phases 2–4 copy from; leaving it TBD forfeits most of the rollout's compounding value.

**Contract**: §6.1 replaced with the patterns this phase established — the injected-dependency seam and why it was chosen over `vi.mock` and over the `fetch` idiom, the table-aware fake Supabase gotcha, asserting on a reason code rather than a message substring, asserting a bound behaviourally rather than by elapsed time, and the standing rule against pinning the ungrounded constants. §3 Phase 1 Status flips to `shipped`; §6.6 gains two or three lines on what the phase revealed.

#### 4. Change state

**File**: `context/changes/testing-ai-response-contract/change.md`

**Intent**: Close the change out truthfully.

**Contract**: `status` advances to `implemented` and `updated` is stamped. Research's open question 2 is resolved by Phase 2 (a lone survivor now ships). Open question 3 — silent positional re-ranking when the model's best-fit option is the one rejected — remains unspecified by any source and is recorded as knowingly accepted, not overlooked.

### Success Criteria:

#### Automated Verification:

- Whole suite passes: `npm test`
- Lint passes: `npm run lint`
- Build compiles: `npm run build`

#### Manual Verification:

- PRD no longer contradicts the shipped degradation contract at any of the five lines
- §6.1 is specific enough that Phase 2 could be written from it without re-reading this plan
- §3 Phase 1 Status reads `shipped`

---

## Testing Strategy

### Unit Tests:

- Unknown-field leniency in `parseRecommendation` — pinned as deliberate, not silently assumed
- Existing `recommendation-guardrail.test.ts` is untouched; its `:34-41` implementation mirror is called out in the cookbook rather than rewritten in this phase

### Integration Tests:

None. This phase starts no database and no sidecar — test-plan §3 assigns real-infrastructure tests to Phase 4.

### Hermetic Tests (the bulk of this phase):

- Happy path: three in-band alternatives ship ranked
- Degradation: one rejected → two ship flagged; two rejected → one ships flagged; three rejected → `LlmError`
- Implausibility: PRD l. 39's worked example never appears in the shipped set
- Failure taxonomy: timeout, transport, refusal, truncated, invalid_shape, implausible each map to their own reason
- Bound: past the budget, no further attempt is opened

### Manual Testing Steps:

1. `npm run preview`, connect Garmin, set modifiers, request a recommendation — three options as before.
2. Force a reduced set (temporarily narrow the duration band in a local edit, then revert) — confirm the degraded banner appears and names the reduced count.
3. Confirm a single-option result renders with no empty "If you prefer" heading.
4. Set an invalid `ANTHROPIC_API_KEY` in `.dev.vars` — confirm a readable error state and a `reason` in the 502 body.
5. Confirm the degraded banner stacks with the staleness banner when both apply.

## Performance Considerations

The budget guard in Phase 4 shortens the worst case; it adds one comparison per loop iteration and no allocation. The injected-dependency parameter is optional and defaults to today's construction, so the production path allocates exactly what it does now.

## Migration Notes

None. `RecommendationResult.degraded` is a response-only field — `src/components/hooks/useRecommendation.ts:99-103` sends only `{ alternative, context }` to the select endpoint, so no migration, no JSONB column and no `src/types/database.ts` regeneration is involved.

## References

- Related research: `context/changes/testing-ai-response-contract/research.md`
- Strategy and risk map: `context/foundation/test-plan.md` §2, §3, §5, §7
- Oracle: `context/foundation/prd.md` l. 33, 39, 47, 51, 53, 79, 85, 90, 95
- Reverted contract: `context/archive/2026-07-14-modifier-to-recommendation-loop/plan.md:99`
- Correct assertion pattern: `src/lib/recommendation-guardrail.test.ts:28-32`
- Implementation mirror to avoid: `src/lib/recommendation-guardrail.test.ts:34-41`
- Fetch-stubbing and fake-Supabase idiom: `src/lib/services/garmin.test.ts:19-36,59-67,96-99`
- Seam precedent: `src/lib/services/garmin-session-store.ts` (garmin-credential-control p2)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Client injection seam

#### Automated

- [x] 1.1 Existing suite still passes
- [x] 1.2 The new test file runs and passes
- [x] 1.3 Lint and type-checked rules pass
- [x] 1.4 Production build compiles

#### Manual

- [x] 1.5 Default (no-deps) path unchanged in preview

### Phase 2: Degradation made visible

#### Automated

- [ ] 2.1 One alternative rejected → two ship with the marker set
- [ ] 2.2 Two alternatives rejected → one ships with the marker set
- [ ] 2.3 All three valid → marker is null
- [ ] 2.4 All three rejected → LlmError, nothing shipped
- [ ] 2.5 Implausible options absent, asserted against PRD l. 39's worked example
- [ ] 2.6 Lint passes
- [ ] 2.7 Build compiles

#### Manual

- [ ] 2.8 Degraded banner renders above the cards; single-option result reads sensibly
- [ ] 2.9 Banner stacks correctly with the staleness notice

### Phase 3: Failure taxonomy

#### Automated

- [ ] 3.1 Timeout yields reason "timeout"
- [ ] 3.2 Transport error yields reason "transport"
- [ ] 3.3 Refusal yields reason "refusal" without consuming further attempts
- [ ] 3.4 max_tokens response yields reason "truncated"
- [ ] 3.5 Shape drift across every attempt yields reason "invalid_shape"
- [ ] 3.6 Persistent guardrail violation yields reason "implausible"
- [ ] 3.7 Unknown-field leniency pinned
- [ ] 3.8 Lint passes
- [ ] 3.9 Build compiles

#### Manual

- [ ] 3.10 Invalid API key returns a 502 carrying a reason; UI shows a readable error state

### Phase 4: Wall-clock budget

#### Automated

- [ ] 4.1 Past the budget no further attempt is opened; reason "timeout"
- [ ] 4.2 Within the budget the retry loop still uses all attempts
- [ ] 4.3 Whole suite passes
- [ ] 4.4 Lint passes
- [ ] 4.5 Build compiles

#### Manual

- [ ] 4.6 Normal recommendation unaffected in preview

### Phase 5: Stryker selective gate

#### Automated

- [ ] 5.1 Mutation run completes against the two-module scope
- [ ] 5.2 Suite still green after any added assertions
- [ ] 5.3 Lint passes

#### Manual

- [ ] 5.4 Every survived mutant has an explicit verdict — killed or ignored with a reason
- [ ] 5.5 No added assertion pins a guardrail threshold constant

### Phase 6: Docs, prompt and cookbook

#### Automated

- [ ] 6.1 Whole suite passes
- [ ] 6.2 Lint passes
- [ ] 6.3 Build compiles

#### Manual

- [ ] 6.4 PRD no longer contradicts the shipped degradation contract
- [ ] 6.5 §6.1 is specific enough to write Phase 2 from
- [ ] 6.6 §3 Phase 1 Status reads shipped
