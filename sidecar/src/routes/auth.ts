import { Router } from "express";
import { z } from "zod";
import { login } from "garmin-connect-client";
import type { MfaPending } from "garmin-connect-client";
import { InvalidCredentialsError, MfaCodeInvalidError, MfaCodeError } from "garmin-connect-client";

export const authRouter = Router();

const loginBody = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

/**
 * The MFA resume blob returned by the library on the first login step
 * (`MfaPending = { mfaRequired: true, cookies }`). It is self-contained — the
 * Worker holds it between the two calls, so MFA resume survives the sidecar
 * scaling to zero / landing on a different instance.
 */
const mfaBody = z.object({
  pending: z.object({
    mfaRequired: z.literal(true),
    cookies: z.string(),
  }),
  mfaCode: z.string().min(1),
});

/**
 * POST /garmin/login — credentials login.
 * → { status: "ok", session }           when no MFA challenge
 * → { status: "mfa_required", pending }  when Garmin issues an MFA challenge
 * → 400 { status: "invalid_credentials" }
 */
authRouter.post("/login", (req, res) => {
  void (async () => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ status: "bad_request", issues: parsed.error.flatten() });
      return;
    }
    try {
      const result = await login({ username: parsed.data.username, password: parsed.data.password });
      if (result.mfaRequired) {
        res.json({ status: "mfa_required", pending: result });
        return;
      }
      res.json({ status: "ok", session: result.client.getSession() });
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        res.status(400).json({ status: "invalid_credentials" });
        return;
      }
      res.status(502).json({ status: "garmin_error", message: (err as Error).message });
    }
  })();
});

/**
 * POST /garmin/login/mfa — resume after an MFA challenge.
 * → { status: "ok", session }
 * → 400 { status: "mfa_invalid" }
 */
authRouter.post("/login/mfa", (req, res) => {
  void (async () => {
    const parsed = mfaBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ status: "bad_request", issues: parsed.error.flatten() });
      return;
    }
    try {
      const client = await login(parsed.data.pending as MfaPending, parsed.data.mfaCode);
      res.json({ status: "ok", session: client.getSession() });
    } catch (err) {
      if (err instanceof MfaCodeInvalidError || err instanceof MfaCodeError) {
        res.status(400).json({ status: "mfa_invalid" });
        return;
      }
      if (err instanceof InvalidCredentialsError) {
        res.status(400).json({ status: "invalid_credentials" });
        return;
      }
      res.status(502).json({ status: "garmin_error", message: (err as Error).message });
    }
  })();
});
