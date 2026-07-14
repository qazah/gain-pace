import type { APIRoute } from "astro";
import { z } from "astro/zod";
import { createClient } from "@/lib/supabase";
import { getActiveRaceGoal, saveRaceGoal, RaceGoalError } from "@/lib/services/race-goals";
import { validateRaceGoal } from "@/lib/race-goal-validation";

/**
 * Race-goal API (S-02). Follows the garmin JSON-route template (locals.user
 * guard + createClient null-check + astro/zod safeParse), not the auth redirect
 * template.
 *
 * - GET  /api/race-goals — the runner's active goal: { goal: RaceGoal | null }.
 * - POST /api/race-goals — create-or-update the goal (edit-in-place; the service
 *   decides insert vs update). Shape is parsed with Zod; semantic guardrails run
 *   through the shared validateRaceGoal so the client and server agree.
 */

const body = z.object({
  event_name: z.string(),
  event_date: z.string(),
  distance_km: z.number(),
  target_finish_seconds: z.number(),
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export const GET: APIRoute = async (context) => {
  if (!context.locals.user) {
    return json({ status: "unauthorized" }, 401);
  }
  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return json({ status: "not_configured", message: "Supabase is not configured" }, 503);
  }

  const goal = await getActiveRaceGoal(supabase, context.locals.user.id);
  return json({ goal });
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

  const issues = validateRaceGoal(parsed.data, todayIso());
  if (Object.keys(issues).length > 0) {
    return json({ status: "invalid", issues }, 400);
  }

  try {
    const goal = await saveRaceGoal(supabase, context.locals.user.id, parsed.data);
    return json({ status: "ok", goal });
  } catch (err) {
    if (err instanceof RaceGoalError) {
      return json({ status: "error", message: err.message }, 502);
    }
    throw err;
  }
};
