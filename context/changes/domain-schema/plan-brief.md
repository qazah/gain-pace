# Domain Schema — Plan Brief

> Full plan: `context/changes/domain-schema/plan.md`

## What & Why

Create the three Supabase domain tables that every GainPace feature depends on: `race_goals`, `garmin_credentials`, and `workout_selections`. Without these tables, S-01 (Garmin connect), S-02 (race goal setup), and S-03 (AI recommendation loop) cannot be planned or built. This is F-01 from the roadmap — the only prerequisite with `Status: ready` and no blockers.

## Starting Point

Supabase is wired (`src/lib/supabase.ts`) and auth works, but `supabase/migrations/` doesn't exist and the client has no TypeScript type generics. All domain DB calls today would be untyped and fail at runtime.

## Desired End State

A single migration file applies cleanly and creates all three tables with RLS. The Supabase TypeScript client is typed with the generated `Database` interface, and `src/types.ts` exports `RaceGoal`, `GarminCredentials`, `WorkoutSelection` for use by future API routes and services.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
|---|---|---|---|
| Goals per user | One active at a time (partial unique index) | PRD says "a race goal" singular; simpler AI prompt context | Plan |
| workout_selections detail | Full snapshot (type, duration, explanation, modifiers, Garmin snapshot) | S-03 needs yesterday's selection as AI context; minimal schema would require a migration later | Plan |
| garmin_credentials schema | Structured OAuth2 columns (access_token, refresh_token, expires_at, garmin_user_id) | User chose structured over JSONB; tokens match standard OAuth2 flow | Plan |
| TypeScript types | `supabase gen types typescript --local` → src/types/database.ts | Keeps types in sync with schema; standard Supabase pattern | Plan |
| All 3 tables in one migration | Single file | Atomic: either all tables land or none; simpler rollback | Plan |

## Scope

**In scope:**
- `supabase/migrations/20260604000001_create_domain_tables.sql` with all 3 tables + RLS
- `src/types/database.ts` (generated, not hand-written)
- `src/lib/supabase.ts` typed with `Database` generic
- `src/types.ts` with `RaceGoal`, `GarminCredentials`, `WorkoutSelection` Row types

**Out of scope:**
- Seed data, API routes, services, UI for these tables
- `updated_at` auto-trigger (app code updates it explicitly in MVP)
- Encryption-at-rest beyond Supabase defaults

## Architecture / Approach

One SQL file, two phases. Phase 1 creates the schema (SQL migration); Phase 2 generates types and wires them into the client. No business logic touches this plan — it's pure infrastructure for downstream slices.

Tables in dependency order: `race_goals` and `garmin_credentials` (no FK deps) → `workout_selections` (FK to both). RLS uses `auth.uid() = user_id` with 4 per-operation policies per table (SELECT / INSERT / UPDATE / DELETE).

## Phases at a Glance

| Phase | What it delivers | Key risk |
|---|---|---|
| 1. SQL Migration | 3 tables + RLS in Supabase | RLS UPDATE policy needs both USING and WITH CHECK — missing WITH CHECK is a silent security gap |
| 2. TypeScript Types | Type-safe client + Row type exports | Requires Docker + local Supabase running; fails silently if Supabase isn't started |

**Prerequisites:** Docker running locally (for `npx supabase start`)
**Estimated effort:** ~1 session (Phase 1 is ~30 min SQL; Phase 2 is a single command + 3 file edits)

## Open Risks & Assumptions

- `garmin_credentials` schema assumes OAuth2-style tokens. If S-01 discovers Garmin uses cookie-based auth instead, `access_token`/`refresh_token` columns won't fit and a migration will be needed.
- `race_goals_one_active_per_user` partial index requires the app to deactivate the old goal BEFORE inserting a new one (in a transaction) — failing to do so in S-02 will cause a DB constraint error at runtime.

## Success Criteria (Summary)

- `npx supabase db reset` exits 0 with all 3 tables present and 4 RLS policies each
- `npm run lint` passes with fully typed Supabase client
- Cross-user credential SELECT is rejected in a manual RLS test
