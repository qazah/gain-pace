import type { APIRoute } from "astro";
import { z } from "astro/zod";
import { createClient } from "@/lib/supabase";
import { submitMfa, GarminNotConfiguredError, GarminError } from "@/lib/services/garmin";
import { DbSessionStore } from "@/lib/services/garmin-session-store";

/**
 * POST /api/garmin/mfa — resume a pending MFA challenge. The `pending` blob lives
 * server-side in garmin_credentials (stashed by /api/garmin/connect), so the
 * client only sends the code.
 */
const body = z.object({
  mfaCode: z.string().min(1),
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
    const result = await submitMfa(new DbSessionStore(supabase, context.locals.user.id), parsed.data.mfaCode);
    const status = result.status === "ok" ? 200 : 400;
    return json(result, status);
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
