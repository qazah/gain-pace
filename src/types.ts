import type { Database } from "./types/database";

export type RaceGoal = Database["public"]["Tables"]["race_goals"]["Row"];
export type GarminCredentials = Database["public"]["Tables"]["garmin_credentials"]["Row"];
export type WorkoutSelection = Database["public"]["Tables"]["workout_selections"]["Row"];

// ---- Race goal request DTO (S-02) ----
// The shape the race-goal API + service accept when a runner saves a goal.
// Kept separate from the RaceGoal Row type (no id/user_id/is_active/timestamps).

export interface RaceGoalInput {
  event_name: string;
  /** ISO calendar date, YYYY-MM-DD. */
  event_date: string;
  distance_km: number;
  target_finish_seconds: number;
}

// ---- Garmin normalized DTOs (S-01) ----
// These mirror the sidecar's normalized JSON (see sidecar/src/routes/data.ts),
// NOT Garmin's raw payloads. The service and the UI share this one contract.

export interface GarminActivity {
  id: string;
  name: string | null;
  type: string | null;
  startTime: string | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  averageHeartRate: number | null;
  calories: number | null;
}

export interface GarminBodyBattery {
  current: number | null;
  high: number | null;
  low: number | null;
}

export interface GarminRecovery {
  date: string;
  sleepScore: number | null;
  sleepDurationSeconds: number | null;
  deepSleepSeconds: number | null;
  lightSleepSeconds: number | null;
  remSleepSeconds: number | null;
  /** Sleep-scoped overnight HRV — the committed HRV source for S-01. */
  overnightHrv: number | null;
  bodyBattery: GarminBodyBattery;
}

export interface GarminScheduledWorkout {
  id: string | null;
  title: string | null;
  date: string;
  sportType: string | null;
}

export interface GarminDashboardData {
  /** false → the user has never completed a Garmin connect (UI shows ConnectGarmin). */
  connected: boolean;
  recovery: GarminRecovery | null;
  activities: GarminActivity[];
  scheduledWorkout: GarminScheduledWorkout | null;
  /** true → served from the cached last-good snapshot after a live-fetch failure. */
  stale: boolean;
  /** true → session died and silent re-login hit an MFA re-challenge; UI must re-run connect. */
  reconnectRequired?: boolean;
}
