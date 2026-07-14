import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { RaceGoal, RaceGoalInput } from "@/types";

/**
 * Worker-side race-goal service (S-02). Reads and persists the runner's single
 * active race goal in `race_goals` (per-user Supabase client → RLS scoped to
 * auth.uid()).
 *
 * Edit-in-place lifecycle: there is at most one `is_active = TRUE` row per user.
 * {@link saveRaceGoal} INSERTs when none exists and UPDATEs the existing row
 * otherwise — a second active row is never created, so the partial unique index
 * `race_goals_one_active_per_user` never fires and no transaction is needed.
 */

type TypedSupabase = SupabaseClient<Database>;

/** A race_goals read/write failure — the API route maps this to a 502. */
export class RaceGoalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RaceGoalError";
  }
}

/** The runner's active goal, or null if they haven't set one. */
export async function getActiveRaceGoal(supabase: TypedSupabase, userId: string): Promise<RaceGoal | null> {
  const { data, error } = await supabase
    .from("race_goals")
    .select("*")
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) {
    throw new RaceGoalError(`failed to load race goal: ${error.message}`);
  }
  return data ?? null;
}

/**
 * Create the runner's goal, or update it in place if one already exists.
 * Never inserts a second active row (see the edit-in-place note above).
 */
export async function saveRaceGoal(supabase: TypedSupabase, userId: string, input: RaceGoalInput): Promise<RaceGoal> {
  const existing = await getActiveRaceGoal(supabase, userId);

  if (existing) {
    const { data, error } = await supabase
      .from("race_goals")
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .eq("user_id", userId)
      .select()
      .single();
    if (error) {
      throw new RaceGoalError(`failed to update race goal: ${error.message}`);
    }
    return data;
  }

  const { data, error } = await supabase
    .from("race_goals")
    .insert({ user_id: userId, ...input, is_active: true })
    .select()
    .single();
  if (error) {
    throw new RaceGoalError(`failed to create race goal: ${error.message}`);
  }
  return data;
}
