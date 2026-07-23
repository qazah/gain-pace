import type { AstroCookies } from "astro";
import type { SupabaseClient } from "@supabase/supabase-js";
import { GARMIN_SIDECAR_URL, GARMIN_SIDECAR_SECRET } from "astro:env/server";
import type { Database } from "@/types/database";
import type { GarminActivity, GarminDashboardData, GarminRecovery, GarminScheduledWorkout } from "@/types";
import type { GarminSessionState, SessionStore } from "./garmin-session-store";
import { clearSessionCookies } from "./garmin-session-cookie";
import { decryptPassword, encryptPassword } from "./garmin-crypto";

/**
 * Worker-side Garmin service. The first outbound-HTTP module in the repo — the
 * reference pattern for talking to an external service.
 *
 * Responsibilities:
 * - own the typed client to the off-edge sidecar (HTTPS + shared bearer),
 * - drive connect / MFA / data-fetch over a {@link SessionStore} seam, so the
 *   session may live in the DB (default) or in cookies (ephemeral) without this
 *   module knowing which,
 * - re-login from the stored password when a session dies (DB mode only; cookie
 *   mode has no stored password, so a dead session surfaces "reconnect required"),
 * - serve the cached `last_snapshot` with `stale: true` on any sidecar failure
 *   (DB mode only; cookie mode has no snapshot).
 *
 * The Worker never holds Garmin tokens directly or talks to Garmin — it only
 * calls our own sidecar contract (see sidecar/src/routes/*.ts).
 */

type TypedSupabase = SupabaseClient<Database>;

/** Minimal shape of garmin-connect-client's PersistedSession we depend on. */
export interface Oauth2Token {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
}
export interface PersistedSession {
  oauth2Token: Oauth2Token;
  [key: string]: unknown;
}
/** The self-contained MFA resume blob the sidecar returns on step 1 of login. */
export interface MfaPending {
  mfaRequired: true;
  cookies: string;
}

// ---- Error taxonomy the API routes map to stable JSON ----

/** Sidecar URL/secret not configured — the config banner should already show. */
export class GarminNotConfiguredError extends Error {
  constructor() {
    super("Garmin sidecar is not configured");
    this.name = "GarminNotConfiguredError";
  }
}
/** A generic sidecar/Garmin failure (network, timeout, 5xx, unexpected status). */
export class GarminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GarminError";
  }
}
/** Session died and the stored password can't silently recover it (MFA re-challenge / no password). */
export class ReconnectRequiredError extends Error {
  constructor() {
    super("Garmin reconnect required");
    this.name = "ReconnectRequiredError";
  }
}

const SIDECAR_TIMEOUT_MS = 20_000; // cold start (1–5 s) + Garmin latency headroom

/** Every sidecar call goes through here: injects the bearer + a hard timeout. */
async function callSidecar(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  if (!GARMIN_SIDECAR_URL || !GARMIN_SIDECAR_SECRET) {
    throw new GarminNotConfiguredError();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, SIDECAR_TIMEOUT_MS);
  try {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Authorization", `Bearer ${GARMIN_SIDECAR_SECRET}`);
    let res: Response;
    try {
      res = await fetch(`${GARMIN_SIDECAR_URL}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } catch (err) {
      // Abort (cold-start timeout) / network failure → a stable GarminError so
      // routes map it to 502 rather than a bare 500.
      const timedOut = err instanceof Error && err.name === "AbortError";
      throw new GarminError(timedOut ? "sidecar timed out" : "sidecar was unreachable");
    }
    // The contract returns a JSON `{ status, ... }` body on 2xx AND on 4xx/5xx
    // (invalid_credentials, not_authenticated, garmin_error). Read it regardless.
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json || typeof json.status !== "string") {
      throw new GarminError(`sidecar returned a non-contract response (HTTP ${res.status})`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function callData(path: string, session: PersistedSession): Promise<Record<string, unknown>> {
  return callSidecar(path, { method: "POST", body: JSON.stringify({ session }) });
}

// ---- Helpers ----

function isPending(session: unknown): session is MfaPending {
  if (typeof session !== "object" || session === null) return false;
  const s = session as { mfaRequired?: unknown; cookies?: unknown };
  return s.mfaRequired === true && typeof s.cookies === "string";
}

// ---- Connect / MFA ----

/**
 * Start a Garmin connection. In DB mode the password is encrypted + stored (a
 * re-login fallback) regardless of the MFA outcome; in cookie mode it is never
 * stored (`store.persistsPassword === false`). On `mfa_required`, the
 * self-contained `pending` blob is stashed via the store so {@link submitMfa}
 * can resume it later — the connect flow is resumable, not fire-and-forget.
 */
export async function connectGarmin(
  store: SessionStore,
  creds: { username: string; password: string },
): Promise<{ status: "ok" | "mfa_required" | "invalid_credentials" }> {
  const res = await callSidecar("/garmin/login", { method: "POST", body: JSON.stringify(creds) });
  const encryptedPassword = store.persistsPassword ? await encryptPassword(creds.password) : undefined;

  if (res.status === "invalid_credentials") {
    return { status: "invalid_credentials" };
  }
  if (res.status === "mfa_required") {
    const pending = res.pending;
    if (!isPending(pending)) {
      throw new GarminError("sidecar returned mfa_required without a valid pending blob");
    }
    await store.persistPending(pending, creds.username, encryptedPassword);
    return { status: "mfa_required" };
  }
  if (res.status !== "ok" || !res.session) {
    throw new GarminError(`login failed: ${String(res.message ?? res.status)}`);
  }
  await store.persistSession(res.session as PersistedSession, {
    username: creds.username,
    encryptedPassword,
  });
  return { status: "ok" };
}

/** Resume a pending MFA challenge with the code the runner entered. */
export async function submitMfa(
  store: SessionStore,
  mfaCode: string,
): Promise<{ status: "ok" | "mfa_invalid" | "no_pending" }> {
  const state = await store.load();
  const pending = state?.session;
  if (!isPending(pending)) {
    return { status: "no_pending" };
  }
  const res = await callSidecar("/garmin/login/mfa", {
    method: "POST",
    body: JSON.stringify({ pending, mfaCode }),
  });
  if (res.status === "mfa_invalid") {
    return { status: "mfa_invalid" };
  }
  if (res.status !== "ok" || !res.session) {
    throw new GarminError(`mfa resume failed: ${String(res.message ?? res.status)}`);
  }
  await store.persistSession(res.session as PersistedSession);
  return { status: "ok" };
}

// ---- Disconnect ----

/**
 * Sever a runner's Garmin connection: delete the persisted credentials row and
 * clear any ephemeral session cookies, so no Garmin state remains in either
 * store. Leaves race_goals / workout_selections untouched.
 */
export async function disconnectGarmin(supabase: TypedSupabase, userId: string, cookies: AstroCookies): Promise<void> {
  const { error } = await supabase.from("garmin_credentials").delete().eq("user_id", userId);
  if (error) {
    throw new GarminError(`failed to disconnect Garmin: ${error.message}`);
  }
  clearSessionCookies(cookies);
}

// ---- Live data fetch (with silent re-login + snapshot cache) ----

/**
 * Silent re-login from the stored encrypted password. Throws {@link ReconnectRequiredError}
 * when it can't recover unattended (no stored password/username — always the case
 * in cookie mode — or Garmin re-challenges MFA) so the caller can surface an
 * interactive reconnect state.
 */
async function reLogin(store: SessionStore, state: GarminSessionState): Promise<PersistedSession> {
  const encrypted = state.encryptedPassword;
  const username = state.username;
  if (!encrypted || !username) {
    throw new ReconnectRequiredError();
  }
  const password = await decryptPassword(encrypted);
  const res = await callSidecar("/garmin/login", { method: "POST", body: JSON.stringify({ username, password }) });
  if (res.status === "mfa_required" || res.status !== "ok" || !res.session) {
    // MFA re-challenge (or any non-ok) → the stored password alone can't recover.
    throw new ReconnectRequiredError();
  }
  const session = res.session as PersistedSession;
  await store.persistSession(session);
  return session;
}

/**
 * Call one data endpoint with the current session; on `not_authenticated`, try a
 * silent re-login once and retry. Re-persists any refreshed session the sidecar
 * returns. Returns the raw contract JSON (caller plucks its field).
 */
async function fetchData(
  store: SessionStore,
  state: GarminSessionState,
  pathWithQuery: string,
): Promise<Record<string, unknown>> {
  const session = state.session;
  if (!session || isPending(session)) {
    throw new ReconnectRequiredError();
  }
  let res = await callData(pathWithQuery, session);
  if (res.status === "not_authenticated") {
    const fresh = await reLogin(store, state);
    res = await callData(pathWithQuery, fresh);
  }
  if (res.status !== "ok") {
    throw new GarminError(`data fetch failed: ${String(res.message ?? res.status)}`);
  }
  if (res.session) {
    await store.persistSession(res.session as PersistedSession);
  }
  return res;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The dashboard's one-shot fetch: recovery + last activities + today's scheduled
 * workout. Fetches recovery first (so an at-most-once re-login yields a fresh
 * session the other two reuse), then activities + scheduled-workout in parallel.
 * On any failure, serves the cached `last_snapshot` with `stale: true` (DB mode);
 * if there is no cache and the session is unrecoverable, flags `reconnectRequired`.
 */
export async function getDashboardData(store: SessionStore, date?: string): Promise<GarminDashboardData> {
  const state = await store.load();
  if (!state?.session || isPending(state.session)) {
    return { connected: false, recovery: null, activities: [], scheduledWorkout: null, stale: false };
  }

  const d = date ?? todayIso();
  try {
    const recRes = await fetchData(store, state, `/garmin/recovery?date=${encodeURIComponent(d)}`);
    // Recovery may have re-logged-in (or the sidecar may have rotated tokens),
    // persisting a fresh session. Reload state so activities + scheduled reuse
    // the live session — otherwise both would retry against the now-dead session
    // and each trigger its own re-login (up to 3 Garmin logins for one load).
    const stateForRest: GarminSessionState = (await store.load()) ?? state;
    const [actRes, schRes] = await Promise.all([
      fetchData(store, stateForRest, `/garmin/activities?limit=4`),
      fetchData(store, stateForRest, `/garmin/scheduled-workout?date=${encodeURIComponent(d)}`),
    ]);

    const data: GarminDashboardData = {
      connected: true,
      recovery: (recRes.recovery as GarminRecovery | undefined) ?? null,
      activities: (actRes.activities as GarminActivity[] | undefined) ?? [],
      scheduledWorkout: (schRes.workout as GarminScheduledWorkout | null | undefined) ?? null,
      stale: false,
    };
    await store.saveSnapshot(data);
    return data;
  } catch (err) {
    // A dead session that can't be silently recovered still surfaces the
    // reconnect CTA even when we can serve a cached snapshot (stale data +
    // reconnect prompt coexist — the UI shows both). In cookie mode `snapshot`
    // is always null, so a failure yields the no-cache branch (strict hygiene).
    const reconnectRequired = err instanceof ReconnectRequiredError;
    const cached = state.snapshot;
    if (cached) {
      return { ...cached, connected: true, stale: true, ...(reconnectRequired ? { reconnectRequired: true } : {}) };
    }
    return {
      connected: true,
      recovery: null,
      activities: [],
      scheduledWorkout: null,
      stale: true,
      ...(reconnectRequired ? { reconnectRequired: true } : {}),
    };
  }
}
