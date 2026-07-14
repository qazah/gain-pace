import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { WorkoutAlternative, WorkoutModifiers, WorkoutSelection } from "@/types";

/**
 * Worker-side workout-selection service (S-03). Persists the runner's chosen
 * alternative as today's single committed workout (one row per user per day,
 * latest wins), following S-02's edit-in-place discipline — check for today's
 * row, update it in place if present, else insert. No transaction needed.
 */

type TypedSupabase = SupabaseClient<Database>;
type SnapshotJson = Database["public"]["Tables"]["workout_selections"]["Row"]["garmin_data_snapshot"];

/** A workout_selections read/write failure — the API route maps this to a 502. */
export class WorkoutSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkoutSelectionError";
  }
}

export interface SaveSelectionInput {
  alternative: WorkoutAlternative;
  modifiers: WorkoutModifiers;
  raceGoalId: string;
  /** Opaque Garmin snapshot echoed from the generate response; persisted as JSON. */
  garminSnapshot: unknown;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The runner's committed workout for today, or null if none selected yet. */
export async function getTodaySelection(supabase: TypedSupabase, userId: string): Promise<WorkoutSelection | null> {
  const { data, error } = await supabase
    .from("workout_selections")
    .select("*")
    .eq("user_id", userId)
    .eq("selected_date", todayIso())
    .maybeSingle();
  if (error) {
    throw new WorkoutSelectionError(`failed to load today's selection: ${error.message}`);
  }
  return data ?? null;
}

/** Persist the chosen alternative as today's selection (insert, or update in place). */
export async function saveSelection(
  supabase: TypedSupabase,
  userId: string,
  input: SaveSelectionInput,
): Promise<WorkoutSelection> {
  const row = {
    user_id: userId,
    alternative_rank: input.alternative.rank,
    workout_type: input.alternative.workout_type,
    duration_minutes: input.alternative.duration_minutes,
    ai_explanation: input.alternative.ai_explanation,
    training_arc_note: input.alternative.training_arc_note, // null in S-03
    modifier_time_available: input.modifiers.time_available_minutes,
    modifier_intensity: input.modifiers.intensity,
    modifier_feeling: input.modifiers.feeling,
    race_goal_id: input.raceGoalId,
    garmin_data_snapshot: input.garminSnapshot as SnapshotJson,
  };

  const existing = await getTodaySelection(supabase, userId);

  if (existing) {
    const { data, error } = await supabase
      .from("workout_selections")
      .update(row)
      .eq("id", existing.id)
      .eq("user_id", userId)
      .select()
      .single();
    if (error) {
      throw new WorkoutSelectionError(`failed to update selection: ${error.message}`);
    }
    return data;
  }

  const { data, error } = await supabase.from("workout_selections").insert(row).select().single();
  if (error) {
    throw new WorkoutSelectionError(`failed to create selection: ${error.message}`);
  }
  return data;
}
