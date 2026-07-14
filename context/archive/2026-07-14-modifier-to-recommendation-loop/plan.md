# Modifier → AI Recommendation Loop → Selection Implementation Plan

## Overview

Build S-03, the core product loop. On a gated modifier screen the runner sets Time available / Intensity / Feeling; the app makes **one Claude Haiku 4.5 structured-output call** fusing their Garmin recovery + last-4 activities + active race goal + modifiers; it returns a **primary workout card + 2 "if you prefer" alternatives**, each with a plain-language explanation; the runner **selects one**, persisted to `workout_selections`. A plausible-load guardrail defends the PRD's hard-regression (never recommend an implausible volume/intensity vs the last 3–4 activities).

## Current State Analysis

- **All upstream data exists.** `getDashboardData(supabase, userId, date?)` → `{connected, recovery, activities[], scheduledWorkout, stale, reconnectRequired?}` (`src/lib/services/garmin.ts:301`); `getActiveRaceGoal(supabase, userId)` → `RaceGoal | null` (`src/lib/services/race-goals.ts`). Output target `workout_selections` is **unused** (columns at `src/types/database.ts:105`; `alternative_rank` ∈ {primary,alt_1,alt_2}; `training_arc_note` nullable, reserved for S-04; `garmin_data_snapshot` JSONB; modifier_* columns present).
- **No LLM anywhere.** No SDK, no `ANTHROPIC_API_KEY`, no provider client. The infra research *assumed* Anthropic and floated `ANTHROPIC_API_KEY` (`context/foundation/infrastructure.md:61,102`) but nothing is wired. This slice introduces the first LLM integration and the **first Zod validation of a response** (all prior Zod validates requests).
- **Reusable patterns:** the `callSidecar` outbound-HTTP template (AbortController + hard timeout + typed `NotConfigured`/`Error` taxonomy, `garmin.ts:69-107`); config-status entry + banner (`src/lib/config-status.ts:17`, `src/layouts/Layout.astro`); env-secret declaration (`astro.config.mjs:17`); the hook→section→API-route→service island chain (Garmin + RaceGoal precedents); the S-02 shared framework-free validation module (`src/lib/race-goal-validation.ts`).
- **Two hard constraints:** 10s p95 on the call (>2s must show continuous progress); Free-tier **10ms CPU** cap — the LLM await is ~0 CPU but heavy Zod validation can exceed it (`infrastructure.md:61`), so keep response validation lean.

### Key Discoveries:

- Claude Haiku 4.5 (`claude-haiku-4-5`, 200K ctx, ~$1/$5 per 1M tokens) **supports native structured outputs** (`output_config.format`) — a schema-guaranteed response, which directly serves the guardrail.
- `@anthropic-ai/sdk` runs on the Cloudflare workerd runtime; the SDK's `max_retries` (default 2) already handles transient 429/5xx, so we don't hand-roll transient retries — the guardrail's one bounded retry is a *semantic* re-prompt, separate from transport retries.
- `workout_selections.training_arc_note` already exists and is nullable → S-04 needs no migration if S-03 leaves the field null.
- No `recommendation_usage` table exists → the soft daily cap needs a small new table.

## Desired End State

On `/dashboard`, a runner with an active goal + connected Garmin sees a modifier screen. Setting modifiers and requesting alternatives shows skeleton cards, then a primary recommendation + 2 alternatives (each: workout type, duration, plain-language explanation referencing recovery/goal). Selecting one commits it (persisted as today's single `workout_selections` row). Implausible AI output never reaches the runner. Missing prerequisites show a clear CTA instead of calling the AI. The whole modifier→recommendation→selection flow is ≤3 actions on the modifier screen.

**Verification:** `npx astro sync && npm run lint && npm run build && npm test` pass; the manual walkthrough (gate → modifiers → skeleton → 3 cards → select → committed; guardrail rejects implausible load; degrade on missing recovery; rate-limit after the cap) behaves as specified, verified via `npm run preview`.

## What We're NOT Doing

- **No training-arc note generation** — the response schema and `training_arc_note` column are kept ready, but S-03 leaves the field null. Generating/displaying it is **S-04** (FR-006).
- **No .fit write-back / push to watch** — selection is informational (PRD Non-Goal).
- **No streaming reveal** — the guardrail requires validating the full structured response before showing any workout.
- **No canned/rule-based fallback workout** — on unrecoverable AI failure or a double guardrail violation, show an error + Retry; never fabricate a workout.
- **No goal history / multi-goal** — reads the single active goal (from S-02).
- **No new AI-eval or mocked-LLM harness** — testing covers the pure guardrail/validation logic; the live call + prompt quality are verified manually.
- **No dashboard for past selections** — persist only; a history view is out of scope.

## Implementation Approach

Three phases: AI core → selection persistence → frontend, mirroring the established slice shape but front-loading the risk. The recommendation service orchestrates: load Garmin data + active goal (existing services) → check the daily cap → build a prompt (frozen cacheable system + volatile user turn) → call Claude with a JSON-schema structured output → parse with `astro/zod` → run the framework-free plausible-load guardrail → on violation, one bounded re-prompt with the violation named → on second violation or any transport/parse failure, throw a typed error the route maps to a friendly error. The guardrail lives in its own framework-free module so it is unit-testable without network. Selection persistence follows S-02's edit-in-place discipline (check-then-insert/update; no unique-index transaction trap). The frontend is a `client:load` island that gates on prerequisites, drives the modifier form, shows skeleton cards during the call, renders the 3 alternatives, and commits a selection.

## Critical Implementation Details

- **Guardrail = defense in depth, and a double-violation is a failure, not a fabrication.** Order: schema-validate → compute a plausible-load band from the last 3–4 activities → check each alternative's duration/implied volume against the band → if any violate, re-prompt once with the specific violation called out → if the retry still violates (or the model refuses / errors / times out), throw `LlmError`; the route returns a friendly error + Retry. This reconciles the two answers given during planning: the guardrail's "fall back to a safe default" phrasing is **superseded** by the explicit "no fabricated workout" decision.
- **Latency budget.** Set the Anthropic client's per-request timeout to ~9s (SDK timeout unit is **ms** in TS) so a hung call fails before the 10s p95 ceiling; the guardrail retry is a *second* call, so log both and treat the sum against the budget. `max_tokens` ~2048 (the structured output is small); non-streaming is fine under the ~16K streaming threshold.
- **Free-tier 10ms CPU.** Keep the Zod response schema and guardrail math lean (parse one small object + a handful of numeric comparisons) — a heavy validation cycle can blow the CPU cap (`infrastructure.md:61`). Do not add elaborate per-field refinements.
- **Prompt caching.** Freeze the system prompt (coaching rules + output contract + guardrail instructions) and put all volatile context (recovery, activities, goal, modifiers) in the user turn, so the system prefix caches across calls.
- **New dependency.** `@anthropic-ai/sdk` — verify it builds under `wrangler`/workerd (the infra doc requires testing each new npm dep in the workerd runtime before merge).

## Phase 1: AI core — config, guardrail, service, generate API

### Overview

Everything needed to turn modifiers into a validated set of recommendations, verifiable via curl before any UI exists.

### Changes Required:

#### 1. Anthropic secret + config surface

**Files**: `astro.config.mjs`, `src/lib/config-status.ts`, `.env.example`, `.dev.vars`

**Intent**: Register `ANTHROPIC_API_KEY` as a server secret and surface a config banner when it's missing, following the Supabase/Garmin pattern.

**Contract**: Add `ANTHROPIC_API_KEY: envField.string({ context: "server", access: "secret", optional: true })` to `env.schema`; add a `configStatuses` entry `{ name: "AI recommendations", configured: Boolean(ANTHROPIC_API_KEY), message: <PL message> }`; add the raw var to `.env.example` and `.dev.vars`. Consume via `import { ANTHROPIC_API_KEY } from "astro:env/server"`.

#### 2. Daily-cap table

**File**: `supabase/migrations/<timestamp>_create_recommendation_usage.sql` (new)

**Intent**: Track per-user daily generation counts for the soft cap.

**Contract**: `recommendation_usage(id uuid pk, user_id uuid fk auth.users on delete cascade, day date not null default current_date, count int not null default 0, created_at, updated_at)` with `UNIQUE (user_id, day)`. RLS enabled, 4 per-op policies scoped to `auth.uid() = user_id`, `REVOKE ALL … FROM anon`, and `GRANT … TO authenticated` (mirror the F-01 + grant migrations exactly — the missing-grant gotcha is documented in `20260713000001_grant_domain_tables_to_authenticated.sql`). Regenerate types (`npx supabase gen types`) and export `RecommendationUsage` from `src/types.ts`.

#### 3. Request/response DTOs

**File**: `src/types.ts`

**Intent**: Shared types for modifiers, a recommendation alternative, and the generation result.

**Contract**: Export `WorkoutModifiers { time_available_minutes: number; intensity: "low"|"normal"|"high"; feeling: "tired"|"normal"|"energized" }`; `WorkoutAlternative { rank: "primary"|"alt_1"|"alt_2"; workout_type: string; duration_minutes: number; ai_explanation: string; training_arc_note: string | null }` (arc null in S-03); `RecommendationResult { alternatives: WorkoutAlternative[]; recoveryMissing: boolean; stale: boolean; context: { modifiers: WorkoutModifiers; race_goal_id: string; garmin_data_snapshot: unknown } }` (context is echoed back on select to avoid a second Garmin fetch).

#### 4. Guardrail / validation module

**File**: `src/lib/recommendation-guardrail.ts` (new)

**Intent**: Framework-free, unit-testable plausible-load guardrail + response-shape parsing constants. No SDK, no `astro:*`.

**Contract**: Export the plausible-load constants (e.g. duration band derived from recent-activity median plus absolute sane caps) and `validateAlternatives(alternatives, recentActivities): { ok: boolean; violations: string[] }` — a pure function returning which alternatives (if any) fall outside the band. Also export a small helper to derive the band from `GarminActivity[]`. This is the module Phase 1 unit-tests.

#### 5. Recommendations service

**File**: `src/lib/services/recommendations.ts` (new)

**Intent**: Orchestrate the LLM call end-to-end with the guardrail, daily cap, and structured logging. Mirrors the `garmin.ts` typed-error discipline.

**Contract**: `type TypedSupabase = SupabaseClient<Database>`. Export `class LlmNotConfiguredError` and `class LlmError`. Export `generateRecommendation(supabase, userId, modifiers): Promise<RecommendationResult>`:
1. Load Garmin dashboard data + active goal via the existing services; if not connected or no goal, throw a typed `RecommendationNotReadyError` carrying the reason (the route maps it, not a 500).
2. Enforce the soft daily cap against `recommendation_usage` (increment on a successful generation); over cap → throw `RecommendationRateLimitedError`.
3. Build messages (frozen system + volatile user turn) and call Claude `claude-haiku-4-5` via `@anthropic-ai/sdk` with `output_config.format` = the JSON schema for `{ alternatives: [...] }`, a ~9s timeout, `max_tokens` ~2048.
4. Parse with an `astro/zod` schema; run `validateAlternatives`; on violation re-prompt once naming the violation; on second violation throw `LlmError`.
5. Log latency + token usage + any guardrail violation/retry (structured `console` for `wrangler tail`).
6. Return `RecommendationResult` (with `recoveryMissing`/`stale` flags from the Garmin payload).

**Contract note (structured output)**: use `output_config: { format: { type: "json_schema", schema: {…, additionalProperties:false, required:[…]} } }` on `client.messages.create` — Haiku 4.5 supports it. Keep the schema minimal (3 alternatives, the fields above; `training_arc_note` optional/nullable for S-04).

#### 6. Generate API route

**File**: `src/pages/api/recommendations/index.ts` (new)

**Intent**: `POST` — validate modifiers, call the service, map typed errors to stable JSON statuses.

**Contract**: Local `json()` helper; `locals.user` 401 guard; `createClient` 503 guard; `astro/zod` `safeParse` of the modifiers body (400 on shape failure). Call `generateRecommendation`; return `{ status: "ok", result }`. Catch: `RecommendationNotReadyError` → 200 `{ status: "not_ready", reason: "goal"|"garmin" }`; `RecommendationRateLimitedError` → 429 `{ status: "rate_limited" }`; `LlmNotConfiguredError` → 503; `LlmError` → 502 `{ status: "llm_error" }`.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly: `npx supabase migration up` (or `db reset`)
- Types regenerate: `npx astro sync`
- Unit tests pass (guardrail/validation): `npm test`
- Linting passes: `npm run lint`
- Production build passes (incl. `@anthropic-ai/sdk` under workerd): `npm run build`

#### Manual Verification:

- `POST /api/recommendations` with valid modifiers (connected + goal set) returns a primary + 2 alternatives, each with type, duration, and an explanation referencing recovery/goal.
- Guardrail: an implausible model output is never returned — a violation triggers one re-prompt, and a persistent violation returns `{ status: "llm_error" }` (no fabricated workout).
- Prereqs: no active goal → `{ status: "not_ready", reason: "goal" }`; not connected → `reason: "garmin"`; connected but no recovery today → still returns a recommendation with `recoveryMissing: true`.
- Soft cap: after the configured number of generations in a day → `{ status: "rate_limited" }` (429).
- Unauthenticated → 401.
- `wrangler tail` shows per-call latency + token usage; latency is within the 10s budget.

**Implementation Note**: After Phase 1 automated verification passes, pause for manual confirmation of the generate endpoint before Phase 2.

---

## Phase 2: Selection persistence — service + API

### Overview

Persist the runner's chosen alternative and expose today's committed selection.

### Changes Required:

#### 1. Workout-selection service

**File**: `src/lib/services/workout-selections.ts` (new)

**Intent**: Read today's selection and save one (edit-in-place per day), following S-02's no-transaction discipline.

**Contract**: Export `WorkoutSelectionError`; `getTodaySelection(supabase, userId): Promise<WorkoutSelection | null>` (`.eq("user_id",…).eq("selected_date", today).maybeSingle()`); `saveSelection(supabase, userId, input): Promise<WorkoutSelection>` where `input` carries the chosen `alternative_rank`, `workout_type`, `duration_minutes`, `ai_explanation`, `training_arc_note` (null), the three `modifier_*` values, `race_goal_id`, and `garmin_data_snapshot`. Check for today's row; update in place if present, else insert. `training_arc_note` stays null. Check `{ error }`, throw the typed error.

#### 2. Selection API route

**File**: `src/pages/api/recommendations/select.ts` (new)

**Intent**: `GET` today's selection; `POST` to persist a chosen alternative.

**Contract**: `GET` — guards; return `{ selection: WorkoutSelection | null }` from `getTodaySelection`. `POST` — guards; `astro/zod` `safeParse` of `{ rank, context }` (the chosen rank plus the `context` echoed from the generate response: modifiers, race_goal_id, garmin_data_snapshot) plus the chosen alternative's fields; call `saveSelection`; return `{ status: "ok", selection }`. Catch `WorkoutSelectionError` → 502.

### Success Criteria:

#### Automated Verification:

- Types regenerate: `npx astro sync`
- Linting passes: `npm run lint`
- Production build passes: `npm run build`

#### Manual Verification:

- `POST /api/recommendations/select` persists the chosen alternative as today's single `workout_selections` row; selecting again updates the same row (one row/day — verify in Supabase).
- `GET /api/recommendations/select` returns today's selection (or `null` before any pick).
- Unauthenticated → 401.

**Implementation Note**: After Phase 2 automated verification passes, pause for manual confirmation before Phase 3.

---

## Phase 3: Frontend — modifier → recommendation → selection island

### Overview

The `client:load` island that gates on prerequisites, drives the modifier form, shows progress, renders alternatives, and commits a selection.

### Changes Required:

#### 1. Data hook

**File**: `src/components/hooks/useRecommendation.ts` (new)

**Intent**: State machine + actions for the whole flow.

**Contract**: Expose a discriminated state (`loading` initial fetch of today's selection, `idle`/ready-to-generate, `generating`, `results`, `committed`, `error`, `not_ready` with reason, `rate_limited`), plus `generate(modifiers)`, `select(rank)`, and today's existing selection. `generate` POSTs `/api/recommendations` and branches on the JSON `status`; `select` POSTs `/api/recommendations/select` with the chosen rank + the result's `context`.

#### 2. Modifier form

**File**: `src/components/recommendations/ModifierForm.tsx` (new)

**Intent**: Capture the three modifiers within ≤3 actions.

**Contract**: Segmented 3-way button groups for Intensity (low/normal/high) and Feeling (tired/normal/energized); time as preset chips (30/45/60/90) + a custom minutes field. A single "Get today's options" submit calls `generate`. Compose `cn()` + `Button`; reuse the S-02 chip styling.

#### 3. Skeleton

**File**: `src/components/recommendations/RecommendationSkeleton.tsx` (new)

**Intent**: Continuous-progress UI for the 2–10s call (NFR).

**Contract**: Three shimmering placeholder cards + rotating status copy ("Reading your recovery…", "Weighing your goal…"). Pure presentational.

#### 4. Results

**File**: `src/components/recommendations/RecommendationResults.tsx` (new)

**Intent**: Render the primary + 2 alternatives and commit a selection.

**Contract**: Props `{ result: RecommendationResult; onSelect: (rank) => void; committedRank?: string }`. Primary card visually distinct (prominent); the 2 alternatives under an "if you prefer" heading. Each shows workout type, duration, and the explanation. A Select action per card calls `onSelect`. When a selection is committed, mark it. No delete.

#### 5. Section island + dashboard wiring

**Files**: `src/components/recommendations/RecommendationSection.tsx` (new), `src/pages/dashboard.astro`

**Intent**: `client:load` root that owns `useRecommendation` and switches states; wire it into the dashboard as the primary daily action.

**Contract**: States → loading spinner; `not_ready` → a card with a CTA pointing at the goal or Garmin section; `idle` → `ModifierForm`; `generating` → `RecommendationSkeleton`; `results` → `RecommendationResults`; `committed` → today's committed workout summary with a "Change / regenerate" affordance; `error` → error card + Retry; `rate_limited` → friendly "come back tomorrow" message. Add `<RecommendationSection client:load />` to `dashboard.astro` (hero position, above the goal/Garmin sections).

### Success Criteria:

#### Automated Verification:

- Types regenerate: `npx astro sync`
- Linting passes: `npm run lint`
- Production build passes: `npm run build`

#### Manual Verification (via `npm run preview`):

- Gating: with no goal or Garmin not connected, the section shows a CTA (not the form); after both are satisfied, the modifier form appears.
- Setting modifiers and submitting (≤3 actions) shows skeleton cards, then a primary + 2 alternatives; the primary is visually distinct.
- Selecting one commits it (today's single row in Supabase); the committed state renders.
- Regenerating with different modifiers works; after the daily cap, the friendly rate-limit message shows.
- An induced AI error shows the error + Retry (no fabricated workout).
- A day with no recovery data still recommends, with the reduced-confidence note.

**Implementation Note**: After Phase 3 automated verification passes, pause for the full manual walkthrough.

---

## Testing Strategy

### Unit Tests (Phase 1):

- `recommendation-guardrail.ts`: plausible-load band derivation from representative `GarminActivity[]`; `validateAlternatives` accepts in-band workouts and flags out-of-band ones (e.g. a 30 km run for a 5 km/week runner); empty/low activity history handled.
- Structured-output parsing: a well-formed model payload parses; a malformed one is rejected.

### Manual Testing Steps:

1. `npm run preview`, log in with an active goal + connected Garmin.
2. Set modifiers → verify skeleton → 3 cards with plausible workouts.
3. Select the primary → confirm one `workout_selections` row; re-select an alternative → same row updates.
4. Force an implausible scenario / inspect logs → confirm the guardrail blocks it and no implausible load ships.
5. Remove the goal → confirm the CTA gate. Regenerate past the cap → confirm the rate-limit message.

## Performance Considerations

One LLM call (+ at most one guardrail retry) per generation, p95 target 10s; ~9s client timeout. Small structured output (~2048 tokens). Keep Zod validation lean for the Free-tier 10ms CPU cap. Frozen system prompt enables prompt caching across calls.

## Migration Notes

One new migration: `recommendation_usage` (daily cap) with RLS + `authenticated` grant + `anon` revoke. `workout_selections` already exists; `training_arc_note` stays null for S-04. No change to existing tables.

## References

- Roadmap slice S-03: `context/foundation/roadmap.md:104`
- PRD FR-004/005/007, US-01, Guardrails: `context/foundation/prd.md:76`, `:33`, `:38`
- Infra AI notes (Anthropic assumed, 10ms CPU, latency): `context/foundation/infrastructure.md:61,101,102`
- Inputs: `src/lib/services/garmin.ts:301` (getDashboardData), `src/lib/services/race-goals.ts` (getActiveRaceGoal)
- Output schema: `src/types/database.ts:105` (workout_selections)
- Patterns to mirror: `src/lib/services/garmin.ts:69` (callSidecar/timeout/typed errors), `src/lib/race-goal-validation.ts` (framework-free validation), `src/pages/api/race-goals.ts` (JSON route), `src/components/hooks/useGarminData.ts` (hook), `src/pages/dashboard.astro` (island wiring)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: AI core — config, guardrail, service, generate API

#### Automated

- [x] 1.1 Migration applies cleanly: `npx supabase migration up` — 17d27cd
- [x] 1.2 Types regenerate: `npx astro sync` — 17d27cd
- [x] 1.3 Unit tests pass (guardrail/validation): `npm test` — 17d27cd
- [x] 1.4 Linting passes: `npm run lint` — 17d27cd
- [x] 1.5 Production build passes (incl. `@anthropic-ai/sdk` under workerd): `npm run build` — 17d27cd

#### Manual

- [x] 1.6 POST /api/recommendations returns a primary + 2 alternatives with explanations — 17d27cd
- [x] 1.7 Guardrail blocks implausible output (one re-prompt, then llm_error — no fabricated workout) — 17d27cd
- [x] 1.8 Prereqs: not_ready(goal) / not_ready(garmin); recoveryMissing degrade still recommends — 17d27cd
- [x] 1.9 Soft daily cap returns rate_limited (429) — 17d27cd
- [x] 1.10 Unauthenticated returns 401 — 17d27cd
- [x] 1.11 wrangler tail shows latency + token usage within the 10s budget — 17d27cd

### Phase 2: Selection persistence — service + API

#### Automated

- [x] 2.1 Types regenerate: `npx astro sync` — f259f0e
- [x] 2.2 Linting passes: `npm run lint` — f259f0e
- [x] 2.3 Production build passes: `npm run build` — f259f0e

#### Manual

- [x] 2.4 POST select persists the chosen alternative as today's single row; re-select updates the same row — f259f0e
- [x] 2.5 GET select returns today's selection (or null) — f259f0e
- [x] 2.6 Unauthenticated returns 401 — f259f0e

### Phase 3: Frontend — modifier → recommendation → selection island

#### Automated

- [x] 3.1 Types regenerate: `npx astro sync` — d5220b0
- [x] 3.2 Linting passes: `npm run lint` — d5220b0
- [x] 3.3 Production build passes: `npm run build` — d5220b0

#### Manual

- [x] 3.4 Gating: CTA when goal/Garmin missing; modifier form when both present — d5220b0
- [x] 3.5 Modifiers → skeleton → primary + 2 alternatives (primary visually distinct), within ≤3 actions — d5220b0
- [x] 3.6 Select commits today's single row; committed state renders — d5220b0
- [x] 3.7 Regenerate works; past the cap shows the friendly rate-limit message — d5220b0
- [x] 3.8 Induced AI error shows error + Retry (no fabricated workout) — d5220b0
- [x] 3.9 No-recovery day still recommends with the reduced-confidence note — d5220b0
