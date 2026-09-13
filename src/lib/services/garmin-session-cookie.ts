import type { AstroCookies } from "astro";
import type { MfaPending, PersistedSession } from "./garmin";
import type { GarminSessionState, SessionStore } from "./garmin-session-store";
import { decryptString, encryptString } from "./garmin-crypto";

/**
 * Encrypted, chunked, session-scoped cookie storage for the Garmin session —
 * the backing for the "don't store my credentials" mode. The full session blob
 * (~5.6–8.3 KB encrypted, dominated by the tough-cookie jar) exceeds the ~4 KB
 * per-cookie ceiling, so it is split across numbered chunk cookies plus a count
 * cookie. Nothing is written server-side; nothing is cached.
 *
 * Cookies: `gc_sess_n` (chunk count) + `gc_sess_0..N-1` (blob chunks).
 * Attributes: httpOnly + secure + sameSite=lax + path=/, and NO maxAge/expires
 * (a browser-session cookie — cleared on browser close).
 */

const CHUNK_PREFIX = "gc_sess_";
const COUNT_COOKIE = "gc_sess_n";
/** Per-chunk value cap — headroom under the ~4 KB per-cookie ceiling after name + attrs. */
const MAX_CHUNK_LEN = 3500;
/** Generous upper bound cleared on write/clear so a shrinking blob never orphans a stale chunk. */
const MAX_CHUNKS = 8;

const COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const;

/** Read a cookie value via the AstroCookies API, falling back to the raw request header. */
function readRaw(cookies: AstroCookies, requestHeaders: Headers, name: string): string | undefined {
  const viaApi = cookies.get(name)?.value;
  if (viaApi != null && viaApi !== "") return viaApi;
  // Fallback mirrors src/lib/supabase.ts: parse the incoming Cookie header directly.
  const header = requestHeaders.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}

/** Delete the count cookie and every possible chunk cookie (bounded by MAX_CHUNKS). */
export function clearSessionCookies(cookies: AstroCookies): void {
  cookies.delete(COUNT_COOKIE, { path: "/" });
  for (let i = 0; i < MAX_CHUNKS; i++) {
    cookies.delete(`${CHUNK_PREFIX}${i}`, { path: "/" });
  }
}

/** Encrypt + chunk `value` into the session cookies, clearing any prior (larger) set first. */
export async function writeSessionCookies(cookies: AstroCookies, value: object): Promise<void> {
  const blob = await encryptString(JSON.stringify(value));
  const chunks: string[] = [];
  for (let i = 0; i < blob.length; i += MAX_CHUNK_LEN) {
    chunks.push(blob.slice(i, i + MAX_CHUNK_LEN));
  }
  if (chunks.length > MAX_CHUNKS) {
    // Should never happen for a Garmin session (2–3 chunks); guard rather than orphan.
    throw new Error(`Garmin session too large for cookies: ${chunks.length} chunks`);
  }
  clearSessionCookies(cookies); // deletes stale chunks; sets below override the deletes for reused names
  cookies.set(COUNT_COOKIE, String(chunks.length), COOKIE_OPTS);
  chunks.forEach((chunk, i) => {
    cookies.set(`${CHUNK_PREFIX}${i}`, chunk, COOKIE_OPTS);
  });
}

/**
 * Reassemble + decrypt the session object from cookies. Returns `null` (never a
 * partial) if the count or any chunk is missing, or the blob can't be decrypted.
 */
export async function readSessionCookies(cookies: AstroCookies, requestHeaders: Headers): Promise<object | null> {
  const countRaw = readRaw(cookies, requestHeaders, COUNT_COOKIE);
  if (!countRaw) return null;
  const count = Number.parseInt(countRaw, 10);
  if (!Number.isInteger(count) || count <= 0 || count > MAX_CHUNKS) return null;

  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const chunk = readRaw(cookies, requestHeaders, `${CHUNK_PREFIX}${i}`);
    if (chunk == null) return null; // missing chunk → treat as no session
    parts.push(chunk);
  }
  try {
    return JSON.parse(await decryptString(parts.join(""))) as object;
  } catch {
    return null; // tampered / undecryptable → no session
  }
}

/**
 * Ephemeral store: the session lives only in the browser's session cookies.
 * No password, no username, no snapshot are ever persisted — so silent re-login
 * is unavailable (a dead session surfaces the interactive reconnect prompt) and
 * a failed fetch has no cached snapshot to fall back to (strict hygiene).
 */
export class CookieSessionStore implements SessionStore {
  readonly persistsPassword = false;

  constructor(
    private readonly cookies: AstroCookies,
    private readonly requestHeaders: Headers,
  ) {}

  async load(): Promise<GarminSessionState | null> {
    const session = (await readSessionCookies(this.cookies, this.requestHeaders)) as
      | PersistedSession
      | MfaPending
      | null;
    if (!session) return null;
    return { session, encryptedPassword: null, username: null, snapshot: null };
  }

  async persistSession(session: PersistedSession): Promise<void> {
    await writeSessionCookies(this.cookies, session);
  }

  async persistPending(pending: MfaPending): Promise<void> {
    await writeSessionCookies(this.cookies, pending);
  }

  async saveSnapshot(): Promise<void> {
    // Strict hygiene: nothing is cached server-side in cookie-only mode.
  }

  clear(): Promise<void> {
    clearSessionCookies(this.cookies);
    return Promise.resolve();
  }
}
