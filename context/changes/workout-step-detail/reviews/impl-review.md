<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Structured Workout Detail per Recommendation

- **Plan**: context/changes/workout-step-detail/plan.md
- **Scope**: All 4 phases
- **Date**: 2026-07-21
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 2 warnings, 6 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Plan Adherence: all 9 planned items MATCH (no drift, no missing). Two additions
(`WorkoutDetailView.tsx`, `useRecommendation.ts` retype to `WorkoutSelectionWithDetail`)
are justified adaptations serving the plan's "identical in both render sites" intent.
Automated criteria green: `npm run test` 21/21, `npm run lint` clean, `npm run build` OK;
all manual checks confirmed by the user.

## Findings

### F1 — Pace anchor not filtered to running activities

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/recommendation-guardrail.ts:251 (deriveEasyPace); also deriveDurationBand
- **Detail**: deriveEasyPace computes the easy-pace anchor from every activity with usable distance+duration, ignoring GarminActivity.type. Confirmed the sidecar (sidecar/src/routes/data.ts:112) fetches recent activities of ANY type via getActivities(0, limit) and never filters. A cycling ride or fast parkrun in recent history skews the median implied pace; since that anchor scales every per-effort band, the S-05 guardrail can reject legitimate paces (→ 502 after one re-prompt) or pass implausible ones. deriveDurationBand shares the flaw (less acute).
- **Fix A ⭐ Recommended**: Filter to running activities inside deriveEasyPace/deriveDurationBand.
  - Strength: Fixes it at the guardrail source; matches plan wording ("median implied pace from recent RUNS").
  - Tradeoff: Needs a tolerant type check; must decide how to treat null/unknown types.
  - Confidence: HIGH — type is on GarminActivity and carried through.
  - Blind spot: Garmin typeKey variants (running / trail_running / treadmill_running) — a strict === would drop trail/treadmill runs; prefer startsWith/includes("running").
- **Fix B**: Filter upstream once in the service before calling the guardrail.
  - Strength: Single filter point; model context and guardrail agree on the same run-only set.
  - Tradeoff: Guardrail functions stay type-blind (misusable by a future caller).
  - Confidence: MED — verify the model-context slice still behaves.
  - Blind spot: Whether other consumers rely on the unfiltered list.
- **Decision**: FIXED via Fix A — added isRun() (type includes "run"; null excluded) to deriveEasyPace + deriveDurationBand.

### F2 — Warmup/cooldown pace band rejects legitimate slower paces

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality (reliability)
- **Location**: src/lib/recommendation-guardrail.ts:230-282
- **Detail**: warmup/cooldown use multiplier 1.0 with ±8% tolerance → band [0.92E, 1.08E]. Runners routinely warm up / cool down slower than easy (1.10–1.20E); only `recovery` allows up to ~1.24E. A warmup at 1.15E is rejected → one re-prompt (recommendations.ts:199) → LlmError → 502. Over-tight bands become user-facing generation failures. The plan's table (matched exactly) flagged these multipliers as "tune during manual verification."
- **Fix**: Widen the slow side for gentle efforts — e.g. warmup/cooldown { lo: 1.0, hi: 1.20 } and easy { lo: 1.0, hi: 1.10 } — so slower-than-easy warm/cool passes while still bounded. (Happy path already verified in 2.4–2.6; this hardens the tail case.)
- **Decision**: FIXED — warmup/cooldown hi 1.20, easy hi 1.10.

### F3 — New pace-guardrail functions have no automated coverage

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria / Quality
- **Location**: src/lib/recommendation-guardrail.test.ts
- **Detail**: parsePaceToSeconds, formatPace, deriveEasyPace, derivePaceBand, validateWorkoutStructure have zero tests. This MATCHES the plan's explicit "No new unit tests" decision and its Open-Risks note — a documented choice, not drift. Worth revisiting because vitest + `npm test` already exist and F1/F2/F4 are exactly what a few cases would pin.
- **Fix**: Optionally add vitest cases (band boundaries, null-history fallback, :60 edge, duration-sum violation).
- **Decision**: PENDING

### F4 — formatPace can emit an invalid ":60" string (latent)

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/recommendation-guardrail.ts:87-91
- **Detail**: Math.round(seconds % 60) yields 60 for inputs ≥ x:59.5 (formatPace(119.6) → "1:60"). Latent only — all current call sites pass integers. Fragile if a fractional value is ever passed.
- **Fix**: Compute total = Math.round(seconds) first, then derive mins/secs from the rounded integer.
- **Decision**: PENDING

### F5 — withDetail casts JSONB to WorkoutDetail with no runtime validation

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Reliability
- **Location**: src/lib/services/workout-selections.ts:26-28
- **Detail**: (row.workout_detail as WorkoutDetail | null) trusts the column shape. A malformed non-null row (e.g. { summary } with no steps) would make WorkoutDetailView call steps.map(...) and throw. Not reachable via the app (writes go through the Zod-validated select.ts body; pre-S-05 rows are null and handled) — only direct DB tampering.
- **Fix**: Optional-chain steps in WorkoutDetailView (or a defensive parse) to harden against malformed rows.
- **Decision**: PENDING

### F6 — Guardrail silently degrades to near no-op with thin history

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Correctness
- **Location**: src/lib/recommendation-guardrail.ts:273-276
- **Detail**: When easyPaceSeconds is null (no activity has both distance+duration), every band collapses to absolute caps [2:30, 12:00], so per-effort plausibility is effectively disabled. Documented graceful fallback; worth monitoring how often easyPaceSeconds is null (already in the evt log).
- **Fix**: None required — monitor the logged easyPaceSeconds null rate.
- **Decision**: PENDING

### F7 — Guardrail evaluates full activity list; model sees only slice(0,4)

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Correctness
- **Location**: src/lib/services/recommendations.ts:239,247 vs :119
- **Detail**: buildUserContext shows the model activities.slice(0,4), but validateAlternatives/validateWorkoutStructure receive the full dashboard.activities — so the guardrail may judge against a different set than the model saw. Likely harmless (median smooths it) but a subtle divergence worth confirming is intended.
- **Fix**: If undesired, pass the same slice to the guardrail.
- **Decision**: PENDING

### F8 — Trivial doc/comment nits

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: workout-selections.ts:61; recommendations.ts:203; CLAUDE.md
- **Detail**: (a) comment "// null in S-03" on training_arc_note is stale (S-04/S-05 populate it). (b) attempt-2 re-prompt tail always says "…with plausible durations." even for a pace violation — functionally fine (pace guidance rides in lastViolations ahead of it), just duration-centric wording. (c) CLAUDE.md's "There are no test scripts yet" is stale (vitest + npm test exist).
- **Fix**: Touch up the two comments and the CLAUDE.md line.
- **Decision**: PENDING
