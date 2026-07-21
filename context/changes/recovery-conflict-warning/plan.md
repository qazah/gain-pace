# Low-Recovery Conflict Warning Implementation Plan

## Overview

Roadmap slice **S-06** (`recovery-conflict-warning`, PRD FR-004/FR-005 extension). When a runner asks for a hard session (`intensity = high`) while their recovery is low, surface a one-line amber caution under each genuinely hard alternative — acknowledging the tradeoff and nudging them to listen to their body. **The runner's choice is never blocked**; the watch informs, it does not gate.

This is the fourth extension of the S-03/S-04/S-05 single-call recommendation loop. It adds one deterministic flag, one model-authored (guardrail-backed) output field `recovery_warning`, one persisted flat column, and an amber line in the two existing render sites.

## Current State Analysis

The recommendation loop is a single Claude Haiku structured-output call (`src/lib/services/recommendations.ts`) guarded by a framework-free module (`src/lib/recommendation-guardrail.ts`) and rendered by two React components.

- **Recovery data already reaches the model.** `buildUserContext` (`recommendations.ts:117-154`) fetches Garmin data server-side via `getDashboardData` and includes `recovery` (`sleep_score`, `overnight_hrv`, `body_battery.current`) in the prompt payload — unless `recoveryIsMissing()` (`recommendations.ts:72-78`), which sends the string `"no recovery data synced for today"`. The browser only POSTs the modifiers; recovery is added server-side (invisible in the Network tab). So this change is **additive** — the input is already present.
- **`body_battery` is `dashboard.recovery.bodyBattery.current`** (`GarminBodyBattery`, `types.ts`), a 0–100 value; the deterministic flag reads it directly.
- **Per-alternative `steps` exist (S-05)** — `WorkoutAlternative.steps` / `WorkoutStep.effort` (`types.ts`), so "is this option hard?" is a pure function of the parsed steps (`effort ∈ {tempo, threshold, interval}`).
- **`training_arc_note` is the 1:1 persistence template.** It threads end-to-end as a flat nullable column: `workout_selections.training_arc_note` (`database.ts` Row/Insert/Update) → `WorkoutAlternative.training_arc_note` (`types.ts`) → `saveSelection` row (`workout-selections.ts:61`) → request Zod (`select.ts:20`) → hook/render. `recovery_warning` mirrors this exactly.
- **The guardrail module is framework-free** (`recommendation-guardrail.ts` imports only `astro/zod` + types) and already hosts helpers like `deriveEasyPace`, `WORKOUT_EFFORTS`. The new flag + hard-detection helpers belong here.
- **Render sites**: `RecommendationResults.tsx` (the 3 cards; already imports `TriangleAlert` and renders `training_arc_note` on a `TrendingUp` line) and `RecommendationSection.tsx` (the committed block, reads `today` typed as `WorkoutSelectionWithDetail`).

### Key Discoveries:

- The re-prompt loop (`recommendations.ts:199-243`) validates plausibility (duration + pace) and re-prompts once on violation. `recovery_warning` is **not** a plausibility check — it must run **after** the guardrails, during the mapping step, and must **never** trigger a re-prompt.
- Code owns *whether* to warn (deterministic flag + hard-option detection); the model owns *how it's worded*; a static fallback guarantees the note never silently drops. This mirrors the S-05 guardrail discipline (`recommendation-guardrail.ts`).
- `recovery_warning` is populated per-alternative but persisted only for the single committed selection — a flat column suffices (unlike S-05's structured `workout_detail` JSONB).

## Desired End State

On `/dashboard`, when the runner sets `intensity = high` and their body battery is below the threshold, each hard alternative (one with a tempo/threshold/interval step) shows an amber `TriangleAlert` line with a one-sentence caution; lighter alternatives show nothing. The chosen workout, once committed, shows the same caution on reload. When body battery is at/above the threshold, or `intensity ≠ high`, or recovery is missing, no caution ever appears. The runner is never blocked from choosing a hard session.

**Verification:** with `intensity=high` and body battery < threshold, `POST /api/recommendations` returns a `recovery_warning` string on hard alternatives and null on the rest; committing persists `recovery_warning`; the dashboard renders the amber line; the same request with normal intensity (or healthy body battery) returns `recovery_warning: null` everywhere; `npm run test`, `npm run lint`, `npm run build`, and `npx astro check` all pass; the migration applies to a local Supabase.

## What We're NOT Doing

- **No sleep-score or HRV thresholds** — only body battery drives the flag. Sleep/HRV stay as model context (they already are). No per-user HRV baseline.
- **No blocking / veto** — a low-recovery reading never prevents a hard recommendation or a hard selection. Intent always wins.
- **No re-prompt on recovery_warning** — it is not a plausibility guardrail; it never rejects a response or consumes the re-prompt budget.
- **No change to the duration/pace guardrails, daily cap, error taxonomy, modifier form, `training_arc_note`, or the S-05 `workout_detail`.**
- **No new unit tests** (per the standing testing decision) — but the existing `recommendation-guardrail.test.ts` must stay green. See Open Risks: the flag/hard-detection helpers ship without automated coverage.
- **No warning when the flag is set but no hard option is returned** — if the model self-softened every option despite the high-intensity request, there is nothing to attach a warning to, and none shows. This is intentional.

## Implementation Approach

Follow the database-change order: schema/migration → AI contract + flag/fallback → persistence → UI.

The **flag** is deterministic and server-side: `recoveryConflict = recovery-present && body_battery.current < LOW_BODY_BATTERY && modifiers.intensity === "high"`, with `LOW_BODY_BATTERY = 20`. A **hard option** is any alternative with a step whose `effort ∈ {tempo, threshold, interval}`.

The **field** is a per-alternative `recovery_warning: string | null` (model-authored when the flag is set; `null` otherwise), mirroring `training_arc_note`'s lenient parse. The **prompt** gains a conditional instruction only when the flag is set. After parsing and the existing guardrails, the mapping step decides the final value: `null` when the flag is off or the option is not hard; the model's sentence (or a static fallback) when the flag is on and the option is hard. Persisted as a flat `recovery_warning` column on the committed selection.

## Critical Implementation Details

- **Ordering:** `recovery_warning` resolution happens in the alternative-mapping step (`recommendations.ts:236-243` area), strictly after `validateAlternatives` and `validateWorkoutStructure` have passed. It is not part of any guardrail and must not cause a `continue`/re-prompt.
- **Code owns the gate, model owns the words:** even though the JSON schema always includes `recovery_warning` (so the model may return it any time), the mapping forcibly sets it to `null` unless `recoveryConflict && isHardWorkout(steps)`. The model can never make a warning appear on its own; the flag can never leave a hard option without one (static fallback fills the gap).
- **Static fallback wording:** `"Your recovery looks low today — this is a demanding session, so listen to your body and ease off if needed."` (English, matching the model's `ai_explanation`/`training_arc_note` prose).

## Phase 1: Data model & migration

### Overview

Add the persisted column and the DTO field the rest of the plan builds on. No behavior yet.

### Changes Required:

#### 1. Migration — `recovery_warning` column

**File**: `supabase/migrations/20260722000001_add_recovery_warning.sql`

**Intent**: Give `workout_selections` a nullable TEXT column to persist the committed workout's low-recovery caution, mirroring the existing `training_arc_note` column.

**Contract**: `ALTER TABLE workout_selections ADD COLUMN recovery_warning TEXT;` — nullable, no default (older rows stay null). No RLS change (table-level GRANT from `20260713000001` covers new columns; row policies already apply). Follow the header-comment convention in `supabase/migrations/`.

#### 2. Generated DB types

**File**: `src/types/database.ts`

**Intent**: Reflect the new column so the typed Supabase client sees it.

**Contract**: Add `recovery_warning: string | null` to the `workout_selections` `Row`, and `recovery_warning?: string | null` to `Insert`/`Update` (mirror `training_arc_note`). Preferred: regenerate via `npx supabase gen types typescript --local`; fallback: hand-edit following the `training_arc_note` lines.

#### 3. Domain DTO type

**File**: `src/types.ts`

**Intent**: Carry the caution on the alternative DTO so it flows through generation, selection, and render.

**Contract**: Add `recovery_warning: string | null` to `WorkoutAlternative` (alongside `training_arc_note`). `WorkoutSelection`/`WorkoutSelectionWithDetail` pick the column up automatically via the `database.ts` Row.

### Success Criteria:

#### Automated Verification:

- [ ] Type checking passes: `npm run build`
- [ ] Linting passes: `npm run lint`
- [ ] No type errors in `src/`: `npx astro check`

#### Manual Verification:

- [ ] Migration applies cleanly to a local Supabase (`npx supabase db reset` or apply-up) and `workout_selections.recovery_warning` exists as nullable TEXT.

**Implementation Note**: Pause for manual confirmation the migration applied before Phase 2.

---

## Phase 2: AI contract, flag & fallback (backend core)

### Overview

Add the `recovery_warning` field to the model contract, the deterministic flag + hard-option detection to the guardrail module, and the mapping logic (conditional prompt + fallback + null-strip) to the service — without touching the re-prompt guardrails.

### Changes Required:

#### 1. Flag, hard-detection & field parse

**File**: `src/lib/recommendation-guardrail.ts`

**Intent**: Teach the model contract about `recovery_warning`, and add the framework-free helpers the service uses to decide when the warning applies.

**Contract**:
- In `RECOMMENDATION_JSON_SCHEMA`, add `recovery_warning` (string) to each alternative's `properties` and `required`.
- In `recommendationResponseSchema`, add `recovery_warning` as a lenient nullish→trim→null field (identical treatment to `training_arc_note`).
- Add `export const LOW_BODY_BATTERY = 20;`.
- Add `export function isRecoveryConflict(bodyBatteryCurrent: number | null, intensity: WorkoutModifiers["intensity"]): boolean` — true iff `bodyBatteryCurrent != null && bodyBatteryCurrent < LOW_BODY_BATTERY && intensity === "high"`.
- Add `export function isHardWorkout(steps: { effort: WorkoutEffort }[]): boolean` — true iff any step's `effort ∈ {tempo, threshold, interval}` (define a `HARD_EFFORTS` set). Keep the module framework-free.

#### 2. Prompt, flag wiring, mapping & fallback

**File**: `src/lib/services/recommendations.ts`

**Intent**: Compute the flag, ask the model for a caution only when it applies, and resolve each alternative's final `recovery_warning` after the guardrails pass — never re-prompting on it.

**Contract**:
- Compute `const recoveryConflict = isRecoveryConflict(dashboard.recovery?.bodyBattery.current ?? null, modifiers.intensity)` once (recovery-present is implied by a non-null current; when `recoveryIsMissing`, `current` is null → flag false).
- Extend `SYSTEM_PROMPT` to describe the `recovery_warning` field (now the alternative has this field; describe it as "one plain sentence, only for a hard session when the runner's recovery is low; otherwise empty").
- When `recoveryConflict` is true, append a conditional instruction to the user content (like the re-prompt tail is appended) telling the model the body battery is low but the runner requested high intensity, and to set `recovery_warning` for hard options.
- In the alternative-mapping step (after `validateAlternatives` + `validateWorkoutStructure` pass), set `recovery_warning`:
  - `null` when `!recoveryConflict` or the alternative is not `isHardWorkout(alt.steps)`;
  - otherwise `alt.recovery_warning ?? RECOVERY_WARNING_FALLBACK`, where `RECOVERY_WARNING_FALLBACK` is the static sentence from Critical Implementation Details.
- Add `recoveryConflict` to the `evt: "recommendation"` structured log for observability.

### Success Criteria:

#### Automated Verification:

- [ ] Type checking passes: `npm run build`
- [ ] Linting passes: `npm run lint`
- [ ] No type errors in `src/`: `npx astro check`
- [ ] Existing tests still pass: `npm run test`

#### Manual Verification:

- [ ] With `intensity=high` and body battery < 20, `POST /api/recommendations` returns `recovery_warning` on hard alternatives and null on lighter ones.
- [ ] With `intensity=normal` (or body battery ≥ 20, or recovery missing), every alternative returns `recovery_warning: null`.
- [ ] A hard option missing a model-authored warning under a set flag gets the static fallback (never null while flag+hard).
- [ ] The `evt:"recommendation"` log emits `recoveryConflict` and the call stays within budget; no extra re-prompts are caused by this field.

**Implementation Note**: Pause for manual confirmation before Phase 3.

---

## Phase 3: Persistence

### Overview

Persist and read back the committed workout's `recovery_warning` so it shows on reload.

### Changes Required:

#### 1. Workout-selection service

**File**: `src/lib/services/workout-selections.ts`

**Intent**: Store the chosen alternative's `recovery_warning` on the row and expose it on read.

**Contract**: In `saveSelection`, add `recovery_warning: input.alternative.recovery_warning` to the persisted `row` (mirror `training_arc_note`). `getTodaySelection` already `select("*")`s, so the column returns on the row; `WorkoutSelectionWithDetail` inherits it via the `WorkoutSelection` Row (no extra typing needed). `SaveSelectionInput.alternative` is a `WorkoutAlternative`, which now includes `recovery_warning`.

#### 2. Select API request contract

**File**: `src/pages/api/recommendations/select.ts`

**Intent**: Accept `recovery_warning` when the client commits a selection.

**Contract**: Extend the request Zod schema's `alternative` object with `recovery_warning: z.string().nullable()` (mirror `training_arc_note` at `select.ts:20`); it flows through to `saveSelection` via `parsed.data.alternative`.

### Success Criteria:

#### Automated Verification:

- [ ] Type checking passes: `npm run build`
- [ ] Linting passes: `npm run lint`
- [ ] No type errors in `src/`: `npx astro check`

#### Manual Verification:

- [ ] Committing a hard alternative under a set flag writes a non-null `recovery_warning` to `workout_selections` (spot-check in Supabase).
- [ ] Committing a lighter alternative (or under no flag) writes `recovery_warning = null`.
- [ ] Reloading the dashboard returns the committed selection with `recovery_warning` populated as saved.

**Implementation Note**: Pause for manual confirmation persistence round-trips before Phase 4.

---

## Phase 4: Render (amber caution line)

### Overview

Show the amber caution under a hard option in both render sites, only when `recovery_warning` is non-null.

### Changes Required:

#### 1. Alternative card — caution line

**File**: `src/components/recommendations/RecommendationResults.tsx`

**Intent**: Under an alternative that carries a caution, show an amber `TriangleAlert` line, visually distinct from the purple `training_arc_note` line.

**Contract**: In the `Card` component, when `alt.recovery_warning` is non-null, render an amber line (reuse the existing `TriangleAlert` import; amber text like the existing stale/recovery-missing banner) showing the warning text. Placement near the top (below the summary), so the caution is seen before choosing. Keep the existing `summary`/steps, `ai_explanation`, and `training_arc_note` lines unchanged.

#### 2. Committed block — caution line

**File**: `src/components/recommendations/RecommendationSection.tsx`

**Intent**: Give the returning runner the same caution for their committed workout.

**Contract**: In the idle "Committed" block, read `today.recovery_warning` (`string | null`, present on `WorkoutSelectionWithDetail` via the Row); when non-null, render the same amber `TriangleAlert` line as change #1. Render nothing when null.

### Success Criteria:

#### Automated Verification:

- [ ] Type checking passes: `npm run build`
- [ ] Linting passes: `npm run lint`
- [ ] No type errors in `src/`: `npx astro check`

#### Manual Verification:

- [ ] A hard alternative under a set flag shows the amber caution line; lighter alternatives show none; under no flag no card shows it.
- [ ] After committing a hard option and reloading, the "Committed" block shows the caution.
- [ ] A committed selection with null `recovery_warning` renders cleanly with no caution artifacts.
- [ ] No regression to the S-03/S-04/S-05 modifier → results → commit → reload flow (summary/steps, arc note still render).

**Implementation Note**: Verify via `npm run preview` (not `npm run dev`) per the React-dedup gotcha.

---

## Testing Strategy

### Unit Tests:

- None added (testing decision = manual). Constraint: the existing `src/lib/recommendation-guardrail.test.ts` cases must stay green after `recovery_warning` is added to the schema/parse — keep the fixtures valid (mirror how S-05's `summary`/`steps` were added), or extend them minimally if the lenient parse requires it (it should not — `recovery_warning` is nullish).

### Integration Tests:

- None automated. End-to-end covered by manual verification.

### Manual Testing Steps:

1. `npm run preview`, sign in as a user with an active race goal + connected Garmin whose current body battery is < 20 (or temporarily lower the threshold to observe).
2. Set `intensity = high`, generate — confirm hard options show the amber caution, lighter options don't.
3. Set `intensity = normal`, generate — confirm no caution anywhere.
4. Commit a hard option; reload — confirm the committed block shows the caution.
5. Commit a lighter option (or under normal intensity); reload — confirm no caution.
6. `npm run test`, `npm run lint`, `npm run build`, `npx astro check` all pass; migration applies locally.

## Performance Considerations

Negligible: no new DB round-trips (one flat column on the existing upsert), a handful more output tokens for one sentence, and O(steps) arithmetic for `isHardWorkout`. The conditional prompt line only appears when the flag is set.

## Migration Notes

One additive, nullable TEXT column — no backfill. Pre-existing `workout_selections` rows keep `recovery_warning = null` and render without the caution. Local dev needs Docker + `npx supabase start`; CI/prod applies via the normal migration path.

## References

- Roadmap slice: `context/foundation/roadmap.md` (S-06)
- Design + locked decisions: `context/changes/recovery-conflict-warning/change.md`
- Predecessor chain: S-03 (`context/archive/2026-07-14-modifier-to-recommendation-loop/`), S-04 (`context/archive/2026-07-20-training-arc-context/`), S-05 (`context/changes/workout-step-detail/`)
- Persistence template (flat column): `training_arc_note` across `workout-selections.ts`, `select.ts`, `database.ts`, `types.ts`
- Flag inputs: `buildUserContext` recovery block (`recommendations.ts:125-131`), `GarminBodyBattery` (`types.ts`)
- Hard-option detection: `WorkoutAlternative.steps` / `WorkoutEffort` (S-05, `types.ts`)
- Render sites: `src/components/recommendations/RecommendationResults.tsx`, `src/components/recommendations/RecommendationSection.tsx`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Data model & migration

#### Automated

- [x] 1.1 Type checking passes: `npm run build` — 7710a62
- [x] 1.2 Linting passes: `npm run lint` — 7710a62
- [x] 1.3 `npx astro check`: only the 2 known not-yet-wired errors remain (recommendations.ts mapping, select.ts) — full green deferred to Phase 3 (adapted) — 7710a62

#### Manual

- [x] 1.4 Migration applies cleanly to local Supabase; `recovery_warning` exists as nullable TEXT — 7710a62

### Phase 2: AI contract, flag & fallback

#### Automated

- [x] 2.1 Type checking passes: `npm run build` — a85fc66
- [x] 2.2 Linting passes: `npm run lint` — a85fc66
- [x] 2.3 `npx astro check`: only the 1 known select.ts error remains (mapping now populates recovery_warning) — full green deferred to Phase 3 (adapted) — a85fc66
- [x] 2.4 Existing tests still pass: `npm run test` — a85fc66

#### Manual

- [x] 2.5 `intensity=high` + body battery < 20 → `recovery_warning` on hard alternatives, null on lighter ones — a85fc66
- [x] 2.6 `intensity=normal` / body battery ≥ 20 / recovery missing → `recovery_warning: null` everywhere — a85fc66
- [x] 2.7 Hard option with no model warning under a set flag gets the static fallback — a85fc66
- [x] 2.8 `evt:"recommendation"` log emits `recoveryConflict`; no extra re-prompts caused by this field — a85fc66

### Phase 3: Persistence

#### Automated

- [x] 3.1 Type checking passes: `npm run build` — 3a1cbda
- [x] 3.2 Linting passes: `npm run lint` — 3a1cbda
- [x] 3.3 No type errors in `src/`: `npx astro check` — 3a1cbda

#### Manual

- [x] 3.4 Committing a hard alternative under a set flag persists non-null `recovery_warning` — 3a1cbda
- [x] 3.5 Committing a lighter alternative / no flag persists `recovery_warning = null` — 3a1cbda
- [x] 3.6 Reloading returns the committed selection with `recovery_warning` as saved — 3a1cbda

### Phase 4: Render (amber caution line)

#### Automated

- [x] 4.1 Type checking passes: `npm run build`
- [x] 4.2 Linting passes: `npm run lint`
- [x] 4.3 No type errors in `src/`: `npx astro check`

#### Manual

- [x] 4.4 Hard alternative under a set flag shows the amber caution; lighter ones don't; no flag → none
- [x] 4.5 After committing a hard option and reloading, the committed block shows the caution
- [x] 4.6 Committed selection with null `recovery_warning` renders cleanly
- [x] 4.7 No regression to the S-03/S-04/S-05 modifier → results → commit → reload flow
