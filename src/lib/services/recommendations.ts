import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY } from "astro:env/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type {
  GarminDashboardData,
  RaceGoal,
  RecommendationResult,
  WorkoutAlternative,
  WorkoutModifiers,
} from "@/types";
import { getDashboardData } from "./garmin";
import { getActiveRaceGoal } from "./race-goals";
import { RECOMMENDATION_JSON_SCHEMA, parseRecommendation, validateAlternatives } from "@/lib/recommendation-guardrail";

/**
 * Worker-side recommendation service (S-03). Fuses Garmin data + active race
 * goal + today's modifiers into one Claude Haiku structured-output call, guards
 * the result against implausible load (one bounded re-prompt), enforces a soft
 * daily cap, and returns a primary + 2 alternatives. Mirrors garmin.ts's typed
 * error taxonomy; the route maps each error to a stable JSON status.
 */

type TypedSupabase = SupabaseClient<Database>;

const MODEL = "claude-haiku-4-5";
const TIMEOUT_MS = 9_000; // stay inside the 10s p95 NFR
const MAX_TOKENS = 2048; // the structured output is small
const DAILY_CAP = 10; // soft per-user daily generation cap
const RANKS = ["primary", "alt_1", "alt_2"] as const;

// ---- Error taxonomy the API route maps to stable JSON ----

/** ANTHROPIC_API_KEY not set — the config banner should already show. */
export class LlmNotConfiguredError extends Error {
  constructor() {
    super("Anthropic API key is not configured");
    this.name = "LlmNotConfiguredError";
  }
}
/** A model/network failure, refusal, or an unrecoverable guardrail violation. */
export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmError";
  }
}
/** A prerequisite (goal or Garmin connection) is missing — gate, don't 500. */
export class RecommendationNotReadyError extends Error {
  constructor(public reason: "goal" | "garmin") {
    super(`recommendation not ready: missing ${reason}`);
    this.name = "RecommendationNotReadyError";
  }
}
/** The soft daily generation cap has been reached. */
export class RecommendationRateLimitedError extends Error {
  constructor() {
    super("daily recommendation cap reached");
    this.name = "RecommendationRateLimitedError";
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function recoveryIsMissing(data: GarminDashboardData): boolean {
  const r = data.recovery;
  return (
    !r ||
    (r.sleepScore == null && r.overnightHrv == null && r.sleepDurationSeconds == null && r.bodyBattery.current == null)
  );
}

// ---- Daily cap (recommendation_usage) ----

async function readTodayCount(supabase: TypedSupabase, userId: string): Promise<number> {
  const { data } = await supabase
    .from("recommendation_usage")
    .select("count")
    .eq("user_id", userId)
    .eq("day", todayIso())
    .maybeSingle();
  return data?.count ?? 0;
}

async function bumpTodayCount(supabase: TypedSupabase, userId: string, current: number): Promise<void> {
  await supabase
    .from("recommendation_usage")
    .upsert(
      { user_id: userId, day: todayIso(), count: current + 1, updated_at: new Date().toISOString() },
      { onConflict: "user_id,day" },
    );
}

// ---- Prompt ----

const SYSTEM_PROMPT = [
  "You are a running coach that adapts today's workout to the runner's real state.",
  "You will receive the runner's recent activities, last night's recovery metrics, their race goal, and today's modifiers (time available, intensity preference, how they feel).",
  "Return exactly 3 workout alternatives, ordered best-fit-first: the first is your primary recommendation, the other two are 'if you prefer' options.",
  "Each alternative has four fields:",
  "workout_type is a short label; duration_minutes is an integer.",
  "ai_explanation is one or two plain-language sentences (no jargon, no raw numbers) about why this workout fits the runner TODAY — their recovery state, their available time, and how they feel. Keep it about today's readiness; do not talk about the race goal or long-term progress here.",
  "training_arc_note is exactly one plain-language sentence (no jargon, no raw numbers) that frames THIS specific option as a choice: what the runner GAINS by picking it and what they TRADE, in terms of long-term progress toward their race goal over the weeks to race day (for example: staying on pace to the goal as the best-balanced call, banking recovery now to train harder in the coming days, or speeding up fitness gains at the cost of more fatigue tomorrow). Across the three alternatives make these notes clearly distinct, so the runner can see why they would choose one over another. It is about the long-term trade of this choice, not today's fit, and must not repeat ai_explanation.",
  "Safety: never prescribe a volume or intensity implausible given the runner's last few activities. Keep durations sensible relative to their recent sessions and today's available time. Respect the modifiers — a tired runner or a short time window means a lighter/shorter session.",
].join(" ");

function buildUserContext(dashboard: GarminDashboardData, goal: RaceGoal, modifiers: WorkoutModifiers): string {
  const daysToRace = Math.max(0, Math.round((Date.parse(goal.event_date) - Date.now()) / 86_400_000));
  const activities = dashboard.activities.slice(0, 4).map((a) => ({
    type: a.type,
    distance_km: a.distanceMeters != null ? +(a.distanceMeters / 1000).toFixed(1) : null,
    duration_min: a.durationSeconds != null ? Math.round(a.durationSeconds / 60) : null,
    avg_hr: a.averageHeartRate,
  }));
  const recovery = recoveryIsMissing(dashboard)
    ? "no recovery data synced for today"
    : {
        sleep_score: dashboard.recovery?.sleepScore ?? null,
        overnight_hrv: dashboard.recovery?.overnightHrv ?? null,
        body_battery: dashboard.recovery?.bodyBattery.current ?? null,
      };

  return JSON.stringify(
    {
      race_goal: {
        event: goal.event_name,
        date: goal.event_date,
        days_to_race: daysToRace,
        distance_km: goal.distance_km,
        target_finish_seconds: goal.target_finish_seconds,
      },
      recent_activities: activities,
      recovery,
      today_modifiers: {
        time_available_minutes: modifiers.time_available_minutes,
        intensity: modifiers.intensity,
        feeling: modifiers.feeling,
      },
      scheduled_workout: dashboard.scheduledWorkout?.title ?? null,
    },
    null,
    2,
  );
}

function extractText(message: Anthropic.Message): string {
  const block = message.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  return block?.text ?? "";
}

// ---- Main entry ----

export async function generateRecommendation(
  supabase: TypedSupabase,
  userId: string,
  modifiers: WorkoutModifiers,
): Promise<RecommendationResult> {
  if (!ANTHROPIC_API_KEY) {
    throw new LlmNotConfiguredError();
  }

  // 1. Prerequisites — gate, don't call the model with empty context.
  const dashboard = await getDashboardData(supabase, userId);
  if (!dashboard.connected) {
    throw new RecommendationNotReadyError("garmin");
  }
  const goal = await getActiveRaceGoal(supabase, userId);
  if (!goal) {
    throw new RecommendationNotReadyError("goal");
  }

  // 2. Soft daily cap (checked before the call; incremented only on success).
  const usedToday = await readTodayCount(supabase, userId);
  if (usedToday >= DAILY_CAP) {
    throw new RecommendationRateLimitedError();
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY, timeout: TIMEOUT_MS, maxRetries: 2 });
  const baseContext = buildUserContext(dashboard, goal, modifiers);

  const started = Date.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let alternatives: WorkoutAlternative[] | null = null;
  let lastViolations = "";

  // 3. Up to two attempts: one initial + one bounded guardrail re-prompt.
  for (let attempt = 1; attempt <= 2 && !alternatives; attempt++) {
    const userContent =
      attempt === 1
        ? baseContext
        : `${baseContext}\n\nYour previous response was rejected: ${lastViolations} Return exactly 3 alternatives with plausible durations.`;

    let message: Anthropic.Message;
    try {
      message = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
        output_config: { format: { type: "json_schema", schema: RECOMMENDATION_JSON_SCHEMA } },
      });
    } catch (err) {
      throw new LlmError(`Anthropic call failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    inputTokens += message.usage.input_tokens;
    outputTokens += message.usage.output_tokens;

    if (message.stop_reason === "refusal") {
      throw new LlmError("model refused the request");
    }

    let raw: unknown;
    try {
      raw = JSON.parse(extractText(message));
    } catch {
      lastViolations = "the output was not valid JSON.";
      continue;
    }

    const parsed = parseRecommendation(raw);
    if (!parsed.ok) {
      lastViolations = `the output did not match the required shape (${parsed.issues}).`;
      continue;
    }

    const check = validateAlternatives(parsed.data.alternatives, dashboard.activities);
    if (!check.ok) {
      lastViolations = `${check.violations.join("; ")}. Keep every duration within ${check.band.minMinutes}-${check.band.maxMinutes} minutes.`;
      continue;
    }

    alternatives = parsed.data.alternatives.map((alt, i) => ({
      rank: RANKS[i],
      workout_type: alt.workout_type,
      duration_minutes: alt.duration_minutes,
      ai_explanation: alt.ai_explanation,
      training_arc_note: alt.training_arc_note, // S-04: long-term arc note (null when the model omitted/blanked it)
    }));
  }

  // 4. Structured log (wrangler tail): latency, tokens, guardrail outcome.
  // eslint-disable-next-line no-console -- intentional observability surface (S-03 decision)
  console.log(
    JSON.stringify({
      evt: "recommendation",
      userId,
      latencyMs: Date.now() - started,
      inputTokens,
      outputTokens,
      ok: alternatives != null,
      lastViolations: alternatives ? null : lastViolations,
    }),
  );

  if (!alternatives) {
    throw new LlmError(`could not produce a plausible recommendation: ${lastViolations}`);
  }

  // 5. Count a successful generation against the daily cap.
  await bumpTodayCount(supabase, userId, usedToday);

  return {
    alternatives,
    recoveryMissing: recoveryIsMissing(dashboard),
    stale: dashboard.stale,
    context: { modifiers, race_goal_id: goal.id, garmin_data_snapshot: dashboard },
  };
}
