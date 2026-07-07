-- =============================================================
-- GainPace — Garmin session storage (S-01)
-- Migration: 20260615000001_add_garmin_session_storage.sql
-- Extends garmin_credentials to hold the full garmin-connect-client
-- session blob, the encrypted Garmin password (re-login fallback),
-- and a last-good data snapshot for graceful degradation.
-- All columns nullable: a row may exist mid-connect. Existing scalar
-- OAuth2 token columns are retained for quick expiry checks.
-- RLS already covers garmin_credentials; new columns inherit it.
-- =============================================================

ALTER TABLE garmin_credentials
  ADD COLUMN session_data              JSONB,        -- PersistedSession (OAuth1 + OAuth2 + cookies)
  ADD COLUMN garmin_password_encrypted TEXT,         -- AES-GCM blob (server-key encrypted), re-login fallback
  ADD COLUMN last_snapshot             JSONB,        -- last good fetched data, served stale on failure
  ADD COLUMN last_synced_at            TIMESTAMPTZ;  -- when last_snapshot was captured
