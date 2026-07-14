-- =============================================================
-- GainPace — recommendation_usage (S-03 soft daily generation cap)
-- Migration: 20260714000001_create_recommendation_usage.sql
-- Tracks per-user LLM generation counts per calendar day so the
-- recommendation service can enforce a soft daily cap on the paid API.
-- RLS enabled with per-operation, per-role policies (mirrors F-01).
-- =============================================================

CREATE TABLE recommendation_usage (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day         DATE        NOT NULL DEFAULT CURRENT_DATE,
  count       INTEGER     NOT NULL DEFAULT 0 CHECK (count >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, day)
);

ALTER TABLE recommendation_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "recommendation_usage_select" ON recommendation_usage
  FOR SELECT USING ((select auth.uid()) = user_id);
CREATE POLICY "recommendation_usage_insert" ON recommendation_usage
  FOR INSERT WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "recommendation_usage_update" ON recommendation_usage
  FOR UPDATE USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "recommendation_usage_delete" ON recommendation_usage
  FOR DELETE USING ((select auth.uid()) = user_id);

-- Postgres checks table privileges BEFORE RLS; authenticated needs an explicit
-- grant or every read/write hits "permission denied" and the policies never run
-- (see 20260713000001_grant_domain_tables_to_authenticated.sql). anon stays revoked.
REVOKE ALL ON TABLE recommendation_usage FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE recommendation_usage TO authenticated;
