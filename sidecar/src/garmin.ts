import { fromSession } from "garmin-connect-client";
import type { GarminConnectClient, PersistedSession } from "garmin-connect-client";

/**
 * connectapi.garmin.com base — the DATA host. Unlike sso.garmin.com it accepts
 * a plain OAuth2 bearer (no TLS/JA3 impersonation), so we can call it with the
 * global fetch. Used for the gaps garmin-connect-client doesn't cover:
 * Body Battery + the calendar (scheduled workout).
 */
const CONNECT_API = "https://connectapi.garmin.com";

/**
 * A Garmin User-Agent. connectapi is lenient on TLS but some endpoints still
 * expect a non-empty UA + the `NK` header the web app sends. If a raw call
 * 403s during live testing, this is the first place to adjust.
 */
const GARMIN_HEADERS = {
  "User-Agent": "GainPace-Sidecar/0.1 (+https://github.com/kzacha/gain-pace)",
  NK: "NT",
  "Accept": "application/json",
} as const;

export interface RehydratedClient {
  client: GarminConnectClient;
  /** Returns the refreshed session if the library auto-refreshed tokens during this request, else null. */
  takeRefreshedSession(): PersistedSession | null;
}

/**
 * Rehydrate a client from a persisted session (no network) and wire up the
 * onSessionUpdate hook so the caller can re-persist rotated tokens. The Worker
 * MUST write the refreshed session back to Supabase when this is non-null.
 */
export function rehydrate(session: PersistedSession): RehydratedClient {
  const client = fromSession(session);
  let refreshed: PersistedSession | null = null;
  client.onSessionUpdate((s) => {
    refreshed = s;
  });
  return {
    client,
    takeRefreshedSession: () => refreshed,
  };
}

/** Authorization header value from a persisted session's OAuth2 token. */
function bearer(session: PersistedSession): string {
  const t = session.oauth2Token;
  return `${t.token_type} ${t.access_token}`;
}

/**
 * Raw authenticated GET against connectapi.garmin.com. `path` is absolute from
 * the host root (e.g. `/wellness-service/...`). Throws on non-2xx so routes can
 * map to a stable error code.
 */
export async function connectApiGet<T = unknown>(session: PersistedSession, path: string): Promise<T> {
  const res = await fetch(`${CONNECT_API}${path}`, {
    headers: {
      ...GARMIN_HEADERS,
      Authorization: bearer(session),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`connectapi ${res.status} on ${path}: ${body.slice(0, 200)}`) as Error & {
      statusCode?: number;
    };
    err.statusCode = res.status;
    throw err;
  }
  return (await res.json()) as T;
}
