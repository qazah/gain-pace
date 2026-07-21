-- =============================================================
-- GainPace — Low-recovery conflict warning (S-06)
-- Migration: 20260722000001_add_recovery_warning.sql
-- Adds a nullable TEXT column to persist the committed workout's
-- low-recovery caution (shown when a hard session was chosen against
-- low body battery), mirroring the existing training_arc_note column.
-- Older rows stay null and render without the caution. No default,
-- no backfill. RLS already covers workout_selections; the table-level
-- GRANT to authenticated (20260713000001) covers the new column.
-- =============================================================

ALTER TABLE workout_selections
  ADD COLUMN recovery_warning TEXT;  -- one-line low-recovery caution; null for lighter picks / non-conflict / pre-S-06 rows
