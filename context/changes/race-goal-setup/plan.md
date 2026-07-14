# Race Goal Setup Implementation Plan

## Overview

Build the S-02 race-goal CRUD vertical slice: a logged-in runner can define and edit a single long-term race goal (event name, date, distance, target finish time), persisted to the existing `race_goals` table and retrievable as AI context for S-03. The slice follows the S-01 "garmin-connect-and-fetch" vertical-slice pattern end to end — shared validation → DI service → JSON API route → `client:load` dashboard island.

## Current State Analysis

- **Data model already exists.** `race_goals` was created by F-01 (`supabase/migrations/20260604000001_create_domain_tables.sql:9`): columns `id, user_id, event_name, event_date DATE, distance_km NUMERIC(6,2) CHECK >0, target_finish_seconds INT CHECK >0, is_active BOOL default TRUE, created_at, updated_at`. RLS is enabled per-user (4 policies), the `anon` role is revoked, and `authenticated` was granted SELECT/INSERT/UPDATE/DELETE by `20260713000001_grant_domain_tables_to_authenticated.sql`. **No migration is needed for this slice.**
- **`RaceGoal` Row type already exported** at `src/types.ts:3`; generated table types (Row/Insert/Update, plus `TablesInsert<"race_goals">`) live in `src/types/database.ts:68`.
- **Partial unique index gotcha.** `race_goals_one_active_per_user` (`...:25`) is a partial unique index on `user_id WHERE is_active = TRUE`. The domain-schema plan-brief flags that inserting a second active row without first deactivating the old one throws a runtime constraint error. **This plan's edit-in-place design sidesteps the index entirely** (see Implementation Approach).
- **S-01 established the copyable pattern** (see `context/changes/race-goal-setup/` research summary in Notes / the S-01 archive):
  - API routes: named `APIRoute` exports, `if (!context.locals.user) return json(..., 401)`, `const supabase = createClient(context.request.headers, context.cookies)` then 503 null-check, Zod from `astro/zod` via `body.safeParse(await request.json().catch(() => null))`, a local `json()` helper, and a discriminated `{ status }` response.
  - Service: `src/lib/services/garmin.ts` — functions take `(supabase: TypedSupabase, userId, input)`, scope every query with `.eq("user_id", userId)`, use `.maybeSingle()`, check `{ error }` and throw a typed error class.
  - Island: `dashboard.astro:34` renders `<GarminSection client:load />` with no props; the island self-fetches via a `{data, loading, error}` hook (`src/components/hooks/useGarminData.ts`) and switches loading / error / connect / dashboard views. Forms use plain `useState` + `pending` + `error`, `fetch` branching on the JSON `status`, `pending` reset in `finally`.
  - Reusable UI: `src/components/auth/FormField.tsx` (controlled `value`/`onChange`, label, icon, `error`/`hint`), `src/components/ui/button.tsx` (shadcn), `cn()` at `src/lib/utils.ts:4`, lucide-react icons, glassmorphism Tailwind.

### Key Discoveries:

- No new migration required — `race_goals` + grants + RLS are all live.
- `RaceGoal` type exists (`src/types.ts:3`); add only a request DTO.
- Edit-in-place (one row, always UPDATE) means the partial unique index never fires.
- Zod is imported from `"astro/zod"`, not a standalone `zod` package.
- Hooks live in `src/components/hooks/` (per CLAUDE.md and `useGarminData.ts`).

## Desired End State

On `/dashboard`, a runner with no goal sees a race-goal form; after saving, they see a read-only summary card (event, date, distance, target time, computed pace) with an **Edit** button that reveals a prefilled form. Editing updates the same row in place. Invalid input (past date, out-of-band distance, implausible pace, empty name) is rejected both client-side (inline) and server-side (400). The active goal is fetchable at `GET /api/race-goals` for S-03 to consume later.

**Verification:** `npx astro sync && npm run lint && npm run build` all pass; the manual dashboard walkthrough (create → summary → edit → save; validation rejection; 401 when logged out) behaves as specified.

## What We're NOT Doing

- **No migration / schema change** — the table exists as-is.
- **No goal history / multiple goals UI** — edit-in-place keeps exactly one active row; the schema's inactive-row history capability stays unused this slice.
- **No delete / clear control** — edit-only in MVP (per decision).
- **No goal-expiry logic** — a goal with a past `event_date` keeps displaying unchanged; S-03 must tolerate a past date (noted in Open Risks).
- **No onboarding gate** — the dashboard degrades gracefully to the empty-form state; nothing forces goal setup.
- **No new unit tests** — verification is lint + build + manual walkthrough (per decision). This intentionally departs from the S-01 colocated `*.test.ts` convention.
- **No S-03 consumption** — this slice only persists and exposes the goal; the AI prompt wiring is S-03.

## Implementation Approach

Two phases, backend then frontend, mirroring the S-01 slice shape.

**Edit-in-place lifecycle.** There is at most one `is_active = TRUE` row per user. `saveRaceGoal` reads the active row first: if none exists it INSERTs (`is_active` defaults TRUE); if one exists it UPDATEs that row by `id` and bumps `updated_at`. Because a second active row is never inserted, `race_goals_one_active_per_user` never fires and no multi-statement transaction is required — sidestepping the F-01 gotcha cleanly.

**One-endpoint save.** A single `POST /api/race-goals` handles both create and update (the service decides which). `GET /api/race-goals` returns `{ goal: RaceGoal | null }`. This keeps the client to one "save my goal" call, which matches the idempotent single-goal mental model.

**Validation lives once, runs twice.** `src/lib/race-goal-validation.ts` is framework-free (no Zod, no Astro imports) so it is safe to bundle into the React client. It exports the guardrail constants and a pure `validateRaceGoal(input, todayIso)` returning a field→message map (empty = valid). The API route uses a small `astro/zod` schema for structural/type parsing, then calls `validateRaceGoal` for the semantic guardrails; the client form calls the same function for inline errors. Bands live in exactly one place.

## Critical Implementation Details

- **Pace guardrail band.** `validateRaceGoal` rejects `target_finish_seconds / distance_km` outside `[150, 900]` seconds/km (≈2:30–15:00 /km). The floor sits below every world record (marathon WR ≈171 s/km) so it only catches impossible inputs; the ceiling is lenient enough for walk-heavy finishers. Both are exported constants and tunable.
- **Distance band.** `[1, 100]` km — blocks fat-fingered values while covering 5K→marathon; ultras >100 km are intentionally excluded this slice.
- **Preset → km mapping under `NUMERIC(6,2)`** (2 decimals): 5K→`5.00`, 10K→`10.00`, Half→`21.10`, Marathon→`42.20`.
- **Date comparison.** `event_date` is a `YYYY-MM-DD` string; "today-or-future" is a lexicographic string compare against `todayIso()` (`new Date().toISOString().slice(0,10)`), which is correct for zero-padded ISO dates. Client sets the date input's `min` attribute to today.

## Phase 1: Backend — validation, service, API route

### Overview

Everything server-side needed to persist and read a race goal: a shared validation module, a typed service with edit-in-place save, and a GET/POST JSON route.

### Changes Required:

#### 1. Request DTO

**File**: `src/types.ts`

**Intent**: Add the request shape the API and service accept, kept separate from the DB `RaceGoal` Row type.

**Contract**: Export `interface RaceGoalInput { event_name: string; event_date: string; distance_km: number; target_finish_seconds: number; }`. `event_date` is `YYYY-MM-DD`.

#### 2. Shared validation module

**File**: `src/lib/race-goal-validation.ts` (new)

**Intent**: Single source of truth for the semantic guardrails, framework-free so both the server route and the React client import it.

**Contract**: Export constants `DISTANCE_MIN_KM = 1`, `DISTANCE_MAX_KM = 100`, `PACE_MIN_SEC_PER_KM = 150`, `PACE_MAX_SEC_PER_KM = 900`, `EVENT_NAME_MAX = 100`; a helper `paceSecondsPerKm(input): number`; and a pure `validateRaceGoal(input: RaceGoalInput, todayIso: string): Record<string, string>` returning a field→message map (empty object = valid). Checks: trimmed `event_name` non-empty and ≤ max; `event_date` ≥ `todayIso`; `distance_km` within band; `target_finish_seconds` > 0; pace within band. No Zod, no `astro:*` imports.

#### 3. Race-goals service

**File**: `src/lib/services/race-goals.ts` (new)

**Intent**: DI service (mirrors `garmin.ts`) that reads the active goal and saves it edit-in-place.

**Contract**: `type TypedSupabase = SupabaseClient<Database>`. Export `class RaceGoalError extends Error`. Export `getActiveRaceGoal(supabase, userId): Promise<RaceGoal | null>` — `.from("race_goals").select("*").eq("user_id", userId).eq("is_active", true).maybeSingle()`, return `data ?? null`. Export `saveRaceGoal(supabase, userId, input: RaceGoalInput): Promise<RaceGoal>` — load active row; if present `.update({ ...input, updated_at: new Date().toISOString() }).eq("id", existing.id).eq("user_id", userId).select().single()`, else `.insert({ user_id: userId, ...input, is_active: true }).select().single()`; on `{ error }` throw `RaceGoalError`; return the row. Never inserts a second active row (avoids the partial index).

#### 4. API route

**File**: `src/pages/api/race-goals.ts` (new)

**Intent**: JSON GET (current goal) + POST (create-or-update), following the `garmin/connect.ts` template.

**Contract**: Local `json(data, status=200)` helper. `export const GET: APIRoute` — 401 if no `context.locals.user`; `createClient(headers, cookies)` then 503 if null; return `{ goal }` from `getActiveRaceGoal`. `export const POST: APIRoute` — same guards; parse body with an `astro/zod` schema (`event_name: z.string`, `event_date: z.string`, `distance_km: z.number`, `target_finish_seconds: z.number`) via `safeParse(await request.json().catch(() => null))`, 400 `{ status: "bad_request", issues }` on failure; run `validateRaceGoal(parsed.data, todayIso())`, 400 `{ status: "invalid", issues }` if the map is non-empty; else `saveRaceGoal` and return `{ goal }` (200). Catch `RaceGoalError` → 502.

### Success Criteria:

#### Automated Verification:

- Type declarations regenerate: `npx astro sync`
- Linting passes (type-checked rules): `npm run lint`
- Production build passes: `npm run build`

#### Manual Verification:

- `GET /api/race-goals` returns `{ goal: null }` for a user with no goal, and the saved goal afterward.
- `POST` with a valid body creates a goal; a second `POST` updates the **same** row (no duplicate row, no partial-index error) — verify via Supabase table view.
- `POST` with a past date, out-of-band distance, implausible pace, or empty name each returns 400 with issues.
- Unauthenticated `GET`/`POST` returns 401.

**Implementation Note**: After Phase 1 automated verification passes, pause for manual confirmation of the API behavior before starting Phase 2. Phase blocks use plain bullets; the `## Progress` section owns the checkboxes.

---

## Phase 2: Frontend — dashboard race-goal island

### Overview

The `client:load` island that fetches the goal, renders a form or a summary card, and saves through the Phase 1 API — wired into the dashboard.

### Changes Required:

#### 1. Data hook

**File**: `src/components/hooks/useRaceGoal.ts` (new)

**Intent**: `{goal, loading, error}` fetch hook with `refetch` and a `save` action, mirroring `useGarminData.ts`.

**Contract**: Fetch-on-mount `GET /api/race-goals` (handle 401 as session-expired). Expose `goal: RaceGoal | null`, `loading`, `error`, `refetch()`, and `save(input: RaceGoalInput): Promise<{ ok: boolean; issues?: Record<string,string> }>` that POSTs and branches on the JSON `status`.

#### 2. Form component

**File**: `src/components/race-goals/RaceGoalForm.tsx` (new)

**Intent**: Create/edit form composing existing field primitives, with distance presets, H/M/S time inputs, and client-mirror validation.

**Contract**: Props `{ initial?: RaceGoal; onSaved: () => void; onCancel?: () => void }`. Fields: event name (`FormField`), event date (`<input type="date" min={today}>`), distance preset chips (5K/10K/Half/Marathon → mapped km) + custom km field, three number inputs H/M/S combined to `target_finish_seconds`. `useState` per field, `pending`, `error`. On submit, run `validateRaceGoal` for inline errors; if clean call the hook's `save`, map returned `issues` to fields, reset `pending` in `finally`, call `onSaved` on success. Use `Button` + `cn()`.

#### 3. Summary component

**File**: `src/components/race-goals/RaceGoalSummary.tsx` (new)

**Intent**: Read-only card of the saved goal with a computed pace and an Edit button.

**Contract**: Props `{ goal: RaceGoal; onEdit: () => void }`. Render event name, formatted date, distance, target time (seconds → `h:mm:ss`), and computed pace (`paceSecondsPerKm` → `m:ss /km`). Glassmorphism card + `Button`. No delete control.

#### 4. Section island

**File**: `src/components/race-goals/RaceGoalSection.tsx` (new)

**Intent**: `client:load` root that switches loading / error / form (no goal or editing) / summary.

**Contract**: Uses `useRaceGoal`. States: loading spinner (`Loader2` `animate-spin`); error card with Retry → `refetch`; no goal → `RaceGoalForm`; goal + not editing → `RaceGoalSummary`; goal + editing → `RaceGoalForm initial={goal}`. Local `editing` boolean toggled by summary's `onEdit` / form's `onSaved`+`onCancel`.

#### 5. Dashboard wiring

**File**: `src/pages/dashboard.astro`

**Intent**: Render the new section alongside the Garmin section.

**Contract**: Import `RaceGoalSection` and add `<RaceGoalSection client:load />` to the dashboard layout.

### Success Criteria:

#### Automated Verification:

- Type declarations regenerate: `npx astro sync`
- Linting passes: `npm run lint`
- Production build passes: `npm run build`

#### Manual Verification:

- No goal → dashboard shows the form; saving a valid goal switches to the summary card with correct computed pace.
- Edit reveals a prefilled form; saving updates in place (summary reflects new values; no duplicate row).
- Preset chips set the distance; the custom km field also works.
- Invalid input (past date, distance/pace out of band, empty name) shows inline errors and blocks submit.
- No delete/clear control is present.
- Logging out and reloading the dashboard triggers the session-expired path, not a crash.

**Implementation Note**: After Phase 2 automated verification passes, pause for manual confirmation of the full dashboard walkthrough.

---

## Testing Strategy

Per the chosen light bar, there are **no new automated unit/API tests** for this slice (a deliberate departure from the S-01 `*.test.ts` convention). Confidence comes from TypeScript's type-checked lint rules, a clean build, and the manual walkthroughs below.

### Manual Testing Steps:

1. Log in, open `/dashboard` with no goal → form renders.
2. Save a valid marathon goal (event, future date, Marathon chip, e.g. 4:00:00) → summary card shows correct pace (~5:41 /km).
3. Click Edit, change target time, save → summary updates; confirm a single row in Supabase `race_goals`.
4. Try a past date, 500 km distance, a 1:00:00 marathon (impossible pace), and an empty name → each is rejected inline; server also returns 400 if bypassed.
5. `GET /api/race-goals` (curl with session cookie) returns the saved goal; logged out returns 401.

## Performance Considerations

Negligible — single-row reads/writes scoped by `user_id`, low QPS per PRD target scale. No caching needed.

## Migration Notes

None. `race_goals` + RLS + `authenticated` grants are already applied (F-01). If a future slice needs goal history, revisit the edit-in-place decision (switch to deactivate-old + insert-new with an atomic RPC).

## References

- Roadmap slice S-02: `context/foundation/roadmap.md:92`
- PRD FR-008 + US-01: `context/foundation/prd.md:71`, `:43`
- Schema + partial index: `supabase/migrations/20260604000001_create_domain_tables.sql:9`
- Grants: `supabase/migrations/20260713000001_grant_domain_tables_to_authenticated.sql`
- S-01 patterns to mirror: `src/pages/api/garmin/connect.ts`, `src/lib/services/garmin.ts`, `src/components/hooks/useGarminData.ts`, `src/pages/dashboard.astro:34`, `src/components/auth/FormField.tsx`
- `RaceGoal` type: `src/types.ts:3`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Backend — validation, service, API route

#### Automated

- [x] 1.1 Type declarations regenerate: `npx astro sync` — 73ebd35
- [x] 1.2 Linting passes (type-checked rules): `npm run lint` — 73ebd35
- [x] 1.3 Production build passes: `npm run build` — 73ebd35

#### Manual

- [x] 1.4 GET returns `{ goal: null }` with no goal, and the saved goal afterward — 73ebd35
- [x] 1.5 POST creates once, then updates the same row (no duplicate, no partial-index error) — 73ebd35
- [x] 1.6 POST with past date / out-of-band distance / implausible pace / empty name each returns 400 — 73ebd35
- [x] 1.7 Unauthenticated GET/POST returns 401 — 73ebd35

### Phase 2: Frontend — dashboard race-goal island

#### Automated

- [x] 2.1 Type declarations regenerate: `npx astro sync`
- [x] 2.2 Linting passes: `npm run lint`
- [x] 2.3 Production build passes: `npm run build`

#### Manual

- [x] 2.4 No goal → form; saving valid goal switches to summary with correct pace
- [x] 2.5 Edit reveals prefilled form; saving updates in place (no duplicate row)
- [x] 2.6 Preset chips and custom km field both set distance
- [x] 2.7 Invalid input shows inline errors and blocks submit
- [x] 2.8 No delete/clear control present
- [x] 2.9 Logged-out reload triggers session-expired path, not a crash
