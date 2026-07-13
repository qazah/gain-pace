import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { connectGarmin, getDashboardData, submitMfa } from "./garmin";
import { decryptPassword, encryptPassword } from "./garmin-crypto";

type CredRow = Database["public"]["Tables"]["garmin_credentials"]["Row"];
type TypedSupabase = SupabaseClient<Database>;

// ---- Fake per-user Supabase client (records writes; serves a canned row) ----

interface FakeDb {
  client: TypedSupabase;
  upserts: Record<string, unknown>[];
  updates: Record<string, unknown>[];
}

function makeSupabase(initialRow: CredRow | null): FakeDb {
  const upserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => Promise.resolve({ data: initialRow, error: null }),
    upsert: (values: Record<string, unknown>) => {
      upserts.push(values);
      return Promise.resolve({ error: null });
    },
    update: (values: Record<string, unknown>) => {
      updates.push(values);
      return { eq: () => Promise.resolve({ error: null }) };
    },
  };
  const client = { from: () => builder } as unknown as TypedSupabase;
  return { client, upserts, updates };
}

function makeRow(overrides: Partial<CredRow>): CredRow {
  return {
    access_token: "at",
    created_at: "2026-01-01T00:00:00Z",
    expires_at: "2026-01-01T01:00:00Z",
    garmin_password_encrypted: null,
    garmin_user_id: null,
    id: "row-id",
    last_snapshot: null,
    last_synced_at: null,
    refresh_token: null,
    session_data: null,
    updated_at: "2026-01-01T00:00:00Z",
    user_id: "u1",
    ...overrides,
  };
}

// ---- Mocked sidecar (stubbed fetch) ----

const fetchMock = vi.fn<typeof fetch>();

function reply(body: Record<string, unknown>, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const SESSION = {
  oauth2Token: { access_token: "at1", token_type: "Bearer", refresh_token: "rt1", expires_in: 3600 },
};
const SESSION2 = {
  oauth2Token: { access_token: "at2", token_type: "Bearer", refresh_token: "rt2", expires_in: 3600 },
};
const RECOVERY = {
  date: "2026-07-12",
  sleepScore: 82,
  sleepDurationSeconds: 27000,
  deepSleepSeconds: 5400,
  lightSleepSeconds: 18000,
  remSleepSeconds: 3600,
  overnightHrv: 48,
  bodyBattery: { current: 60, high: 92, low: 20 },
};
const ACTIVITY = {
  id: "123",
  name: "Morning Run",
  type: "running",
  startTime: "2026-07-12T06:00:00",
  distanceMeters: 8000,
  durationSeconds: 2400,
  averageHeartRate: 152,
  calories: 520,
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("garmin-crypto", () => {
  it("round-trips the password (encrypt → decrypt returns original)", async () => {
    const encrypted = await encryptPassword("sup3r-s3cret");
    expect(encrypted).not.toContain("sup3r-s3cret");
    expect(await decryptPassword(encrypted)).toBe("sup3r-s3cret");
  });
});

describe("connectGarmin", () => {
  it("happy path persists the session and the encrypted (not plaintext) password", async () => {
    const db = makeSupabase(null);
    fetchMock.mockResolvedValueOnce(reply({ status: "ok", session: SESSION }));

    const result = await connectGarmin(db.client, "u1", { username: "runner@x.com", password: "pw" });

    expect(result.status).toBe("ok");
    expect(db.upserts).toHaveLength(1);
    expect(db.upserts[0]).toMatchObject({ user_id: "u1", session_data: SESSION, garmin_user_id: "runner@x.com" });
    const stored = db.upserts[0]?.garmin_password_encrypted;
    expect(typeof stored).toBe("string");
    expect(stored).not.toBe("pw");
    expect(await decryptPassword(stored as string)).toBe("pw");
  });

  it("mfa_required stashes the pending blob and the encrypted password", async () => {
    const db = makeSupabase(null);
    const pending = { mfaRequired: true, cookies: "c" };
    fetchMock.mockResolvedValueOnce(reply({ status: "mfa_required", pending }));

    const result = await connectGarmin(db.client, "u1", { username: "runner@x.com", password: "pw" });

    expect(result.status).toBe("mfa_required");
    expect(db.upserts[0]).toMatchObject({ session_data: pending });
    expect(db.upserts[0]?.garmin_password_encrypted).toBeTruthy();
  });

  it("invalid_credentials does not persist anything", async () => {
    const db = makeSupabase(null);
    fetchMock.mockResolvedValueOnce(reply({ status: "invalid_credentials" }, 400));

    const result = await connectGarmin(db.client, "u1", { username: "runner@x.com", password: "bad" });

    expect(result.status).toBe("invalid_credentials");
    expect(db.upserts).toHaveLength(0);
  });
});

describe("submitMfa", () => {
  it("resumes a pending challenge and persists the real session", async () => {
    const db = makeSupabase(makeRow({ session_data: { mfaRequired: true, cookies: "c" } }));
    fetchMock.mockResolvedValueOnce(reply({ status: "ok", session: SESSION }));

    const result = await submitMfa(db.client, "u1", "123456");

    expect(result.status).toBe("ok");
    expect(db.upserts[0]).toMatchObject({ session_data: SESSION });
  });

  it("returns mfa_invalid on a bad code without persisting", async () => {
    const db = makeSupabase(makeRow({ session_data: { mfaRequired: true, cookies: "c" } }));
    fetchMock.mockResolvedValueOnce(reply({ status: "mfa_invalid" }, 400));

    const result = await submitMfa(db.client, "u1", "000000");

    expect(result.status).toBe("mfa_invalid");
    expect(db.upserts).toHaveLength(0);
  });

  it("returns no_pending when there is no in-flight challenge", async () => {
    const db = makeSupabase(null);
    const result = await submitMfa(db.client, "u1", "123456");
    expect(result.status).toBe("no_pending");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getDashboardData", () => {
  it("returns connected:false when the user has never connected", async () => {
    const db = makeSupabase(null);
    const data = await getDashboardData(db.client, "u1");
    expect(data).toMatchObject({ connected: false, activities: [], recovery: null, scheduledWorkout: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("happy path returns live data and caches the snapshot", async () => {
    const db = makeSupabase(makeRow({ session_data: SESSION }));
    fetchMock
      .mockResolvedValueOnce(reply({ status: "ok", recovery: RECOVERY }))
      .mockResolvedValueOnce(reply({ status: "ok", activities: [ACTIVITY] }))
      .mockResolvedValueOnce(reply({ status: "ok", workout: null }));

    const data = await getDashboardData(db.client, "u1", "2026-07-12");

    expect(data.connected).toBe(true);
    expect(data.stale).toBe(false);
    expect(data.recovery).toEqual(RECOVERY);
    expect(data.activities).toEqual([ACTIVITY]);
    expect(data.scheduledWorkout).toBeNull();
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]?.last_snapshot).toBeTruthy();
  });

  it("re-logs in with the decrypted password when the session is not authenticated", async () => {
    const encrypted = await encryptPassword("pw");
    const db = makeSupabase(
      makeRow({ session_data: SESSION, garmin_user_id: "runner@x.com", garmin_password_encrypted: encrypted }),
    );
    fetchMock
      .mockResolvedValueOnce(reply({ status: "not_authenticated" }, 401)) // recovery attempt 1
      .mockResolvedValueOnce(reply({ status: "ok", session: SESSION2 })) // silent re-login
      .mockResolvedValueOnce(reply({ status: "ok", recovery: RECOVERY })) // recovery retry
      .mockResolvedValueOnce(reply({ status: "ok", activities: [] })) // activities
      .mockResolvedValueOnce(reply({ status: "ok", workout: null })); // scheduled

    const data = await getDashboardData(db.client, "u1", "2026-07-12");

    expect(data.connected).toBe(true);
    expect(data.recovery).toEqual(RECOVERY);
    // The re-login call carried the DECRYPTED password.
    const loginCall = fetchMock.mock.calls.find(([url]) => typeof url === "string" && url.endsWith("/garmin/login"));
    expect(loginCall).toBeDefined();
    const rawBody = loginCall?.[1]?.body;
    const parsed = JSON.parse(typeof rawBody === "string" ? rawBody : "{}") as { password?: string };
    expect(parsed.password).toBe("pw");
  });

  it("serves the cached snapshot with stale:true on a sidecar failure", async () => {
    const cached = {
      connected: true,
      recovery: RECOVERY,
      activities: [ACTIVITY],
      scheduledWorkout: null,
      stale: false,
    };
    const db = makeSupabase(makeRow({ session_data: SESSION, last_snapshot: cached }));
    fetchMock.mockRejectedValueOnce(new Error("sidecar unreachable"));

    const data = await getDashboardData(db.client, "u1", "2026-07-12");

    expect(data.stale).toBe(true);
    expect(data.recovery).toEqual(RECOVERY);
    expect(data.activities).toEqual([ACTIVITY]);
  });

  it("flags reconnectRequired when a dead session hits an MFA re-challenge on re-login", async () => {
    const encrypted = await encryptPassword("pw");
    const db = makeSupabase(
      makeRow({ session_data: SESSION, garmin_user_id: "runner@x.com", garmin_password_encrypted: encrypted }),
    );
    fetchMock
      .mockResolvedValueOnce(reply({ status: "not_authenticated" }, 401)) // recovery attempt 1
      .mockResolvedValueOnce(reply({ status: "mfa_required", pending: { mfaRequired: true, cookies: "c" } })); // re-login re-challenged

    const data = await getDashboardData(db.client, "u1", "2026-07-12");

    expect(data.connected).toBe(true);
    expect(data.stale).toBe(true);
    expect(data.reconnectRequired).toBe(true);
    expect(data.recovery).toBeNull();
  });
});
