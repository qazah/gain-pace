import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { WorkoutAlternative, WorkoutDetail, WorkoutModifiers, WorkoutSelection } from "@/types";

/**
 * Worker-side workout-selection service (S-03). Persists the runner's chosen
 * alternative as today's single committed workout (one row per user per day,
 * latest wins), following S-02's edit-in-place discipline — check for today's
 * row, update it in place if present, else insert. No transaction needed.
 * S-05: also persists the structured breakdown as the `workout_detail` JSONB.
 */

type TypedSupabase = SupabaseClient<Database>;
type SnapshotJson = Database["public"]["Tables"]["workout_selections"]["Row"]["garmin_data_snapshot"];
type DetailJson = NonNullable<Database["public"]["Tables"]["workout_selections"]["Row"]["workout_detail"]>;

/**
 * A selection row with `workout_detail` narrowed from the raw `Json` column to
 * the typed `WorkoutDetail | null` (null for pre-S-05 rows). This is the shape
 * callers get so they don't re-cast the JSONB.
 */
export interface WorkoutSelectionWithDetail extends Omit<WorkoutSelection, "workout_detail"> {
  workout_detail: WorkoutDetail | null;
}

function withDetail(row: WorkoutSelection): WorkoutSelectionWithDetail {
  return { ...row, workout_detail: (row.workout_detail as WorkoutDetail | null) ?? null };
}

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
export async function getTodaySelection(
  supabase: TypedSupabase,
  userId: string,
): Promise<WorkoutSelectionWithDetail | null> {
  const { data, error } = await supabase
    .from("workout_selections")
    .select("*")
    .eq("user_id", userId)
    .eq("selected_date", todayIso())
    .maybeSingle();
  if (error) {
    throw new WorkoutSelectionError(`failed to load today's selection: ${error.message}`);
  }
  return data ? withDetail(data) : null;
}

/** Persist the chosen alternative as today's selection (insert, or update in place). */
export async function saveSelection(
  supabase: TypedSupabase,
  userId: string,
  input: SaveSelectionInput,
): Promise<WorkoutSelectionWithDetail> {
  const row = {
    user_id: userId,
    alternative_rank: input.alternative.rank,
    workout_type: input.alternative.workout_type,
    duration_minutes: input.alternative.duration_minutes,
    ai_explanation: input.alternative.ai_explanation,
    training_arc_note: input.alternative.training_arc_note, // null in S-03
    recovery_warning: input.alternative.recovery_warning, // S-06: low-recovery caution (null unless conflict + hard)
    modifier_time_available: input.modifiers.time_available_minutes,
    modifier_intensity: input.modifiers.intensity,
    modifier_feeling: input.modifiers.feeling,
    race_goal_id: input.raceGoalId,
    garmin_data_snapshot: input.garminSnapshot as SnapshotJson,
    // S-05: the structured breakdown of the chosen alternative. Cast through
    // `unknown` — WorkoutStep is an interface (no index signature) so it isn't
    // directly comparable to the JSONB column's `Json` type.
    workout_detail: {
      summary: input.alternative.summary,
      steps: input.alternative.steps,
    } as unknown as DetailJson,
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
    return withDetail(data);
  }

  const { data, error } = await supabase.from("workout_selections").insert(row).select().single();
  if (error) {
    throw new WorkoutSelectionError(`failed to create selection: ${error.message}`);
  }
  return withDetail(data);
}
