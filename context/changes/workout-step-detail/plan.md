# Structured Workout Detail per Recommendation Implementation Plan

## Overview

Roadmap slice **S-05** (`workout-step-detail`, PRD FR-004/FR-005 extension). Today each AI recommendation is a label + total duration + two prose lines. This change makes each of the 3 alternatives a **concrete, runnable prescription**: a one-line `summary` under the name (e.g. "45 min easy 6:15/km") plus, for structured sessions, an expandable step-by-step breakdown with per-segment effort, duration, and target pace. Target paces are **grounded in the runner's recent runs and validated by a new guardrail** — the pace analogue of S-03's plausible-load guardrail.

This is the third extension of the S-03/S-04 single-call recommendation loop. It adds two structured output fields (`summary`, `steps`), a second guardrail (pace + duration-sum consistency), a persisted JSONB column, and an expandable UI in the two existing render sites.

## Current State Analysis

The recommendation loop is a single Claude Haiku structured-output call (`src/lib/services/recommendations.ts`) guarded by a framework-free module (`src/lib/recommendation-guardrail.ts`) and rendered by two React components.

- **Per-alternative fields today** (`src/types.ts:31-38`): `rank`, `workout_type`, `duration_minutes`, `ai_explanation`, `training_arc_note`. This change adds `summary` and `steps`.
- **Guardrail today** validates only total duration against a band derived from recent activities (`deriveDurationBand` / `validateAlternatives`, `recommendation-guardrail.ts:82-127`). The re-prompt loop in the service (`recommendations.ts:186-240`) re-prompts once on violation, then fails — never shipping an implausible load. Pace validation is new logic that plugs into the same loop.
- **The model already receives per-activity `distance_km` + `duration_min` + `avg_hr`** (`buildUserContext`, `recommendations.ts:106-143`), so implied pace (sec/km) is derivable from recent runs — the grounding for the pace band.
- **Persistence** (`src/lib/services/workout-selections.ts`): flat columns on `workout_selections`. There is no column for structured detail; the JSONB precedent is `garmin_data_snapshot` (`Json` in `database.ts`, cast via `as SnapshotJson`).
- **`database.ts` is Supabase-generated** (`export type Json` shape); there is **no `gen types` npm script**, so a new column is added by regenerating from a local DB or hand-editing following the `garmin_data_snapshot` pattern.
- **Render sites**: `RecommendationResults.tsx` (the 3 alternative cards) and `RecommendationSection.tsx:106-121` (the returning-user "Committed" block). Both are client islands, so an expand/collapse disclosure is straightforward local state.

### Key Discoveries:

- The locked "grounded paces + guardrail" decision requires **structured** steps: a pace embedded in free text can't be validated reliably. Hence `steps` is an array of typed segments, not prose.
- `GarminActivity` carries `distanceMeters` + `durationSeconds` (`src/types.ts:61-70`) → implied pace per run → a runner-specific easy-pace anchor for the pace band.
- The existing duration guardrail's re-prompt-then-fail loop (`recommendations.ts:186-240`) is the exact integration point for the new pace/structure validation — same mechanism, one more check.
- `workout_selections` already persists per-alternative AI output; storing the breakdown as one nullable JSONB column keeps the migration to a single column and mirrors `garmin_data_snapshot`.

## Desired End State

On `/dashboard`, each of the 3 alternatives shows a `summary` line under the workout name and — when the session has more than one segment — a "show details / hide details" toggle revealing an ordered step list (effort · duration · target pace). The committed block shows the same for the runner's chosen workout on reload. Every prescribed pace has passed the plausibility guardrail (grounded in recent runs, with effort-relative allowances); an implausible pace is never shipped (re-prompt once, then a typed error + Retry). Pre-existing S-03/S-04 selections (null detail) render cleanly without a summary/steps block.

**Verification:** `POST /api/recommendations` returns each alternative with a `summary` and a `steps` array whose paces are plausible for the runner and whose durations sum (within tolerance) to `duration_minutes`; committing persists `workout_detail`; the dashboard renders the summary + expandable steps; `npm run test` (existing guardrail tests still green), `npm run lint`, `npm run build` all pass; the migration applies to a local Supabase.

## What We're NOT Doing

- **No distance-based segments** (e.g. 400 m reps) — segments are time-based only for this MVP; the total-duration invariant stays simple. Distance segments are a later iteration.
- **No nested repeat groups** — the interval block is emitted as a flat sequence of segments (e.g. 5×[hard/easy] → 10 segments); the compressed "5× …" phrasing lives in the model-authored `summary`.
- **No `.fit` export / push to Garmin** — PRD Non-Goal; the structured steps merely make a future export possible.
- **No changes to the duration guardrail, daily cap, error taxonomy, modifier form, or the S-04 `training_arc_note` behavior.**
- **No new unit tests** (per the testing decision) — but the existing `recommendation-guardrail.test.ts` must stay green. See Open Risks: the new pace guardrail ships without automated regression coverage.
- **No pace personalization model beyond recent-run implied pace** (no VDOT/critical-speed math) — the easy-anchor + effort-multiplier heuristic is the whole model.

## Implementation Approach

Follow the database-change order: schema/migration → AI contract + guardrail → persistence → UI.

The **data shape** is a per-alternative `summary: string` (always, model-authored, human phrasing) plus `steps: WorkoutStep[]` (always ≥1). `WorkoutStep = { effort, duration_minutes, target_pace }` where `target_pace` is an `"m:ss"` per-km string in the model output, parsed to seconds in Zod for the guardrail and shown verbatim in the UI. A simple continuous run is a single step (so the UI shows just the summary, no toggle); a structured session is many steps. Persisted as one JSONB column `workout_detail = { summary, steps }`.

The **pace guardrail** derives the runner's easy pace from recent runs' median implied pace, then bounds each step's pace to a band scaled by that step's effort (intervals allowed faster than easy, recovery slower), with absolute sane caps. It also checks that the step durations sum (within tolerance) to the alternative's `duration_minutes`. Violations feed the existing one-shot re-prompt; a persistent violation is a typed error (never ship a bad pace) — identical discipline to the duration guardrail.

## Critical Implementation Details

- **Pace is an `"m:ss"`-per-km string in the model contract, parsed to seconds for the guardrail.** The JSON schema/Zod field `target_pace` is a string; Zod transforms `"6:15"` → `375` seconds for validation, and the UI renders the original string + `/km`. This keeps the model output natural while giving the guardrail a number to compare. Reject unparseable pace strings in Zod (treat as a structure violation → re-prompt).
- **`steps` is required and length ≥ 1**, so every prescribed pace lives in a guarded step (a paceless free-text summary is never the only place a pace appears). This refines the "optional steps" framing toward guardrail integrity; the UX is unchanged (a 1-step run shows only the summary, no expand). Structured outputs cannot constrain array length or numeric ranges — `min(1)`, the effort enum, and the pace bands are all enforced in the Zod parse + guardrail (mirrors the existing note at `recommendation-guardrail.ts:18-20`).
- **Effort→pace band.** Define an `effort` enum and a multiplier table relative to the runner's easy pace `E` (pace in sec/km; smaller = faster), each with a tolerance, plus absolute caps. Starting point (tune during manual verification):

  | effort | pace ≈ | notes |
  | --- | --- | --- |
  | `warmup` / `cooldown` / `easy` | `E` (×1.00) | conversational |
  | `recovery` | `E × 1.00–1.15` | jog between reps, easy or slower |
  | `steady` | `E × 0.93` | |
  | `tempo` | `E × 0.88` | |
  | `threshold` | `E × 0.85` | |
  | `interval` | `E × 0.75–0.80` | legitimately much faster than easy |

  Apply a ± tolerance (e.g. ±8%) around each target and clamp to absolute caps (e.g. floor 2:30/km, ceiling 12:00/km). When recent runs lack usable distance+duration pairs, `E` is unknown → fall back to the absolute caps only (looser band, logged).
- **Duration-sum consistency.** `sum(steps[].duration_minutes)` should be within tolerance (e.g. ±15%) of the alternative's `duration_minutes`; a large mismatch is a structure violation → re-prompt.

## Phase 1: Data model & migration

### Overview

Add the persisted column and the DTO/types the rest of the plan builds on. No behavior yet.

### Changes Required:

#### 1. Migration — `workout_detail` JSONB column

**File**: `supabase/migrations/20260721000001_add_workout_detail.sql`

**Intent**: Give `workout_selections` a nullable JSONB column to persist the structured breakdown of the committed workout, mirroring the existing `garmin_data_snapshot` JSONB.

**Contract**: `ALTER TABLE workout_selections ADD COLUMN workout_detail JSONB;` — nullable, no default (older rows stay null). No RLS change (row policies already cover the table). Follow the migration-file conventions in `supabase/migrations/`.

#### 2. Generated DB types

**File**: `src/types/database.ts`

**Intent**: Reflect the new column so the typed Supabase client sees it.

**Contract**: Add `workout_detail: Json | null` to the `workout_selections` `Row`, and `workout_detail?: Json | null` to `Insert`/`Update` (mirror `garmin_data_snapshot`). Preferred: regenerate via `npx supabase gen types typescript --local` after applying the migration; fallback: hand-edit following the `garmin_data_snapshot` lines.

#### 3. Domain DTO types

**File**: `src/types.ts`

**Intent**: Introduce the typed workout-step shapes and extend the alternative DTO.

**Contract**: Add `WorkoutEffort` (string-literal union: `warmup | easy | steady | tempo | threshold | interval | recovery | cooldown`), `WorkoutStep = { effort: WorkoutEffort; duration_minutes: number; target_pace: string }` (pace as `"m:ss"`/km display string), and `WorkoutDetail = { summary: string; steps: WorkoutStep[] }`. Extend `WorkoutAlternative` with `summary: string` and `steps: WorkoutStep[]`. (The persisted `workout_detail` JSONB holds a `WorkoutDetail`.)

### Success Criteria:

#### Automated Verification:

- [ ] Type checking passes: `npm run build`
- [ ] Linting passes: `npm run lint`

#### Manual Verification:

- [ ] Migration applies cleanly to a local Supabase (`npx supabase db reset` or apply-up) and `workout_selections.workout_detail` exists as nullable JSONB.

**Implementation Note**: Pause for manual confirmation the migration applied before Phase 2.

---

## Phase 2: AI contract, pace guardrail & service (backend core)

### Overview

Make the single Claude call produce a `summary` + structured `steps` per alternative, and validate the paces + structure with a new guardrail wired into the existing re-prompt loop.

### Changes Required:

#### 1. Structured-output schema, Zod parse & pace guardrail

**File**: `src/lib/recommendation-guardrail.ts`

**Intent**: Teach the model contract and the response parse about `summary` + `steps`, and add the grounded pace-plausibility + duration-sum guardrail that the service re-prompts on.

**Contract**: In `RECOMMENDATION_JSON_SCHEMA`, add to each alternative's `properties` (and `required`): `summary` (string) and `steps` (array of objects `{ effort: string, duration_minutes: integer, target_pace: string }`, each with `additionalProperties: false` + its own `required`). In `recommendationResponseSchema`, add `summary` (`z.string().min(1)`) and `steps` (`z.array(stepSchema).min(1)`), where `stepSchema` validates `effort` against the `WorkoutEffort` enum, `duration_minutes` as positive int, and `target_pace` as an `"m:ss"` string transformed to `paceSecondsPerKm` (reject unparseable). Add: `EFFORT_PACE_MULTIPLIERS` + tolerances + absolute caps (per Critical Implementation Details); `deriveEasyPace(activities)` (median implied pace from recent runs' distance/duration, or null); `derivePaceBand(effort, easyPace)`; and `validateWorkoutStructure(alternatives, activities)` returning violations for (a) any step pace outside its effort band and (b) any alternative whose step durations don't sum within tolerance to `duration_minutes`. Keep the module framework-free.

#### 2. Prompt, mapping & re-prompt integration

**File**: `src/lib/services/recommendations.ts`

**Intent**: Ask the model for the summary + time-based structured steps with grounded paces, carry them into the result, and extend the guardrail loop to enforce pace/structure.

**Contract**: Extend `SYSTEM_PROMPT`: each alternative must include a one-line `summary` (duration + effort + target pace, e.g. "45 min easy 6:15/km") and `steps` — an ordered list of **time-based** segments, each with `effort` (from the enum), `duration_minutes`, and `target_pace` as `m:ss` per km; target paces must be realistic for the runner given their recent runs (easy segments near recent easy pace; faster only for higher-effort segments); express repeats as repeated segments and compress them in the `summary`; step durations should sum to the alternative's total. Map `summary` + `steps` into each `WorkoutAlternative`. In the attempt loop (`recommendations.ts:186-240`), after the existing `validateAlternatives` duration check, also run `validateWorkoutStructure`; on violation, append its messages (incl. the plausible pace band) to the re-prompt like the duration band, and treat a persistent violation as an `LlmError` (never ship an implausible pace). Reuse the same one-shot re-prompt budget.

### Success Criteria:

#### Automated Verification:

- [ ] Type checking passes: `npm run build`
- [ ] Linting passes: `npm run lint`
- [ ] Existing tests still pass: `npm run test` (the `recommendation-guardrail.test.ts` cases stay green)

#### Manual Verification:

- [ ] `POST /api/recommendations` (via `npm run preview`) returns each alternative with a `summary` and a `steps` array; paces read as realistic for the runner; step durations sum ≈ the alternative total.
- [ ] A structured session (e.g. intervals) shows the interval segments; a plain easy run returns a single step.
- [ ] Forcing an implausible pace (e.g. a very hard interval on a beginner history) triggers the re-prompt and, if unresolved, a typed error + Retry — no implausible pace is shown.
- [ ] The `evt: "recommendation"` log still emits and the call stays within the ~10s budget.

**Implementation Note**: Pause for manual confirmation (paces sane + re-prompt/fail works) before Phase 3.

---

## Phase 3: Persistence

### Overview

Persist and read back the structured breakdown so the committed workout shows it on reload.

### Changes Required:

#### 1. Workout-selection service

**File**: `src/lib/services/workout-selections.ts`

**Intent**: Store the chosen alternative's `summary` + `steps` as the `workout_detail` JSONB, and expose it on read.

**Contract**: In `saveSelection`, write `workout_detail: { summary, steps }` (cast to the `Json` column type, as `garmin_data_snapshot` does). `getTodaySelection` already `select("*")`s, so `workout_detail` returns with the row; expose it typed as `WorkoutDetail | null` to callers (parse/cast the `Json`). `SaveSelectionInput` carries the chosen `WorkoutAlternative`, which now includes `summary` + `steps`.

#### 2. Select API request contract

**File**: `src/pages/api/recommendations/select.ts`

**Intent**: Accept the new fields when the client commits a selection.

**Contract**: Extend the request Zod schema so the posted alternative includes `summary` (non-empty string) and `steps` (array ≥1 of `{ effort, duration_minutes, target_pace }`), alongside the existing fields. Pass them through to `saveSelection`. (Mirrors how `training_arc_note` was threaded at `select.ts:20`.)

### Success Criteria:

#### Automated Verification:

- [ ] Type checking passes: `npm run build`
- [ ] Linting passes: `npm run lint`

#### Manual Verification:

- [ ] Committing an alternative writes a non-null `workout_detail` (summary + steps) to `workout_selections` (spot-check in Supabase).
- [ ] Reloading the dashboard returns the committed selection with its `workout_detail` populated.

**Implementation Note**: Pause for manual confirmation persistence round-trips before Phase 4.

---

## Phase 4: Render (summary + expandable steps)

### Overview

Show the summary line and an expandable step list in both render sites, collapsed by default, with the toggle only when there's more than one step.

### Changes Required:

#### 1. Alternative card — summary + expandable steps

**File**: `src/components/recommendations/RecommendationResults.tsx`

**Intent**: Under each alternative's name, show the `summary`; when `steps.length > 1`, offer a "show details / hide details" toggle that reveals the ordered step list.

**Contract**: In the `Card` component, render `alt.summary` as a prominent line near the top (below the workout_type / duration). When `alt.steps.length > 1`, render a toggle button (collapsed by default; local `useState`) that expands an ordered list of steps — each row: effort label · `duration_minutes` · `target_pace`/km — styled with existing card conventions (muted text, small icons). A single-step alternative shows only the summary (no toggle). Keep the existing `ai_explanation` + `training_arc_note` lines. Per-card independent state.

#### 2. Committed block — summary + expandable steps

**File**: `src/components/recommendations/RecommendationSection.tsx`

**Intent**: Give the returning runner the same summary + expandable steps for their committed workout.

**Contract**: In the idle "Committed" block (lines ~106-121), read `today.workout_detail` (`WorkoutDetail | null`); when present, render its `summary` and the same expandable step list (toggle when `steps.length > 1`), using the same treatment as change #1. Render nothing extra when `workout_detail` is null (older S-03/S-04 rows).

### Success Criteria:

#### Automated Verification:

- [ ] Type checking passes: `npm run build`
- [ ] Linting passes: `npm run lint`

#### Manual Verification:

- [ ] Each alternative card shows the summary line; a structured session shows a working "show details" toggle with the correct steps; a single-step run shows no toggle.
- [ ] After committing and reloading, the "Committed" block shows the summary + expandable steps.
- [ ] An older committed selection (null `workout_detail`) renders cleanly with no summary/steps artifacts.
- [ ] No regression to the S-03/S-04 modifier → results → commit → reload flow.

**Implementation Note**: Verify via `npm run preview` (not `npm run dev`) per the React-dedup gotcha.

---

## Testing Strategy

### Unit Tests:

- None added (testing decision = manual). Constraint: the existing `src/lib/recommendation-guardrail.test.ts` `parseRecommendation` / `validateAlternatives` cases must remain green after `summary` + `steps` are added (make the new fields tolerant in the parse the way existing fixtures allow, or update fixtures minimally if strictly required by `min(1)` — prefer keeping fixtures valid).

### Integration Tests:

- None automated. End-to-end covered by manual verification.

### Manual Testing Steps:

1. `npm run preview`, sign in as a user with an active race goal + connected Garmin.
2. Generate — confirm each option has a summary line and (for structured sessions) a working expand with sane per-segment paces; durations sum to the total.
3. Confirm a plain easy run is a single step (summary only, no toggle).
4. Force/observe an implausible pace path — confirm re-prompt then error, never a bad pace.
5. Commit an option; reload — confirm the committed block shows summary + steps.
6. Confirm an older selection (null detail) renders cleanly.
7. `npm run test`, `npm run lint`, `npm run build` all pass; migration applies locally.

## Performance Considerations

Negligible latency: one call, a handful more output tokens for the steps (raise `MAX_TOKENS` only if truncation appears — currently 2048; a multi-step session is still small). The guardrail is O(steps) arithmetic. No extra DB round-trips (one JSONB column on the existing upsert).

## Migration Notes

One additive, nullable JSONB column — no backfill. Pre-existing `workout_selections` rows keep `workout_detail = null` and render without the summary/steps block. Local dev needs Docker + `npx supabase start` to apply the migration; CI/prod applies it via the normal migration path.

## References

- Roadmap slice: `context/foundation/roadmap.md` (S-05)
- Predecessor chain: `context/archive/2026-07-14-modifier-to-recommendation-loop/` (S-03), `context/archive/2026-07-20-training-arc-context/` (S-04)
- Guardrail + re-prompt loop: `src/lib/recommendation-guardrail.ts`, `src/lib/services/recommendations.ts:186-240`
- Persistence precedent (JSONB): `src/lib/services/workout-selections.ts` + `garmin_data_snapshot`
- Render sites: `src/components/recommendations/RecommendationResults.tsx`, `src/components/recommendations/RecommendationSection.tsx:106-121`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Data model & migration

#### Automated

- [x] 1.1 Type checking passes: `npm run build` — 88deaea
- [x] 1.2 Linting passes: `npm run lint` — 88deaea

#### Manual

- [x] 1.3 Migration applies cleanly to local Supabase; `workout_detail` exists as nullable JSONB — 88deaea

### Phase 2: AI contract, pace guardrail & service

#### Automated

- [x] 2.1 Type checking passes: `npm run build` — 06e577b
- [x] 2.2 Linting passes: `npm run lint` — 06e577b
- [x] 2.3 Existing tests still pass: `npm run test` — 06e577b

#### Manual

- [x] 2.4 `POST /api/recommendations` returns summary + steps; paces realistic; durations sum ≈ total — 06e577b
- [x] 2.5 Structured session shows interval segments; plain easy run returns a single step — 06e577b
- [x] 2.6 Implausible pace triggers re-prompt then typed error — no bad pace shipped — 06e577b
- [x] 2.7 Recommendation log still emits and the call stays within the ~10s budget — 06e577b

### Phase 3: Persistence

#### Automated

- [x] 3.1 Type checking passes: `npm run build`
- [x] 3.2 Linting passes: `npm run lint`

#### Manual

- [x] 3.3 Committing persists a non-null `workout_detail` (summary + steps) to `workout_selections`
- [x] 3.4 Reloading returns the committed selection with `workout_detail` populated

### Phase 4: Render (summary + expandable steps)

#### Automated

- [ ] 4.1 Type checking passes: `npm run build`
- [ ] 4.2 Linting passes: `npm run lint`

#### Manual

- [ ] 4.3 Cards show the summary; structured session has a working expand with correct steps; single-step run shows no toggle
- [ ] 4.4 After committing and reloading, the committed block shows summary + expandable steps
- [ ] 4.5 Older committed selection (null detail) renders cleanly
- [ ] 4.6 No regression to the S-03/S-04 modifier → results → commit → reload flow
