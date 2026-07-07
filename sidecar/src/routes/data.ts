import { Router } from "express";
import { z } from "zod";
import { DateTime } from "luxon";
import type { PersistedSession } from "garmin-connect-client";
import { NotAuthenticatedError } from "garmin-connect-client";
import { rehydrate, connectApiGet } from "../garmin.js";

export const dataRouter = Router();

/**
 * Data endpoints deviate from the plan's `GET …?param=` contract in one way:
 * they are POST, because the persisted session (OAuth tokens + cookies) is too
 * large to travel safely in a query string or header. Path + query params match
 * the plan; the session rides in the JSON body. Response always includes the
 * refreshed session when the library rotated tokens mid-request (`session` key),
 * which the Worker must re-persist.
 */
const sessionBody = z.object({
  session: z.object({
    cookies: z.string().optional(),
    oauth2Token: z.object({ access_token: z.string(), token_type: z.string() }).passthrough(),
    diClientId: z.string(),
  }),
});

function todayIso(): string {
  return DateTime.now().toISODate() ?? "1970-01-01";
}

/** Parse an ISO date, falling back to today if it's invalid. Always returns a valid DateTime. */
function validDate(date: string): DateTime<true> {
  const dt = DateTime.fromISO(date);
  return dt.isValid ? dt : DateTime.now();
}

interface HandlerCtx {
  session: PersistedSession;
  client: import("garmin-connect-client").GarminConnectClient;
}

/** Wrap a data handler: validate session, rehydrate ONCE, run, attach refreshed session, map errors. */
function withSession(handler: (ctx: HandlerCtx, req: import("express").Request) => Promise<unknown>) {
  const routeHandler: import("express").RequestHandler = (req, res) => {
    void (async () => {
      const parsed = sessionBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ status: "bad_request", issues: parsed.error.flatten() });
        return;
      }
      // Use the raw session (not the zod-parsed copy) so no OAuth/cookie fields
      // are lost to schema stripping before we hand it to the library.
      const session = (req.body as { session: PersistedSession }).session;
      const { client, takeRefreshedSession } = rehydrate(session);
      try {
        const data = await handler({ session, client }, req);
        const refreshed = takeRefreshedSession();
        res.json({ status: "ok", ...(data as object), ...(refreshed ? { session: refreshed } : {}) });
      } catch (err) {
        if (err instanceof NotAuthenticatedError) {
          res.status(401).json({ status: "not_authenticated" });
          return;
        }
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 401 || statusCode === 403) {
          res.status(401).json({ status: "not_authenticated" });
          return;
        }
        res.status(502).json({ status: "garmin_error", message: (err as Error).message });
      }
    })();
  };
  return routeHandler;
}

// ---- Minimal shapes we pluck from Garmin's raw payloads (defensive, not exhaustive) ----

interface RawActivity {
  activityId?: number | string;
  activityName?: string;
  activityType?: { typeKey?: string };
  startTimeLocal?: string;
  distance?: number;
  duration?: number;
  averageHR?: number;
  calories?: number;
}

interface RawSleep {
  dailySleepDTO?: {
    sleepScores?: { overall?: { value?: number } };
    deepSleepSeconds?: number | null;
    lightSleepSeconds?: number | null;
    remSleepSeconds?: number | null;
    sleepTimeSeconds?: number | null;
    avgOvernightHrv?: number | null;
  };
}

interface RawBodyBattery {
  bodyBatteryValuesArray?: [number, number][];
}

/**
 * POST /garmin/activities?limit=4 — recent activities.
 * Uses the library's typed getActivities().
 */
dataRouter.post(
  "/activities",
  withSession(async ({ client }, req) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 4) || 4, 1), 20);
    const raw = (await client.getActivities(0, limit)) as unknown as RawActivity[];
    const activities = raw.map((a) => ({
      id: String(a.activityId ?? ""),
      name: a.activityName ?? null,
      type: a.activityType?.typeKey ?? null,
      startTime: a.startTimeLocal ?? null,
      distanceMeters: a.distance ?? null,
      durationSeconds: a.duration ?? null,
      averageHeartRate: a.averageHR ?? null,
      calories: a.calories ?? null,
    }));
    return { activities };
  }),
);

/**
 * POST /garmin/recovery?date=YYYY-MM-DD — recovery metrics.
 * Sleep (score + stages + overnight HRV) via the library; Body Battery via a
 * raw connectapi call. HRV for S-01 is the sleep-scoped overnight HRV.
 */
dataRouter.post(
  "/recovery",
  withSession(async ({ session, client }, req) => {
    const date = typeof req.query.date === "string" ? req.query.date : todayIso();

    const sleepRaw = (await client.sleep
      .getDailySleepData(validDate(date))
      .catch(() => null)) as RawSleep | null;
    const dto = sleepRaw?.dailySleepDTO;

    let bodyBattery: { current: number | null; high: number | null; low: number | null } = {
      current: null,
      high: null,
      low: null,
    };
    try {
      const bb = await connectApiGet<RawBodyBattery[]>(
        session,
        `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${date}&endDate=${date}`,
      );
      const values = bb[0]?.bodyBatteryValuesArray ?? [];
      const levels = values.map((v) => v[1]).filter((n): n is number => typeof n === "number");
      if (levels.length > 0) {
        bodyBattery = {
          current: levels[levels.length - 1] ?? null,
          high: Math.max(...levels),
          low: Math.min(...levels),
        };
      }
    } catch {
      // Body Battery is best-effort; recovery still returns sleep.
    }

    return {
      recovery: {
        date,
        sleepScore: dto?.sleepScores?.overall?.value ?? null,
        sleepDurationSeconds: dto?.sleepTimeSeconds ?? null,
        deepSleepSeconds: dto?.deepSleepSeconds ?? null,
        lightSleepSeconds: dto?.lightSleepSeconds ?? null,
        remSleepSeconds: dto?.remSleepSeconds ?? null,
        overnightHrv: dto?.avgOvernightHrv ?? null,
        bodyBattery,
      },
    };
  }),
);

interface RawCalendarItem {
  itemType?: string;
  date?: string;
  title?: string;
  workoutId?: number | string;
  id?: number | string;
}
interface RawCalendar {
  calendarItems?: RawCalendarItem[];
}

/**
 * POST /garmin/scheduled-workout?date=YYYY-MM-DD — today's scheduled workout
 * from the Garmin calendar (raw connectapi; month is 0-indexed). Returns
 * { workout } or { workout: null } to drive the manual-entry fallback.
 */
dataRouter.post(
  "/scheduled-workout",
  withSession(async ({ session }, req) => {
    const date = typeof req.query.date === "string" ? req.query.date : todayIso();
    const d = validDate(date);
    const year = d.year;
    const month0 = d.month - 1; // connectapi calendar month is 0-indexed

    const calendar = await connectApiGet<RawCalendar>(session, `/calendar-service/year/${year}/month/${month0}`);
    const items = calendar.calendarItems ?? [];
    const match = items.find(
      (it) => it.date === date && (it.itemType === "workout" || it.itemType === "scheduledWorkout"),
    );

    if (!match) {
      return { workout: null };
    }
    return {
      workout: {
        id: String(match.workoutId ?? match.id ?? ""),
        title: match.title ?? null,
        date: match.date ?? date,
      },
    };
  }),
);
