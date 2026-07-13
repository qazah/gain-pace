import type { SupabaseClient } from "@supabase/supabase-js";
import { GARMIN_SIDECAR_URL, GARMIN_SIDECAR_SECRET } from "astro:env/server";
import type { Database } from "@/types/database";
import type { GarminActivity, GarminDashboardData, GarminRecovery, GarminScheduledWorkout } from "@/types";
import { decryptPassword, encryptPassword } from "./garmin-crypto";

/**
 * Worker-side Garmin service. The first outbound-HTTP module in the repo — the
 * reference pattern for talking to an external service.
 *
 * Responsibilities:
 * - own the typed client to the off-edge sidecar (HTTPS + shared bearer),
 * - persist / rehydrate the Garmin session + encrypted password in
 *   `garmin_credentials` (per-user Supabase client → RLS scoped to auth.uid()),
 * - re-login from the stored password when a session dies (enabled: Phase 2
 *   verified unattended re-login works for the non-MFA test account; an MFA
 *   re-challenge falls back to a "reconnect required" state),
 * - serve the cached `last_snapshot` with `stale: true` on any sidecar failure.
 *
 * The Worker never holds Garmin tokens directly or talks to Garmin — it only
 * calls our own sidecar contract (see sidecar/src/routes/*.ts).
 */

type TypedSupabase = SupabaseClient<Database>;
type CredRow = Database["public"]["Tables"]["garmin_credentials"]["Row"];

/** Minimal shape of garmin-connect-client's PersistedSession we depend on. */
interface Oauth2Token {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
}
interface PersistedSession {
  oauth2Token: Oauth2Token;
  [key: string]: unknown;
}
/** The self-contained MFA resume blob the sidecar returns on step 1 of login. */
interface MfaPending {
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

// ---- Persistence helpers ----

function isPending(session: unknown): session is MfaPending {
  if (typeof session !== "object" || session === null) return false;
  const s = session as { mfaRequired?: unknown; cookies?: unknown };
  return s.mfaRequired === true && typeof s.cookies === "string";
}

/** Best-effort expiry as ISO for the scalar `expires_at` column (used only for quick checks). */
function expiresAtIso(token: Oauth2Token): string {
  if (typeof token.expires_at === "number") {
    const ms = token.expires_at > 1e12 ? token.expires_at : token.expires_at * 1000;
    return new Date(ms).toISOString();
  }
  return new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString();
}

async function loadRow(supabase: TypedSupabase, userId: string): Promise<CredRow | null> {
  const { data } = await supabase.from("garmin_credentials").select("*").eq("user_id", userId).maybeSingle();
  return data;
}

/** Upsert the live session + scalar tokens; optionally the login username / encrypted password. */
async function persistSession(
  supabase: TypedSupabase,
  userId: string,
  session: PersistedSession,
  extra?: { username?: string; encryptedPassword?: string },
): Promise<void> {
  const token = session.oauth2Token;
  await supabase.from("garmin_credentials").upsert(
    {
      user_id: userId,
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? null,
      expires_at: expiresAtIso(token),
      session_data: session as unknown as Database["public"]["Tables"]["garmin_credentials"]["Row"]["session_data"],
      last_synced_at: new Date().toISOString(),
      ...(extra?.username ? { garmin_user_id: extra.username } : {}),
      ...(extra?.encryptedPassword ? { garmin_password_encrypted: extra.encryptedPassword } : {}),
    },
    { onConflict: "user_id" },
  );
}

// ---- Connect / MFA ----

/**
 * Start a Garmin connection. Encrypts + stores the password (a re-login fallback)
 * regardless of the MFA outcome. On `mfa_required`, the self-contained `pending`
 * blob is stashed in `session_data` so {@link submitMfa} can resume it later — the
 * connect flow is resumable, not fire-and-forget.
 */
export async function connectGarmin(
  supabase: TypedSupabase,
  userId: string,
  creds: { username: string; password: string },
): Promise<{ status: "ok" | "mfa_required" | "invalid_credentials" }> {
  const res = await callSidecar("/garmin/login", { method: "POST", body: JSON.stringify(creds) });
  const encryptedPassword = await encryptPassword(creds.password);

  if (res.status === "invalid_credentials") {
    return { status: "invalid_credentials" };
  }
  if (res.status === "mfa_required") {
    const pending = res.pending;
    if (!isPending(pending)) {
      throw new GarminError("sidecar returned mfa_required without a valid pending blob");
    }
    await supabase.from("garmin_credentials").upsert(
      {
        user_id: userId,
        access_token: "", // placeholder: no token until MFA resume completes
        expires_at: new Date(0).toISOString(),
        garmin_user_id: creds.username,
        garmin_password_encrypted: encryptedPassword,
        session_data: pending as unknown as CredRow["session_data"],
        last_synced_at: null,
      },
      { onConflict: "user_id" },
    );
    return { status: "mfa_required" };
  }
  if (res.status !== "ok" || !res.session) {
    throw new GarminError(`login failed: ${String(res.message ?? res.status)}`);
  }
  await persistSession(supabase, userId, res.session as PersistedSession, {
    username: creds.username,
    encryptedPassword,
  });
  return { status: "ok" };
}

/** Resume a pending MFA challenge with the code the runner entered. */
export async function submitMfa(
  supabase: TypedSupabase,
  userId: string,
  mfaCode: string,
): Promise<{ status: "ok" | "mfa_invalid" | "no_pending" }> {
  const row = await loadRow(supabase, userId);
  const pending = row?.session_data;
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
  await persistSession(supabase, userId, res.session as PersistedSession);
  return { status: "ok" };
}

// ---- Live data fetch (with silent re-login + snapshot cache) ----

/**
 * Silent re-login from the stored encrypted password. Throws {@link ReconnectRequiredError}
 * when it can't recover unattended (no stored password/username, or Garmin
 * re-challenges MFA) so the caller can surface an interactive reconnect state.
 */
async function reLogin(supabase: TypedSupabase, userId: string, row: CredRow): Promise<PersistedSession> {
  const encrypted = row.garmin_password_encrypted;
  const username = row.garmin_user_id;
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
  await persistSession(supabase, userId, session);
  return session;
}

/**
 * Call one data endpoint with the current session; on `not_authenticated`, try a
 * silent re-login once and retry. Re-persists any refreshed session the sidecar
 * returns. Returns the raw contract JSON (caller plucks its field).
 */
async function fetchData(
  supabase: TypedSupabase,
  userId: string,
  row: CredRow,
  pathWithQuery: string,
): Promise<Record<string, unknown>> {
  const session = row.session_data;
  if (!session || isPending(session)) {
    throw new ReconnectRequiredError();
  }
  let res = await callData(pathWithQuery, session as unknown as PersistedSession);
  if (res.status === "not_authenticated") {
    const fresh = await reLogin(supabase, userId, row);
    res = await callData(pathWithQuery, fresh);
  }
  if (res.status !== "ok") {
    throw new GarminError(`data fetch failed: ${String(res.message ?? res.status)}`);
  }
  if (res.session) {
    await persistSession(supabase, userId, res.session as PersistedSession);
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
 * On any failure, serves the cached `last_snapshot` with `stale: true`; if there
 * is no cache and the session is unrecoverable, flags `reconnectRequired`.
 */
export async function getDashboardData(
  supabase: TypedSupabase,
  userId: string,
  date?: string,
): Promise<GarminDashboardData> {
  const row = await loadRow(supabase, userId);
  if (!row || !row.session_data || isPending(row.session_data)) {
    return { connected: false, recovery: null, activities: [], scheduledWorkout: null, stale: false };
  }

  const d = date ?? todayIso();
  try {
    const recRes = await fetchData(supabase, userId, row, `/garmin/recovery?date=${encodeURIComponent(d)}`);
    // Recovery may have re-logged-in (or the sidecar may have rotated tokens),
    // persisting a fresh session. Reload the row so activities + scheduled reuse
    // the live session — otherwise both would retry against the now-dead session
    // and each trigger its own re-login (up to 3 Garmin logins for one load).
    const rowForRest: CredRow = (await loadRow(supabase, userId)) ?? row;
    const [actRes, schRes] = await Promise.all([
      fetchData(supabase, userId, rowForRest, `/garmin/activities?limit=4`),
      fetchData(supabase, userId, rowForRest, `/garmin/scheduled-workout?date=${encodeURIComponent(d)}`),
    ]);

    const data: GarminDashboardData = {
      connected: true,
      recovery: (recRes.recovery as GarminRecovery | undefined) ?? null,
      activities: (actRes.activities as GarminActivity[] | undefined) ?? [],
      scheduledWorkout: (schRes.workout as GarminScheduledWorkout | null | undefined) ?? null,
      stale: false,
    };
    await supabase
      .from("garmin_credentials")
      .update({
        last_snapshot: data as unknown as CredRow["last_snapshot"],
        last_synced_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
    return data;
  } catch (err) {
    // A dead session that can't be silently recovered still surfaces the
    // reconnect CTA even when we can serve a cached snapshot (stale data +
    // reconnect prompt coexist — the UI shows both).
    const reconnectRequired = err instanceof ReconnectRequiredError;
    const cached = row.last_snapshot as GarminDashboardData | null;
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
