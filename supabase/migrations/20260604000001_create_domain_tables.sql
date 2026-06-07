-- =============================================================
-- GainPace domain schema
-- Migration: 20260604000001_create_domain_tables.sql
-- Creates: race_goals, garmin_credentials, workout_selections
-- All tables enable RLS with per-operation, per-role policies.
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
-- IMPORTANT: when replacing an active goal, set is_active=FALSE on the old
-- row and INSERT the new one in a single transaction — otherwise this index fires.
CREATE UNIQUE INDEX race_goals_one_active_per_user
  ON race_goals(user_id)
  WHERE (is_active = TRUE);

ALTER TABLE race_goals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "race_goals_select" ON race_goals
  FOR SELECT USING ((select auth.uid()) = user_id);
CREATE POLICY "race_goals_insert" ON race_goals
  FOR INSERT WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "race_goals_update" ON race_goals
  FOR UPDATE USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "race_goals_delete" ON race_goals
  FOR DELETE USING ((select auth.uid()) = user_id);

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
  FOR SELECT USING ((select auth.uid()) = user_id);
CREATE POLICY "garmin_credentials_insert" ON garmin_credentials
  FOR INSERT WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "garmin_credentials_update" ON garmin_credentials
  FOR UPDATE USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "garmin_credentials_delete" ON garmin_credentials
  FOR DELETE USING ((select auth.uid()) = user_id);

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
  FOR SELECT USING ((select auth.uid()) = user_id);
CREATE POLICY "workout_selections_insert" ON workout_selections
  FOR INSERT WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "workout_selections_update" ON workout_selections
  FOR UPDATE USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "workout_selections_delete" ON workout_selections
  FOR DELETE USING ((select auth.uid()) = user_id);

-- Revoke all privileges from the anon role so these tables are not discoverable
-- in the GraphQL schema for unauthenticated requests. RLS alone does not prevent
-- schema introspection; explicit REVOKE does.
REVOKE ALL ON TABLE race_goals         FROM anon;
REVOKE ALL ON TABLE garmin_credentials FROM anon;
REVOKE ALL ON TABLE workout_selections FROM anon;
