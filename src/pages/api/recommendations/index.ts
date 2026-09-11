import type { APIRoute } from "astro";
import { z } from "astro/zod";
import { createClient } from "@/lib/supabase";
import { DbSessionStore } from "@/lib/services/garmin-session-store";
import { CookieSessionStore, readSessionCookies } from "@/lib/services/garmin-session-cookie";
import {
  generateRecommendation,
  LlmError,
  LlmNotConfiguredError,
  RecommendationNotReadyError,
  RecommendationRateLimitedError,
} from "@/lib/services/recommendations";

/**
 * POST /api/recommendations — generate today's workout options (S-03).
 * Follows the garmin JSON-route template (locals.user guard + createClient
 * null-check + astro/zod safeParse). Maps the service's typed errors to stable
 * JSON statuses: not_ready (gate), rate_limited, not_configured, llm_error.
 */

const body = z.object({
  time_available_minutes: z.number().int().positive(),
  intensity: z.enum(["low", "normal", "high"]),
  feeling: z.enum(["tired", "normal", "energized"]),
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

  // Stores are mutually exclusive (see /connect): a session in the cookies means
  // ephemeral mode; otherwise fall back to the DB-backed store. Mirrors
  // /api/garmin/data — both read the runner's Garmin session the same way.
  const cookieSession = await readSessionCookies(context.cookies, context.request.headers);
  const store = cookieSession
    ? new CookieSessionStore(context.cookies, context.request.headers)
    : new DbSessionStore(supabase, context.locals.user.id);

  try {
    const result = await generateRecommendation(supabase, context.locals.user.id, store, parsed.data);
    return json({ status: "ok", result });
  } catch (err) {
    if (err instanceof RecommendationNotReadyError) {
      return json({ status: "not_ready", reason: err.reason }, 200);
    }
    if (err instanceof RecommendationRateLimitedError) {
      return json({ status: "rate_limited" }, 429);
    }
    if (err instanceof LlmNotConfiguredError) {
      return json({ status: "not_configured", message: "AI recommendations are not configured" }, 503);
    }
    if (err instanceof LlmError) {
      return json({ status: "llm_error", message: err.message }, 502);
    }
    throw err;
  }
};
