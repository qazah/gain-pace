import type { Database } from "./types/database";

export type RaceGoal = Database["public"]["Tables"]["race_goals"]["Row"];
export type GarminCredentials = Database["public"]["Tables"]["garmin_credentials"]["Row"];
export type WorkoutSelection = Database["public"]["Tables"]["workout_selections"]["Row"];
