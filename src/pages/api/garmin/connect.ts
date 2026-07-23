import type { APIRoute } from "astro";
import { z } from "astro/zod";
import { createClient } from "@/lib/supabase";
import { connectGarmin, GarminNotConfiguredError, GarminError } from "@/lib/services/garmin";
import { DbSessionStore } from "@/lib/services/garmin-session-store";

/**
 * POST /api/garmin/connect — start a Garmin connection.
 * First JSON API route family in the repo: follows the auth-route template
 * (createClient + null-check) but returns JSON per CLAUDE.md instead of
 * redirecting. Not in PROTECTED_ROUTES, so it checks locals.user itself.
 */
const body = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

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

  const parsed = body.safeParse(await context.request.json().catch(() => null));
  if (!parsed.success) {
    return json({ status: "bad_request", issues: z.treeifyError(parsed.error) }, 400);
  }

  try {
    const result = await connectGarmin(new DbSessionStore(supabase, context.locals.user.id), parsed.data);
    return json(result, result.status === "invalid_credentials" ? 400 : 200);
  } catch (err) {
    if (err instanceof GarminNotConfiguredError) {
      return json({ status: "not_configured", message: "Garmin sidecar is not configured" }, 503);
    }
    if (err instanceof GarminError) {
      return json({ status: "garmin_error", message: err.message }, 502);
    }
    throw err;
  }
};
