import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { GarminDashboardData } from "@/types";
import type { MfaPending, Oauth2Token, PersistedSession } from "./garmin";
import { GarminError } from "./garmin";

/**
 * Session-store seam: normalizes how a Garmin session is loaded, persisted,
 * snapshotted, and cleared, so the connect/MFA/fetch logic in `garmin.ts` is
 * agnostic to *where* the session lives. Two implementations exist:
 * - {@link DbSessionStore} — the default; persists to `garmin_credentials`
 *   (reproduces the pre-seam behavior exactly).
 * - `CookieSessionStore` (see `garmin-session-cookie.ts`) — the ephemeral,
 *   nothing-server-side mode.
 */

type TypedSupabase = SupabaseClient<Database>;
type CredRow = Database["public"]["Tables"]["garmin_credentials"]["Row"];

/** Normalized session state the service reasons over, regardless of backing store. */
export interface GarminSessionState {
  session: PersistedSession | MfaPending | null;
  /** DB mode only — the re-login fallback. `null` in cookie mode (no silent re-login). */
  encryptedPassword: string | null;
  /** DB mode only — the Garmin login username. */
  username: string | null;
  /** DB mode only — last-good snapshot for graceful degradation. `null` in cookie mode. */
  snapshot: GarminDashboardData | null;
}

export interface SessionStore {
  /** true → the store persists the encrypted password (enables silent re-login). */
  readonly persistsPassword: boolean;
  load(): Promise<GarminSessionState | null>;
  persistSession(session: PersistedSession, extra?: { username?: string; encryptedPassword?: string }): Promise<void>;
  persistPending(pending: MfaPending, username: string, encryptedPassword?: string): Promise<void>;
  saveSnapshot(data: GarminDashboardData): Promise<void>;
  clear(): Promise<void>;
}

/** Best-effort expiry as ISO for the scalar `expires_at` column (used only for quick checks). */
function expiresAtIso(token: Oauth2Token): string {
  if (typeof token.expires_at === "number") {
    const ms = token.expires_at > 1e12 ? token.expires_at : token.expires_at * 1000;
    return new Date(ms).toISOString();
  }
  return new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString();
}

/**
 * Default store: persists the session + scalar tokens (+ optional username /
 * encrypted password) to `garmin_credentials`, RLS-scoped to the auth user.
 * Behavior is a 1:1 port of the pre-seam `loadRow` / `persistSession` /
 * snapshot-update / row-delete logic.
 */
export class DbSessionStore implements SessionStore {
  readonly persistsPassword = true;

  constructor(
    private readonly supabase: TypedSupabase,
    private readonly userId: string,
  ) {}

  async load(): Promise<GarminSessionState | null> {
    const { data } = await this.supabase
      .from("garmin_credentials")
      .select("*")
      .eq("user_id", this.userId)
      .maybeSingle();
    if (!data) return null;
    const row = data;
    return {
      session: (row.session_data as unknown as PersistedSession | MfaPending | null) ?? null,
      encryptedPassword: row.garmin_password_encrypted,
      username: row.garmin_user_id,
      snapshot: (row.last_snapshot as unknown as GarminDashboardData | null) ?? null,
    };
  }

  async persistSession(
    session: PersistedSession,
    extra?: { username?: string; encryptedPassword?: string },
  ): Promise<void> {
    const token = session.oauth2Token;
    const { error } = await this.supabase.from("garmin_credentials").upsert(
      {
        user_id: this.userId,
        access_token: token.access_token,
        refresh_token: token.refresh_token ?? null,
        expires_at: expiresAtIso(token),
        session_data: session as unknown as CredRow["session_data"],
        last_synced_at: new Date().toISOString(),
        ...(extra?.username ? { garmin_user_id: extra.username } : {}),
        ...(extra?.encryptedPassword ? { garmin_password_encrypted: extra.encryptedPassword } : {}),
      },
      { onConflict: "user_id" },
    );
    if (error) {
      throw new GarminError(`failed to persist Garmin session: ${error.message}`);
    }
  }

  async persistPending(pending: MfaPending, username: string, encryptedPassword?: string): Promise<void> {
    const { error } = await this.supabase.from("garmin_credentials").upsert(
      {
        user_id: this.userId,
        access_token: "", // placeholder: no token until MFA resume completes
        expires_at: new Date(0).toISOString(),
        garmin_user_id: username,
        session_data: pending as unknown as CredRow["session_data"],
        last_synced_at: null,
        ...(encryptedPassword ? { garmin_password_encrypted: encryptedPassword } : {}),
      },
      { onConflict: "user_id" },
    );
    if (error) {
      throw new GarminError(`failed to persist Garmin session: ${error.message}`);
    }
  }

  async saveSnapshot(data: GarminDashboardData): Promise<void> {
    await this.supabase
      .from("garmin_credentials")
      .update({
        last_snapshot: data as unknown as CredRow["last_snapshot"],
        last_synced_at: new Date().toISOString(),
      })
      .eq("user_id", this.userId);
  }

  async clear(): Promise<void> {
    const { error } = await this.supabase.from("garmin_credentials").delete().eq("user_id", this.userId);
    if (error) {
      throw new GarminError(`failed to disconnect Garmin: ${error.message}`);
    }
  }
}
