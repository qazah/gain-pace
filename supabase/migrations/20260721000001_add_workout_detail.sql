-- =============================================================
-- GainPace — Structured workout detail per selection (S-05)
-- Migration: 20260721000001_add_workout_detail.sql
-- Adds a nullable JSONB column to persist the structured breakdown
-- (summary + ordered steps) of the committed workout, mirroring the
-- existing garmin_data_snapshot JSONB. Older rows stay null and render
-- without the summary/steps block. No default, no backfill.
-- RLS already covers workout_selections; the new column inherits it.
-- =============================================================

ALTER TABLE workout_selections
  ADD COLUMN workout_detail JSONB;  -- WorkoutDetail { summary, steps[] }; null for pre-S-05 rows
