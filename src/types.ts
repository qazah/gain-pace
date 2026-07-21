import type { Database } from "./types/database";

export type RaceGoal = Database["public"]["Tables"]["race_goals"]["Row"];
export type GarminCredentials = Database["public"]["Tables"]["garmin_credentials"]["Row"];
export type WorkoutSelection = Database["public"]["Tables"]["workout_selections"]["Row"];
export type RecommendationUsage = Database["public"]["Tables"]["recommendation_usage"]["Row"];

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

// ---- Recommendation loop DTOs (S-03) ----
// The modifier inputs, one AI-recommended alternative, and the full generation
// result the service returns. `intensity`/`feeling` match the workout_selections
// CHECK constraints; times are minutes.

export interface WorkoutModifiers {
  time_available_minutes: number;
  intensity: "low" | "normal" | "high";
  feeling: "tired" | "normal" | "energized";
}

// ---- Structured workout detail DTOs (S-05) ----
// Each alternative carries a model-authored one-line `summary` plus an ordered
// list of time-based `steps`. Paces are `"m:ss"`/km display strings; the
// guardrail parses them to sec/km for plausibility validation.

export type WorkoutEffort = "warmup" | "easy" | "steady" | "tempo" | "threshold" | "interval" | "recovery" | "cooldown";

export interface WorkoutStep {
  effort: WorkoutEffort;
  duration_minutes: number;
  /** Target pace per km as an "m:ss" display string (e.g. "6:15"). */
  target_pace: string;
}

export interface WorkoutDetail {
  summary: string;
  steps: WorkoutStep[];
}

export interface WorkoutAlternative {
  rank: "primary" | "alt_1" | "alt_2";
  workout_type: string;
  duration_minutes: number;
  ai_explanation: string;
  /** Reserved for S-04 (training-arc note); null in S-03. */
  training_arc_note: string | null;
  /**
   * S-06: one-line caution when a hard option is offered against low recovery
   * (body battery < threshold + intensity=high). Null unless that conflict holds
   * and the option is hard; the runner is never blocked, only informed.
   */
  recovery_warning: string | null;
  /** One-line prescription under the name (duration + effort + pace), S-05. */
  summary: string;
  /** Ordered time-based segments; always ≥1 (a plain run is a single step). */
  steps: WorkoutStep[];
}

export interface RecommendationResult {
  alternatives: WorkoutAlternative[];
  /** true → Garmin is connected but has no recovery data for today yet. */
  recoveryMissing: boolean;
  /** true → Garmin data was served from a stale cached snapshot. */
  stale: boolean;
  /**
   * Context echoed back to the select endpoint so persistence doesn't re-fetch
   * Garmin: the modifiers used, the active goal id, and the Garmin snapshot.
   */
  context: {
    modifiers: WorkoutModifiers;
    race_goal_id: string;
    garmin_data_snapshot: GarminDashboardData;
  };
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
