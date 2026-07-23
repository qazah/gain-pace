import type { APIRoute } from "astro";
import { z } from "astro/zod";
import { createClient } from "@/lib/supabase";
import { getDashboardData } from "@/lib/services/garmin";
import { DbSessionStore } from "@/lib/services/garmin-session-store";
import { CookieSessionStore, readSessionCookies } from "@/lib/services/garmin-session-cookie";

const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

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

  const rawDate = new URL(context.request.url).searchParams.get("date");
  let date: string | undefined;
  if (rawDate !== null) {
    const parsed = dateParam.safeParse(rawDate);
    if (!parsed.success) {
      return json({ status: "bad_request", issues: z.treeifyError(parsed.error) }, 400);
    }
    date = parsed.data;
  }

  // Stores are mutually exclusive (see /connect): a session in the cookies means
  // ephemeral mode; otherwise fall back to the DB-backed store.
  const cookieSession = await readSessionCookies(context.cookies, context.request.headers);
  const store = cookieSession
    ? new CookieSessionStore(context.cookies, context.request.headers)
    : new DbSessionStore(supabase, context.locals.user.id);

  const data = await getDashboardData(store, date);
  return json(data);
};
