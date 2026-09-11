import { vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { GarminActivity, RaceGoal } from "@/types";
import type { PersistedSession } from "@/lib/services/garmin";
import type { GarminSessionState, SessionStore } from "@/lib/services/garmin-session-store";
import type { AnthropicClient } from "@/lib/services/recommendations";

/**
 * Shared hermetic environment for the recommendation-service tests: a fake
 * SessionStore, a table-aware fake Supabase, a stubbed sidecar `fetch`, and a
 * queued model client. Nothing here touches a network, a database, or a model.
 *
 * Network isolation follows the repo idiom established in
 * `src/lib/services/garmin.test.ts` (global fetch replaced with a vi.fn); the
 * model client is injected through `RecommendationDeps` instead, so a failure
 * case costs no SDK retry budget.
 */

type TypedSupabase = SupabaseClient<Database>;

// ---- Runner fixture ----
// A runner whose recent sessions are ~40 min (median 40) and whose implied pace
// is 1000/3 ≈ 333 s/km ("5:33/km") — distance is set to 3 m per second of
// running throughout. Both figures are stated here as the single source the
// assertions reason from; no test imports a guardrail constant.

/** Recent-run durations in seconds: median 40 min. */
const RECENT_DURATIONS = [2400, 2100, 2700, 2400];

export function activity(durationSeconds: number): GarminActivity {
  return {
    id: `a-${durationSeconds}`,
    name: "Run",
    type: "running",
    startTime: "2026-09-10T06:00:00",
    distanceMeters: durationSeconds * 3,
    durationSeconds,
    averageHeartRate: 150,
    calories: 400,
  };
}

export const RECENT_ACTIVITIES: GarminActivity[] = RECENT_DURATIONS.map(activity);

const RECOVERY = {
  date: "2026-09-11",
  sleepScore: 82,
  sleepDurationSeconds: 27000,
  deepSleepSeconds: 5400,
  lightSleepSeconds: 18000,
  remSleepSeconds: 3600,
  overnightHrv: 48,
  bodyBattery: { current: 60, high: 92, low: 20 },
};

export const RACE_GOAL: RaceGoal = {
  created_at: "2026-09-01T00:00:00Z",
  distance_km: 21.1,
  event_date: "2026-12-06",
  event_name: "Winter Half",
  id: "goal-1",
  is_active: true,
  target_finish_seconds: 6300,
  updated_at: "2026-09-01T00:00:00Z",
  user_id: "u1",
};

// ---- Model response fixture ----
// Three alternatives that all clear both guardrails against RECENT_ACTIVITIES:
// every duration sits inside [12, 100] min, every step pace inside its effort
// band around the ~5:33/km anchor, and every step list sums to its total.

export const VALID_ALTERNATIVES = [
  {
    workout_type: "Easy run",
    duration_minutes: 40,
    ai_explanation: "Your recovery is solid, so an easy hour keeps the week moving without cost.",
    training_arc_note: "Keeps you on pace to the goal without spending anything you need later.",
    recovery_warning: "",
    summary: "40 min easy 6:00/km",
    steps: [{ effort: "easy", duration_minutes: 40, target_pace: "6:00" }],
  },
  {
    workout_type: "Tempo",
    duration_minutes: 50,
    ai_explanation: "You have the time and the freshness for a controlled tempo today.",
    training_arc_note: "Speeds up fitness gains at the cost of feeling it tomorrow.",
    recovery_warning: "",
    summary: "50 min with 20 min tempo",
    steps: [
      { effort: "warmup", duration_minutes: 15, target_pace: "6:00" },
      { effort: "tempo", duration_minutes: 20, target_pace: "5:00" },
      { effort: "cooldown", duration_minutes: 15, target_pace: "6:00" },
    ],
  },
  {
    workout_type: "Intervals",
    duration_minutes: 45,
    ai_explanation: "Short, sharp reps if you want intensity without a long session.",
    training_arc_note: "Banks speed now, trading a little freshness for the days ahead.",
    recovery_warning: "",
    summary: "45 min with short reps",
    steps: [
      { effort: "warmup", duration_minutes: 10, target_pace: "6:15" },
      { effort: "interval", duration_minutes: 5, target_pace: "4:30" },
      { effort: "recovery", duration_minutes: 10, target_pace: "6:30" },
      { effort: "cooldown", duration_minutes: 20, target_pace: "6:00" },
    ],
  },
];

/** A well-formed model payload; pass overrides to bend one alternative out of band. */
export function modelPayload(alternatives: unknown[] = VALID_ALTERNATIVES): { alternatives: unknown[] } {
  return { alternatives };
}

/** Wrap any body as the Anthropic message the service parses. */
export function modelMessage(body: unknown, overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg-1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body), citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 500 },
    ...overrides,
  } as unknown as Anthropic.Message;
}

// ---- Fakes ----

const SESSION = {
  oauth2Token: { access_token: "at1", token_type: "Bearer", refresh_token: "rt1", expires_in: 3600 },
} as unknown as PersistedSession;

function reply(body: Record<string, unknown>): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

export interface RecommendationEnv {
  supabase: TypedSupabase;
  store: SessionStore;
  /** Injected model client — pass as `{ client }` in RecommendationDeps. */
  client: AnthropicClient;
  /** Queue what the model returns (a Message) or throws (an Error), per attempt. */
  queue: (...items: (Anthropic.Message | Error)[]) => void;
  /** How many model calls were made. */
  calls: () => number;
  /** Rows written to recommendation_usage (the daily-cap bump). */
  usageUpserts: Record<string, unknown>[];
  /** Snapshots the dashboard fetch persisted through the store. */
  snapshots: unknown[];
}

export interface EnvOptions {
  /** Recent activities the guardrails derive their bands from. */
  activities?: GarminActivity[];
  /** The runner's active goal; null gates the request as not-ready. */
  goal?: RaceGoal | null;
  /** Generations already counted against today's cap. */
  usedToday?: number;
}

/**
 * Build the environment. Replaces global fetch, so call it inside a test (or a
 * beforeEach) — never at module scope.
 */
export function makeRecommendationEnv(options: EnvOptions = {}): RecommendationEnv {
  const { activities = RECENT_ACTIVITIES, goal = RACE_GOAL, usedToday = 0 } = options;

  // Sidecar: route by path, the same three calls getDashboardData makes.
  const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/garmin/recovery")) return Promise.resolve(reply({ status: "ok", recovery: RECOVERY }));
    if (url.includes("/garmin/activities")) return Promise.resolve(reply({ status: "ok", activities }));
    if (url.includes("/garmin/scheduled-workout")) return Promise.resolve(reply({ status: "ok", workout: null }));
    return Promise.reject(new Error(`unexpected sidecar call: ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);

  const snapshots: unknown[] = [];
  const store: SessionStore = {
    persistsPassword: true,
    load: () =>
      Promise.resolve<GarminSessionState>({
        session: SESSION,
        encryptedPassword: null,
        username: "runner@example.test",
        snapshot: null,
      }),
    persistSession: () => Promise.resolve(),
    persistPending: () => Promise.resolve(),
    saveSnapshot: (data) => {
      snapshots.push(data);
      return Promise.resolve();
    },
    clear: () => Promise.resolve(),
  };

  // Table-aware fake: race_goals is read, recommendation_usage is read + bumped.
  const usageUpserts: Record<string, unknown>[] = [];
  const supabase = {
    from: (table: string) => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () =>
          Promise.resolve(
            table === "race_goals" ? { data: goal, error: null } : { data: { count: usedToday }, error: null },
          ),
        upsert: (values: Record<string, unknown>) => {
          usageUpserts.push(values);
          return Promise.resolve({ error: null });
        },
      };
      return builder;
    },
  } as unknown as TypedSupabase;

  const queued: (Anthropic.Message | Error)[] = [];
  let calls = 0;
  const client = {
    messages: {
      create: () => {
        calls++;
        const next = queued.shift();
        if (!next) return Promise.reject(new Error("no model response queued for this attempt"));
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
    },
  } as unknown as AnthropicClient;

  return {
    supabase,
    store,
    client,
    queue: (...items) => queued.push(...items),
    calls: () => calls,
    usageUpserts,
    snapshots,
  };
}
