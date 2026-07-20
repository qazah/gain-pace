# Training Arc Context per AI Recommendation Implementation Plan

## Overview

Roadmap slice **S-04** (`training-arc-context`, PRD FR-006, US-01). Extend the existing single S-03 Claude Haiku call so each of the 3 workout alternatives carries a **training-arc note** — a one-line, long-term-trajectory sentence explaining how today's choice affects the runner's progress toward their defined race goal. This is the last piece of the north-star Stream A loop: S-03 gives the runner three plausible options for *today*; S-04 tells them what each option means for the *arc* to race day.

S-03 was deliberately built with this slice in mind, so the type field, DB column, and persistence path already exist and are reserved. This plan fills the two gaps S-03 left open: (1) actually asking the model for the note and (2) displaying it — while tightening the prompt so the note doesn't duplicate the existing today's-fit explanation.

## Current State Analysis

The S-04 wiring is **pre-built** across the S-03 codebase; only the model contract and the UI are missing.

**Already present (reserved in S-03, needs no change or only a one-line change):**

- `WorkoutAlternative.training_arc_note: string | null` — the DTO field exists (`src/types.ts:37`, comment "Reserved for S-04").
- `workout_selections.training_arc_note TEXT` — the DB column exists and is nullable (`supabase/migrations/20260604000001_create_domain_tables.sql:73`). **No migration needed.**
- `saveSelection` already persists `input.alternative.training_arc_note` (`src/lib/services/workout-selections.ts:61`, comment "null in S-03").
- `generateRecommendation` already builds each alternative with `training_arc_note` — but hardcoded to `null` (`src/lib/services/recommendations.ts:238`, comment "reserved for S-04").
- The generated database types include the column (Supabase `Database` type is the source for both services).

**Missing (this plan adds):**

- The **structured-output JSON schema** and the **Zod response parse** in `src/lib/recommendation-guardrail.ts:21-53` do not include `training_arc_note`, so the model is never asked for it and it would be dropped by the parse even if returned.
- The **system prompt** (`src/lib/services/recommendations.ts:98-104`) requests only `workout_type`, `duration_minutes`, `ai_explanation`. It also currently tells the model that `ai_explanation` may reference "race-goal proximity" — which overlaps with what the arc note should own.
- **Two render sites** never show the note:
  - `src/components/recommendations/RecommendationResults.tsx` — the `Card` renders type, duration, `ai_explanation` only (line 45).
  - `src/components/recommendations/RecommendationSection.tsx:106-116` — the returning-user "Committed" block renders `today.ai_explanation` only.

**Constraints discovered:**

- The Anthropic call uses `output_config.format.type: "json_schema"` (`recommendations.ts:200`). Per the guardrail file's own note (line 19-20), structured outputs don't support array-length/numeric constraints — those live in Zod. A **field's presence** is controlled by the JSON schema `required` array; leaving a field out of `required` lets the model legitimately omit it (this is the mechanism for graceful degrade).
- The plausible-load guardrail (`validateAlternatives`) only inspects `duration_minutes`; it is untouched by this change.
- Repo now has a real test runner: `npm run test` → `vitest run`. `src/lib/recommendation-guardrail.test.ts` already exercises `parseRecommendation`; the new field must not break those cases.
- Islands must be verified via `npm run preview`, **not** `npm run dev` (project memory: `astro dev` double-bundles React and breaks island hydration).

## Desired End State

On `/dashboard`, a runner who generates recommendations sees, under each of the 3 alternatives, a distinct labeled line (icon + muted text) describing how that choice affects their long-term arc toward the race goal — clearly separate from the existing today's-fit explanation. The same note appears under the returning-user "Committed" block when a stored selection has one. Selections made after this ships persist the note; older S-03 selections (null note) simply render without the line. If the model omits the note for an alternative, that alternative still shows — just without the arc line — and the recommendation never fails over a missing note.

**Verification:** `POST /api/recommendations` returns alternatives whose `training_arc_note` is a non-empty, trajectory-focused string (visible in the response JSON and server logs); the dashboard renders the labeled line in both sites; `npm run test`, `npm run lint`, and `npm run build` all pass.

### Key Discoveries:

- S-03 reserved the full persistence path for S-04 — type field (`src/types.ts:37`), nullable DB column (`migrations/20260604000001_create_domain_tables.sql:73`), and write path (`workout-selections.ts:61`) — so **no schema/DB migration is required** (this is the low-risk path the roadmap flagged as conditional on S-03's schema design).
- The service already emits the field, hardcoded null (`recommendations.ts:238`) — the backend change is essentially "stop hardcoding null; parse it from the model."
- Two distinct render sites need the note (`RecommendationResults.tsx`, `RecommendationSection.tsx:106-116`), and null back-compat matters because S-03 rows already exist with a null note.
- Field presence for structured output is governed by the JSON schema `required` array; omitting `training_arc_note` from `required` is what makes graceful degrade work at the schema level.

## What We're NOT Doing

- **No DB migration** — the `training_arc_note` column already exists.
- **No change to the plausible-load guardrail** (`validateAlternatives` / duration band) — the arc note is text, not load.
- **No new unit tests / LLM eval harness** — testing is manual + lint/build + keeping the existing guardrail test green (per the LOW-slice decision; S-03 deferred a mocked-LLM/eval harness and this slice keeps that boundary).
- **No hard failure on a missing note** — a missing/empty note never triggers a re-prompt or fails the recommendation (that severity is reserved for implausible load).
- **No change to selection persistence logic, the API routes' error taxonomy, the daily cap, or the modifier form.**
- **No backfill** of arc notes onto historical S-03 `workout_selections` rows.
- **No separate "arc" section or timeline visualization** — a single labeled line per alternative, per PRD FR-006 ("a one-liner").

## Implementation Approach

Two phases, backend contract first so the note can be verified in the raw API response before any UI depends on it.

**Phase 1 (backend contract & service):** Add `training_arc_note` to the structured-output schema's `properties` **but not** its `required` array (graceful degrade), and to the Zod parse as an optional/nullable string normalized so empty/whitespace becomes `null`. Rewrite the system prompt to split the two timescales cleanly: `ai_explanation` = why this fits *today* (recovery + available time + feeling); `training_arc_note` = how this choice moves the runner along their *long-term arc* to the race (cumulative build/recovery, weeks-to-race framing) — with no numbers/jargon, matching the existing explanation style. In the service, map the parsed note into the alternative instead of the hardcoded `null`.

**Phase 2 (display):** Render the note as a distinct labeled line (a small lucide icon such as `TrendingUp`/`Target` + muted text), in the alternative `Card` and the committed block, rendering nothing when the value is `null`. Reuse the existing card typography/icon conventions.

## Critical Implementation Details

- **Schema `required` vs graceful degrade:** `training_arc_note` goes in the JSON schema `properties` only, **not** in `required` (`recommendation-guardrail.ts:24,31`). Keeping it out of `required` is what lets the model omit it without the structured-output call erroring — the mechanism the "graceful degrade" decision depends on. The Zod schema must therefore also treat it as optional/nullable, and normalize empty/whitespace-only strings to `null` so a blank note renders as "no note" rather than an empty labeled line.
- **Prompt must move goal-proximity out of `ai_explanation`:** the current prompt (line 102) allows `ai_explanation` to reference "race-goal proximity," which is exactly the arc note's job. Failing to move it is the redundancy failure mode — the two lines will echo each other. `ai_explanation` should be re-scoped to today's readiness/time/feeling only.

## Phase 1: AI contract & service (backend)

### Overview

Make the single Claude call produce a per-alternative `training_arc_note`, parse it leniently (graceful degrade), and carry it through the service. The two timescales (`ai_explanation` = today, `training_arc_note` = the arc) are separated in the prompt so they don't duplicate.

### Changes Required:

#### 1. Structured-output schema + Zod parse

**File**: `src/lib/recommendation-guardrail.ts`

**Intent**: Teach the model contract and the response parse about the new field, in a way that allows the model to omit it without failing (graceful degrade), and that normalizes an empty note to `null`.

**Contract**: In `RECOMMENDATION_JSON_SCHEMA`, add `training_arc_note: { type: "string" }` to each alternative's `properties` (lines 32-36). **Do not** add it to that object's `required` array (line 31) — omission must be legal. In `recommendationResponseSchema`, add `training_arc_note` to the per-alternative object (lines 46-50) as an optional, nullable string that transforms empty/whitespace to `null` (e.g. `z.string().trim().nullish().transform((v) => v || null)` or equivalent) so `ParsedRecommendation` exposes `training_arc_note: string | null`. The existing `.length(3)` and other fields are unchanged. Keep the module framework-free (no new imports beyond `astro/zod`).

#### 2. System prompt — split the two timescales

**File**: `src/lib/services/recommendations.ts`

**Intent**: Ask for the arc note explicitly and re-scope the two explanation fields so `ai_explanation` owns *today's fit* and `training_arc_note` owns the *long-term trajectory* toward the race — preventing the two lines from reading as duplicates.

**Contract**: Edit `SYSTEM_PROMPT` (lines 98-104). Re-scope the `ai_explanation` sentence (line 102) to today's readiness only (recovery state, available time, feeling) — remove the "race-goal proximity" clause. Add an instruction that each alternative also include a `training_arc_note`: one plain-language sentence (no jargon, no raw numbers, same voice as `ai_explanation`) about how choosing this option affects the runner's long-term progress toward their race goal — framed on the arc/weeks-to-race timescale (e.g., building endurance base, banking recovery to repay later, staying on pace for the goal), not today's fit. Note that `days_to_race` and goal fields are already in the user context (`buildUserContext`, lines 124-130), so no context change is needed.

#### 3. Map the parsed note into the alternative

**File**: `src/lib/services/recommendations.ts`

**Intent**: Stop hardcoding `null`; carry the model's note through to the result (and thus to persistence and the API response).

**Contract**: In the alternatives `.map(...)` (lines 233-239), replace `training_arc_note: null` with the parsed value `alt.training_arc_note` (which is `string | null` after the Zod normalization from change #1). No other field in the mapping changes. The downstream persistence (`workout-selections.ts:61`) and API response already carry the field unchanged.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run build` (Astro `astro build` runs `astro check`-level type checks; also covers `astro sync`)
- Linting passes: `npm run lint`
- Existing tests still pass: `npm run test` (the guardrail test's `parseRecommendation` cases must remain green with the new optional field)

#### Manual Verification:

- `POST /api/recommendations` (via the dashboard, `npm run preview`) returns 3 alternatives each with a non-empty `training_arc_note` string in the JSON.
- The arc notes are about long-term trajectory (weeks-to-race / cumulative progress), and read as distinct from the `ai_explanation` today's-fit sentences (no duplicated goal-proximity phrasing).
- Server log line (`evt: "recommendation"`, via `wrangler tail` / preview console) still emits and the call stays within the ~10s budget.
- Committing an alternative persists a non-null `training_arc_note` to `workout_selections` (spot-check via Supabase).
- A run where the model omits the note (or returns empty) still returns a valid recommendation (no failure/re-prompt over the missing note).

**Implementation Note**: After Phase 1 automated verification passes, pause for manual confirmation that the notes are present and trajectory-distinct before wiring the UI. Phase blocks use plain bullets — the `- [ ]` checkboxes live in `## Progress`.

---

## Phase 2: Display (frontend)

### Overview

Surface the arc note as a distinct labeled line in the two places a workout is shown: the 3 alternative cards and the returning-user committed block. Render nothing when the note is `null` (graceful degrade + back-compat with older S-03 selections).

### Changes Required:

#### 1. Alternative card — labeled arc line

**File**: `src/components/recommendations/RecommendationResults.tsx`

**Intent**: Show each alternative's arc note under its today's-fit explanation as a visually distinct, labeled line so the runner can read the long-term angle at choice time.

**Contract**: In the `Card` component, after the `ai_explanation` paragraph (line 45), conditionally render `alt.training_arc_note` when non-null: a distinct line using a small lucide icon (e.g. `TrendingUp` or `Target`) + muted text, styled consistently with the existing card conventions (`text-xs`, `text-blue-100/60`-family, `Clock`-line pattern). Render nothing when `training_arc_note` is `null`. No prop or type changes needed (`WorkoutAlternative` already carries the field).

#### 2. Committed block — labeled arc line

**File**: `src/components/recommendations/RecommendationSection.tsx`

**Intent**: Give a returning runner the same long-term context under their already-committed workout.

**Contract**: In the idle "Committed" block (lines 106-116), after the `today.ai_explanation` paragraph (line 113), conditionally render `today.training_arc_note` when non-null, using the same labeled-line treatment as change #1. `today` is a `WorkoutSelection` DB row, whose `training_arc_note` is `string | null`; older rows are null and render nothing.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run build`
- Linting passes: `npm run lint`

#### Manual Verification:

- On `/dashboard` (via `npm run preview`), each of the 3 alternative cards shows the arc note as a distinct labeled line beneath the explanation, visually separable from it.
- After committing, reloading the dashboard shows the arc note under the "Committed" block.
- An alternative whose note is `null` (or an older committed selection) renders cleanly with no empty label/icon.
- No regression to the S-03 flow: modifier → skeleton → results → commit → reload still works end to end in ≤3 actions.

**Implementation Note**: Verify via `npm run preview` (not `npm run dev`) per the project's React-dedup gotcha.

---

## Testing Strategy

### Unit Tests:

- No new unit tests (LOW-slice decision). Constraint: the existing `src/lib/recommendation-guardrail.test.ts` `parseRecommendation` cases must remain green after the new optional field is added.

### Integration Tests:

- None automated. The end-to-end flow is covered by manual verification.

### Manual Testing Steps:

1. `npm run preview`, sign in as a user with an active race goal and a connected Garmin account.
2. Set modifiers and generate — confirm 3 alternatives, each with a distinct arc-note line about long-term trajectory (not a restatement of the today's-fit explanation).
3. Inspect the `POST /api/recommendations` response JSON — confirm `training_arc_note` is a non-empty string per alternative.
4. Commit an alternative; reload — confirm the committed block shows its arc note.
5. Confirm an older/committed selection with a null note (or a forced-empty note) renders with no empty label.
6. Confirm `npm run test`, `npm run lint`, `npm run build` all pass.

## Performance Considerations

Negligible. One extra short string per alternative adds a handful of output tokens; `MAX_TOKENS` (2048) and the ~9s timeout are unchanged and comfortably sufficient. No extra model calls (the note is produced in the same single call), no extra DB round-trips (persistence path already carries the field).

## Migration Notes

None. The `training_arc_note` column already exists (nullable); pre-existing S-03 `workout_selections` rows keep their `null` note and render without the arc line. No backfill.

## References

- Roadmap slice: `context/foundation/roadmap.md` (S-04, lines 117-127)
- PRD requirement: `context/foundation/prd.md` FR-006 (line 82), the one-liner intent (line 36)
- Predecessor plan: `context/archive/2026-07-14-modifier-to-recommendation-loop/plan.md` and `plan-brief.md` (row "S-04 arc note")
- Reserved field: `src/types.ts:37`; DB column: `supabase/migrations/20260604000001_create_domain_tables.sql:73`
- Service (hardcoded null today): `src/lib/services/recommendations.ts:238`; contract/parse: `src/lib/recommendation-guardrail.ts:21-53`
- Render sites: `src/components/recommendations/RecommendationResults.tsx:45`; `src/components/recommendations/RecommendationSection.tsx:106-116`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: AI contract & service (backend)

#### Automated

- [x] 1.1 Type checking passes: `npm run build` — 6f6d009
- [x] 1.2 Linting passes: `npm run lint` — 6f6d009
- [x] 1.3 Existing tests still pass: `npm run test` — 6f6d009

#### Manual

- [x] 1.4 `POST /api/recommendations` returns 3 alternatives each with a non-empty `training_arc_note` — 6f6d009
- [x] 1.5 Arc notes are trajectory-focused and distinct from the `ai_explanation` today's-fit sentences — 6f6d009
- [x] 1.6 Recommendation log still emits and the call stays within the ~10s budget — 6f6d009
- [x] 1.7 Committing persists a non-null `training_arc_note` to `workout_selections` — 6f6d009
- [x] 1.8 A run with an omitted/empty note still returns a valid recommendation (no failure/re-prompt) — 6f6d009

### Phase 2: Display (frontend)

#### Automated

- [x] 2.1 Type checking passes: `npm run build` — 20d8647
- [x] 2.2 Linting passes: `npm run lint` — 20d8647

#### Manual

- [x] 2.3 Each alternative card shows the arc note as a distinct labeled line beneath the explanation — 20d8647
- [x] 2.4 After committing and reloading, the committed block shows the arc note — 20d8647
- [x] 2.5 A null-note alternative / older committed selection renders cleanly with no empty label — 20d8647
- [x] 2.6 No regression to the S-03 modifier → skeleton → results → commit → reload flow (≤3 actions) — 20d8647
