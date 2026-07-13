import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { getDashboardData } from "@/lib/services/garmin";

/**
 * GET /api/garmin/data — the dashboard's Garmin payload:
 * { connected, recovery, activities, scheduledWorkout, stale, reconnectRequired? }.
 * Graceful by construction: getDashboardData never throws for a sidecar/Garmin
 * failure — it serves the cached snapshot with stale:true (or a reconnect flag).
 */
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

  const date = new URL(context.request.url).searchParams.get("date") ?? undefined;
  const data = await getDashboardData(supabase, context.locals.user.id, date);
  return json(data);
};
