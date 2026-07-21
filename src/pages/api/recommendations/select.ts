import type { APIRoute } from "astro";
import { z } from "astro/zod";
import { createClient } from "@/lib/supabase";
import { getTodaySelection, saveSelection, WorkoutSelectionError } from "@/lib/services/workout-selections";
import { WORKOUT_EFFORTS } from "@/lib/recommendation-guardrail";

/**
 * Workout selection API (S-03).
 * - GET  /api/recommendations/select — today's committed workout ({ selection } | null).
 * - POST /api/recommendations/select — persist a chosen alternative. The body echoes
 *   the chosen alternative + the generate response's `context` (modifiers, goal id,
 *   Garmin snapshot) so persistence doesn't re-fetch Garmin.
 */

const body = z.object({
  alternative: z.object({
    rank: z.enum(["primary", "alt_1", "alt_2"]),
    workout_type: z.string().min(1),
    duration_minutes: z.number().int().positive(),
    ai_explanation: z.string().min(1),
    training_arc_note: z.string().nullable(),
    // S-05: the structured breakdown committed alongside the flat fields.
    summary: z.string().min(1),
    steps: z
      .array(
        z.object({
          effort: z.enum(WORKOUT_EFFORTS),
          duration_minutes: z.number().int().positive(),
          target_pace: z.string().min(1),
        }),
      )
      .min(1),
  }),
  context: z.object({
    modifiers: z.object({
      time_available_minutes: z.number().int().positive(),
      intensity: z.enum(["low", "normal", "high"]),
      feeling: z.enum(["tired", "normal", "energized"]),
    }),
    race_goal_id: z.string().min(1),
    garmin_data_snapshot: z.unknown(),
  }),
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const GET: APIRoute = async (context) => {
  if (!context.locals.user) {
    return json({ status: "unauthorized" }, 401);
  }
  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return json({ status: "not_configured", message: "Supabase is not configured" }, 503);
  }
  const selection = await getTodaySelection(supabase, context.locals.user.id);
  return json({ selection });
};

export const POST: APIRoute = async (context) => {
  if (!context.locals.user) {
    return json({ status: "unauthorized" }, 401);
  }
  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return json({ status: "not_configured", message: "Supabase is not configured" }, 503);
  }

  const parsed = body.safeParse(await context.request.json().catch(() => null));
  if (!parsed.success) {
    return json({ status: "bad_request", issues: z.treeifyError(parsed.error) }, 400);
  }

  try {
    const selection = await saveSelection(supabase, context.locals.user.id, {
      alternative: parsed.data.alternative,
      modifiers: parsed.data.context.modifiers,
      raceGoalId: parsed.data.context.race_goal_id,
      garminSnapshot: parsed.data.context.garmin_data_snapshot,
    });
    return json({ status: "ok", selection });
  } catch (err) {
    if (err instanceof WorkoutSelectionError) {
      return json({ status: "error", message: err.message }, 502);
    }
    throw err;
  }
};
