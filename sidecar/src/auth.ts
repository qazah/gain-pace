import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

/**
 * Shared-secret auth. Every request (including /health) must carry
 * `Authorization: Bearer <GARMIN_SIDECAR_SECRET>`; anything else → 401.
 *
 * Security note (see plan Phase 2 §2): this sidecar can log into any Garmin
 * account given credentials — the bearer is the only guard. Keep the secret
 * long + random, set it via a Cloud Run secret (never baked into the image),
 * and rotate it if it ever leaks. Constant-time compare avoids leaking the
 * secret length/prefix via timing.
 */

const SECRET = process.env.GARMIN_SIDECAR_SECRET ?? "";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on length mismatch — pad to equal length first.
  if (ab.length !== bb.length) {
    // Still run a compare to keep timing uniform, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export const requireAuth: RequestHandler = (req, res, next) => {
  if (!SECRET) {
    // Misconfiguration: refuse to serve rather than run wide open.
    res.status(503).json({ error: "sidecar_misconfigured", message: "GARMIN_SIDECAR_SECRET is not set" });
    return;
  }
  const header = req.header("authorization") ?? "";
  const prefix = "Bearer ";
  const token = header.startsWith(prefix) ? header.slice(prefix.length) : "";
  if (!token || !safeEqual(token, SECRET)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
};
