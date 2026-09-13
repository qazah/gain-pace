import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { disconnectGarmin, GarminError } from "@/lib/services/garmin";

/**
 * POST /api/garmin/disconnect — sever the Garmin connection: delete the stored
 * credentials row and clear any ephemeral session cookies. Follows the garmin
 * route template (auth guard + createClient null-check + JSON + error taxonomy).
 * Never calls the sidecar, so the only failure it maps is a DB delete error.
 */
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const POST: APIRoute = async (context) => {
  if (!context.locals.user) {
    return json({ status: "unauthorized" }, 401);
  }
  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return json({ status: "not_configured", message: "Supabase is not configured" }, 503);
  }

  try {
    await disconnectGarmin(supabase, context.locals.user.id, context.cookies);
    return json({ status: "ok" });
  } catch (err) {
    if (err instanceof GarminError) {
      return json({ status: "garmin_error", message: err.message }, 502);
    }
    throw err;
  }
};
