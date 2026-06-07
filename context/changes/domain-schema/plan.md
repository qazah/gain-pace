# Domain Schema Implementation Plan

## Overview

Create three Supabase SQL migrations for the domain tables that every downstream GainPace slice depends on: `race_goals`, `garmin_credentials`, and `workout_selections`. Wire Supabase-generated TypeScript types into the client so all future database calls are type-safe. This is F-01 from the roadmap — nothing in S-01, S-02, or S-03 can be planned or built without this foundation in place.

## Current State Analysis

- `supabase/migrations/` directory does not exist yet; `supabase/config.toml` has `schema_paths = []` (CLI auto-discovers migrations from the folder, no config change needed)
- `src/lib/supabase.ts` creates the SSR client without `Database` type generics — all DB calls are currently untyped
- No domain TypeScript types exist anywhere in `src/`
- Auth infrastructure is fully in place (Supabase SSR cookies, `src/middleware.ts`, protected routes)

## Desired End State

- `supabase/migrations/20260604000001_create_domain_tables.sql` applies cleanly against local Supabase
- All three tables are present with RLS enabled and 4 per-operation policies each
- `npx supabase gen types typescript --local` produces `src/types/database.ts`
- `createClient` in `src/lib/supabase.ts` is typed with `Database`
- `src/types.ts` exports `RaceGoal`, `GarminCredentials`, `WorkoutSelection` as ready-to-import Row types

### Key Discoveries

- Supabase client uses anon key + user JWT; RLS enforces per-user data isolation. No service-role client currently exists in the codebase.
- `supabase gen types typescript` requires local Supabase running (`npx supabase start`, requires Docker). Per CLAUDE.md.
- CLAUDE.md convention: migration files named `supabase/migrations/YYYYMMDDHHmmss_description.sql`.

## What We're NOT Doing

- No seed data (`seed.sql` not created here)
- No API routes, services, or UI for these tables — that belongs to S-01, S-02, S-03
- No `updated_at` auto-trigger function (app code updates `updated_at` on explicit writes in MVP)
- No encryption-at-rest for `access_token` / `refresh_token` beyond Supabase's default volume encryption
- No `src/types/` directory for other purposes — only `database.ts` lands here

## Implementation Approach

Single SQL migration file for all three tables (atomic: either all tables land or none), followed by type generation and client wiring. Tables are ordered by dependency: `race_goals` first (no FK deps), `garmin_credentials` second (no FK deps), `workout_selections` last (FK to both `auth.users` and `race_goals`).

## Critical Implementation Details

**Partial unique index for race_goals:** `CREATE UNIQUE INDEX ... WHERE (is_active = TRUE)` means only one row per `user_id` can have `is_active = TRUE`. When replacing an active goal, the app must set the old goal's `is_active = FALSE` and insert the new row in a **single transaction** — doing it in two separate statements risks a race window where both are active simultaneously and the index fires.

**UPDATE policies require both USING and WITH CHECK:** Supabase RLS `FOR UPDATE` without a `WITH CHECK` clause evaluates only the pre-update row. A malicious client could update `user_id` to another user's ID. Both clauses are present in this migration.

## Phase 1: SQL Migration

### Overview

Write the single migration file that creates all three domain tables with RLS. This is the deliverable F-01 depends on. Local verification via `npx supabase db reset`.

### Changes Required

#### 1. Migration file

**File:** `supabase/migrations/20260604000001_create_domain_tables.sql`

**Intent:** Create `race_goals`, `garmin_credentials`, and `workout_selections` in one atomic migration. Every downstream slice reads or writes at least one of these tables; getting RLS correct here prevents the cross-user credential leak flagged in the roadmap Risk field.

**Contract:** Full schema below — column names, types, and constraints are the interface contract that S-01, S-02, and S-03 plans will reference.

```sql
-- =============================================================
-- GainPace domain schema
-- Migration: 20260604000001_create_domain_tables.sql
-- =============================================================

-- ====================== race_goals ===========================
CREATE TABLE race_goals (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_name             TEXT         NOT NULL,
  event_date             DATE         NOT NULL,
  distance_km            NUMERIC(6,2) NOT NULL CHECK (distance_km > 0),
  target_finish_seconds  INTEGER      NOT NULL CHECK (target_finish_seconds > 0),
  is_active              BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One active goal per user enforced at DB level.
-- Multiple inactive goals are allowed (preserves history).
CREATE UNIQUE INDEX race_goals_one_active_per_user
  ON race_goals(user_id)
  WHERE (is_active = TRUE);

ALTER TABLE race_goals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "race_goals_select" ON race_goals
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "race_goals_insert" ON race_goals
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "race_goals_update" ON race_goals
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "race_goals_delete" ON race_goals
  FOR DELETE USING (auth.uid() = user_id);

-- =================== garmin_credentials ======================
CREATE TABLE garmin_credentials (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  access_token    TEXT        NOT NULL,
  refresh_token   TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  garmin_user_id  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);

ALTER TABLE garmin_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY "garmin_credentials_select" ON garmin_credentials
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "garmin_credentials_insert" ON garmin_credentials
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "garmin_credentials_update" ON garmin_credentials
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "garmin_credentials_delete" ON garmin_credentials
  FOR DELETE USING (auth.uid() = user_id);

-- =================== workout_selections ======================
CREATE TABLE workout_selections (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  selected_date           DATE        NOT NULL DEFAULT CURRENT_DATE,
  race_goal_id            UUID        REFERENCES race_goals(id) ON DELETE SET NULL,
  alternative_rank        TEXT        NOT NULL
                            CHECK (alternative_rank IN ('primary', 'alt_1', 'alt_2')),
  workout_type            TEXT        NOT NULL,
  duration_minutes        INTEGER     NOT NULL CHECK (duration_minutes > 0),
  ai_explanation          TEXT        NOT NULL,
  training_arc_note       TEXT,
  modifier_time_available INTEGER     CHECK (modifier_time_available > 0),
  modifier_intensity      TEXT        CHECK (modifier_intensity IN ('low', 'normal', 'high')),
  modifier_feeling        TEXT        CHECK (modifier_feeling IN ('tired', 'normal', 'energized')),
  garmin_data_snapshot    JSONB       NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE workout_selections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "workout_selections_select" ON workout_selections
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "workout_selections_insert" ON workout_selections
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "workout_selections_update" ON workout_selections
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "workout_selections_delete" ON workout_selections
  FOR DELETE USING (auth.uid() = user_id);
```

### Success Criteria

#### Automated Verification

- Migration applies without errors: `npx supabase db reset` exits 0
- All three tables present: `npx supabase db diff` shows no pending changes after reset
- Linting passes (unchanged files): `npm run lint`

#### Manual Verification

- Open Supabase Studio at `http://localhost:54323` → Table Editor shows `race_goals`, `garmin_credentials`, `workout_selections` with the expected columns
- Auth → Policies: each table shows 4 policies (select/insert/update/delete)
- Insert a row as user A, verify user B's JWT cannot SELECT it (test via SQL editor with different `auth.uid()` values)

**Implementation Note:** After completing this phase and automated verification passes, pause for manual confirmation (Studio + RLS test) before proceeding to Phase 2.

---

## Phase 2: TypeScript Types

### Overview

Generate Supabase TypeScript types from the live local schema, wire the `Database` generic into the SSR client, and export application-level Row types. This gives every future API route and service function type-safe database access.

### Changes Required

#### 1. Type generation (command, not a hand-written file)

**File produced:** `src/types/database.ts`

**Intent:** Run `npx supabase gen types typescript --local` against the local running Supabase instance and redirect output to `src/types/database.ts`. This file is generated — do not edit by hand. Re-run the command after any future migration.

**Contract:** The command produces a `Database` interface containing `public.Tables.race_goals`, `public.Tables.garmin_credentials`, and `public.Tables.workout_selections` with `Row`, `Insert`, and `Update` subtypes.

Prerequisite: `npx supabase start` must be running (Docker required).

```
npx supabase gen types typescript --local > src/types/database.ts
```

#### 2. Wire Database generic into SSR client

**File:** `src/lib/supabase.ts`

**Intent:** Add the `Database` type parameter to `createServerClient` so every `.from('race_goals')` call in the codebase returns typed rows at compile time.

**Contract:** Import `Database` from `../types/database`; change the `createServerClient(...)` call to `createServerClient<Database>(...)`. The function return type becomes `SupabaseClient<Database> | null` — callers already handle the `null` case via the existing null check pattern.

#### 3. Application-level domain types

**File:** `src/types.ts` (create new)

**Intent:** Export named Row types for the three domain entities so API routes and services import clean names like `RaceGoal` rather than verbose generics everywhere.

**Contract:**
```typescript
import type { Database } from './types/database';

export type RaceGoal          = Database['public']['Tables']['race_goals']['Row'];
export type GarminCredentials = Database['public']['Tables']['garmin_credentials']['Row'];
export type WorkoutSelection  = Database['public']['Tables']['workout_selections']['Row'];
```

### Success Criteria

#### Automated Verification

- `src/types/database.ts` exists and contains the `Database` interface: `grep -c "race_goals" src/types/database.ts` returns > 0
- TypeScript compilation: `npm run lint` passes with no errors in `src/lib/supabase.ts` or `src/types.ts`

#### Manual Verification

- In VS Code, open any file, type `supabase.from('race_goals').select(` and verify IntelliSense shows typed column completions
- `src/types.ts` exports are importable: add a test import to any `.ts` file, confirm no TS error, then remove it

---

## Testing Strategy

### Automated Tests

None yet (no test runner configured per CLAUDE.md). Testing is manual for this phase.

### Manual Testing Steps

1. `npx supabase start` → confirm local instance is running at port 54321
2. `npx supabase db reset` → migration applies cleanly, no errors
3. Open `http://localhost:54323` (Supabase Studio)
4. Table Editor: verify all 3 tables with correct column shapes
5. Auth → Policies: verify 4 policies per table
6. SQL Editor: run `SET LOCAL role authenticated; SET LOCAL request.jwt.claims = '{"sub": "user-a-uuid"}'::text;` then `SELECT * FROM garmin_credentials;` — returns empty for user B

## Migration Notes

This migration is a greenfield creation — no data exists to preserve. If the migration needs to be rolled back during development, `npx supabase db reset` restores a clean state.

Future migrations that depend on this schema must preserve `user_id REFERENCES auth.users(id)` for all three tables and must not break the `race_goals_one_active_per_user` partial index.

## References

- Roadmap: `context/foundation/roadmap.md` — F-01 (domain-schema, ready)
- PRD: `context/foundation/prd.md` — FR-001, FR-007, FR-008, Access Control section
- CLAUDE.md migration convention: `supabase/migrations/YYYYMMDDHHmmss_description.sql`
- Supabase SSR client: `src/lib/supabase.ts`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: SQL Migration

#### Automated

- [x] 1.1 `npx supabase db reset` applies without errors — e3fac28
- [x] 1.2 `npm run lint` passes (no regressions) — e3fac28

#### Manual

- [x] 1.3 All 3 tables visible in Supabase Studio with correct columns — e3fac28
- [x] 1.4 4 RLS policies per table visible in Auth → Policies — e3fac28
- [x] 1.5 Cross-user SELECT rejected (RLS test in SQL Editor) — e3fac28

### Phase 2: TypeScript Types

#### Automated

- [x] 2.1 `src/types/database.ts` contains generated `Database` interface
- [x] 2.2 `npm run lint` passes with no errors in `src/lib/supabase.ts` or `src/types.ts`

#### Manual

- [x] 2.3 IntelliSense shows typed column completions on `.from('race_goals').select(`
