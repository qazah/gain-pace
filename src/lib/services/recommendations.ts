import Anthropic, { APIConnectionTimeoutError } from "@anthropic-ai/sdk";
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
import type { SessionStore } from "./garmin-session-store";
import { getActiveRaceGoal } from "./race-goals";
import {
  RECOMMENDATION_JSON_SCHEMA,
  type ParsedRecommendation,
  isHardWorkout,
  isRecoveryConflict,
  parseRecommendation,
  validateAlternatives,
  validateWorkoutStructure,
} from "@/lib/recommendation-guardrail";

/**
 * Worker-side recommendation service (S-03). Fuses Garmin data + active race
 * goal + today's modifiers into one Claude Haiku structured-output call, guards
 * the result against implausible load (bounded re-prompts, then graceful
 * degradation to the individually-valid subset), enforces a soft daily cap, and
 * returns up to 3 alternatives (primary first). Mirrors garmin.ts's typed
 * error taxonomy; the route maps each error to a stable JSON status.
 */

type TypedSupabase = SupabaseClient<Database>;

/**
 * The slice of the Anthropic SDK this service actually uses. A real client
 * satisfies it structurally, so production passes nothing; a test supplies a
 * stub carrying only `messages.create`.
 */
export type AnthropicClient = Pick<Anthropic, "messages">;

/**
 * Injectable dependencies — the test seam. Every member is optional and falls
 * back to the real production construction, so callers stay unchanged.
 */
export interface RecommendationDeps {
  client?: AnthropicClient;
  /** Clock seam, so a test can advance time without waiting. Defaults to `Date.now`. */
  now?: () => number;
}

const MODEL = "claude-haiku-4-5";
const TIMEOUT_MS = 20_000; // per-attempt cap; raised from 9s — a structured, multi-step generation occasionally needs longer
// Whole-request ceiling (PRD l. 90 bounds the operation, not the attempt). The
// per-attempt cap above compounds with the SDK's own retries and this loop's
// re-prompts, which research 2026-09-11 measured at roughly three minutes worst
// case. This bounds the compounding: a retry is opened only while there is
// realistic room for it to finish inside a wait a runner will tolerate.
const TOTAL_BUDGET_MS = 45_000;
const MAX_TOKENS = 2048; // the structured output is small
const DAILY_CAP = 10; // soft per-user daily generation cap
const RANKS = ["primary", "alt_1", "alt_2"] as const;
// Reliability (S-05 duration-sum / pace guardrails): one initial call plus up to
// two bounded re-prompts for a fully-valid trio; the last attempt then salvages
// whatever individually clears the guardrails. The floor is ONE — PRD l. 39
// forbids shipping an implausible load, not withholding a plausible one, so a
// single good workout is offered rather than discarded. Every reduced set is
// flagged to the runner via `degraded`; a smaller set is fine, a silent one is not.
const MAX_ATTEMPTS = 3;
const MIN_ALTERNATIVES = 1;

// S-06: static fallback caution, used when the low-recovery flag is set but the
// model left recovery_warning empty on a hard option — the signal never drops.
const RECOVERY_WARNING_FALLBACK =
  "Your recovery looks low today — this is a demanding session, so listen to your body and ease off if needed.";
// Appended to the user content only when the conflict flag is set, so the model
// knows to author a caution for hard options this run.
const RECOVERY_CONFLICT_INSTRUCTION =
  "NOTE: the runner's body battery is low today but they asked for high intensity. For any HARD option (one containing a tempo, threshold, or interval segment), set recovery_warning to one short, kind sentence acknowledging they are pushing hard despite low recovery and gently suggesting they listen to their body. Leave recovery_warning empty for easier options.";

// ---- Error taxonomy the API route maps to stable JSON ----

/** ANTHROPIC_API_KEY not set — the config banner should already show. */
export class LlmNotConfiguredError extends Error {
  constructor() {
    super("Anthropic API key is not configured");
    this.name = "LlmNotConfiguredError";
  }
}
/**
 * Why a generation failed. The route surfaces this verbatim so the caller can
 * branch on a stable code instead of matching prose — and so a test asserts the
 * class of failure rather than pinning a message string.
 */
export type LlmErrorReason =
  | "timeout" // the request outlived its budget
  | "transport" // network/provider failure before a usable response
  | "refusal" // the model declined — a decision, not a glitch
  | "truncated" // the response was cut off mid-output (max_tokens)
  | "invalid_shape" // parsed, but not the contract we asked for
  | "implausible"; // well-formed, but no option cleared the safety guardrails

/** A model/network failure, refusal, or an unrecoverable guardrail violation. */
export class LlmError extends Error {
  constructor(
    message: string,
    public reason: LlmErrorReason,
  ) {
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
  "Each alternative has seven fields:",
  "workout_type is a short label; duration_minutes is an integer.",
  "ai_explanation is one or two plain-language sentences (no jargon, no raw numbers) about why this workout fits the runner TODAY — their recovery state, their available time, and how they feel. Keep it about today's readiness; do not talk about the race goal or long-term progress here.",
  "training_arc_note is exactly one plain-language sentence (no jargon, no raw numbers) that frames THIS specific option as a choice: what the runner GAINS by picking it and what they TRADE, in terms of long-term progress toward their race goal over the weeks to race day (for example: staying on pace to the goal as the best-balanced call, banking recovery now to train harder in the coming days, or speeding up fitness gains at the cost of more fatigue tomorrow). Across the three alternatives make these notes clearly distinct, so the runner can see why they would choose one over another. It is about the long-term trade of this choice, not today's fit, and must not repeat ai_explanation.",
  'summary is ONE short line the runner reads under the workout name: duration + effort + target pace, e.g. "45 min easy 6:15/km" or "50 min with 5x3 min at threshold".',
  'steps is an ordered list of TIME-BASED segments that together make up the session. Each step has: effort (exactly one of: warmup, easy, steady, tempo, threshold, interval, recovery, cooldown); duration_minutes (a positive integer); and target_pace as minutes:seconds per km (e.g. "6:15"). A plain continuous run is a SINGLE step. For interval sessions, emit each repetition as its own segment (e.g. 5x [1 min interval, 2 min recovery] becomes 10 segments) and compress the repeat only in the summary. CRITICAL: the step durations MUST add up to EXACTLY duration_minutes — include a warmup and a cooldown segment so the arithmetic closes (e.g. a 45-min session: 10 warmup + 25 main + 10 cooldown = 45). Before returning each alternative, sum its step durations and, if they do not equal duration_minutes, lengthen or shorten the warmup/cooldown until they do.',
  "Target paces must be realistic for THIS runner given their recent runs: easy/warmup/cooldown/recovery segments at or near their recent easy pace, and only higher-effort segments (steady/tempo/threshold/interval) meaningfully faster. Never prescribe a pace the runner could not hold.",
  "recovery_warning must be an empty string by default. Only set it when the user message explicitly says the runner's recovery is low for a hard session, and then only for HARD options (containing a tempo/threshold/interval segment) — one short, kind sentence; leave it empty for easier options.",
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

type ParsedAlternative = ParsedRecommendation["alternatives"][number];

/**
 * Map a parsed, guardrail-cleared model alternative to the domain DTO at a given
 * rank. Shared by the all-valid fast path and the graceful-degradation salvage
 * path so ranking and the S-04/S-05/S-06 field wiring stay identical in both.
 */
function toWorkoutAlternative(
  alt: ParsedAlternative,
  rank: (typeof RANKS)[number],
  recoveryConflict: boolean,
): WorkoutAlternative {
  return {
    rank,
    workout_type: alt.workout_type,
    duration_minutes: alt.duration_minutes,
    ai_explanation: alt.ai_explanation,
    training_arc_note: alt.training_arc_note, // S-04: long-term arc note (null when the model omitted/blanked it)
    // S-06: caution shows iff the conflict flag is set AND this option is hard;
    // fall back to a static sentence so a set flag never leaves a hard option bare.
    recovery_warning:
      recoveryConflict && isHardWorkout(alt.steps) ? (alt.recovery_warning ?? RECOVERY_WARNING_FALLBACK) : null,
    summary: alt.summary, // S-05: model-authored one-liner
    steps: alt.steps.map((s) => ({
      effort: s.effort,
      duration_minutes: s.duration_minutes,
      target_pace: s.target_pace, // keep the "m:ss" display string; the seconds form was for the guardrail
    })),
  };
}

function extractText(message: Anthropic.Message): string {
  const block = message.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  return block?.text ?? "";
}

// ---- Main entry ----

export async function generateRecommendation(
  supabase: TypedSupabase,
  userId: string,
  store: SessionStore,
  modifiers: WorkoutModifiers,
  deps: RecommendationDeps = {},
): Promise<RecommendationResult> {
  if (!ANTHROPIC_API_KEY) {
    throw new LlmNotConfiguredError();
  }

  // 1. Prerequisites — gate, don't call the model with empty context. The store
  // is supplied by the route (DB- or cookie-backed), matching /api/garmin/data.
  const dashboard = await getDashboardData(store);
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

  const client: AnthropicClient =
    deps.client ?? new Anthropic({ apiKey: ANTHROPIC_API_KEY, timeout: TIMEOUT_MS, maxRetries: 2 });

  // S-06: deterministic low-recovery conflict — the runner asked for high
  // intensity while their body battery is low. When set, ask the model to author
  // a caution for hard options; the mapping below enforces when it actually shows.
  const recoveryConflict = isRecoveryConflict(dashboard.recovery?.bodyBattery.current ?? null, modifiers.intensity);
  const baseContext =
    buildUserContext(dashboard, goal, modifiers) + (recoveryConflict ? `\n\n${RECOVERY_CONFLICT_INSTRUCTION}` : "");

  const now = deps.now ?? Date.now;
  const started = now();
  let inputTokens = 0;
  let outputTokens = 0;
  let alternatives: WorkoutAlternative[] | null = null;
  let lastViolations = "";
  // Which content failure ended the most recent attempt; reported if we exhaust them.
  let lastReason: LlmErrorReason = "invalid_shape";
  let easyPaceSeconds: number | null = null;
  let degradedCount: number | null = null; // non-null (<3) when we shipped a salvaged partial set

  // 3. Up to MAX_ATTEMPTS: one initial call + bounded guardrail re-prompts. The
  // final attempt salvages any individually-valid alternatives (graceful degradation).
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !alternatives; attempt++) {
    // Refuse to open another call once the budget is spent, rather than
    // discovering it after a third 20-second attempt. The first attempt always
    // runs — a budget that could reject before any call would turn a slow
    // prerequisite into a silent no-op.
    if (attempt > 1 && now() - started > TOTAL_BUDGET_MS) {
      throw new LlmError("Timed out waiting for your recommendation. Please try again.", "timeout");
    }

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
      if (err instanceof APIConnectionTimeoutError) {
        throw new LlmError("Timed out waiting for your recommendation. Please try again.", "timeout");
      }
      throw new LlmError(
        `Recommendation request failed: ${err instanceof Error ? err.message : String(err)}`,
        "transport",
      );
    }

    inputTokens += message.usage.input_tokens;
    outputTokens += message.usage.output_tokens;

    if (message.stop_reason === "refusal") {
      throw new LlmError("model refused the request", "refusal");
    }

    // Must precede the parse: a cut-off body is not valid JSON, so without this
    // branch truncation is indistinguishable from the model emitting garbage.
    if (message.stop_reason === "max_tokens") {
      lastViolations = "the output was cut off before it was complete.";
      lastReason = "truncated";
      continue;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(extractText(message));
    } catch {
      lastViolations = "the output was not valid JSON.";
      lastReason = "invalid_shape";
      continue;
    }

    const parsed = parseRecommendation(raw);
    if (!parsed.ok) {
      lastViolations = `the output did not match the required shape (${parsed.issues}).`;
      lastReason = "invalid_shape";
      continue;
    }

    // Guardrails: implausible LOAD (duration/volume, S-03) and implausible
    // STRUCTURE (pace bands + step-duration sum, S-05). Both are per-alternative
    // independent, so one bad option never taints the others.
    const check = validateAlternatives(parsed.data.alternatives, dashboard.activities);
    const structure = validateWorkoutStructure(parsed.data.alternatives, dashboard.activities);
    easyPaceSeconds = structure.easyPaceSeconds;

    if (check.ok && structure.ok) {
      alternatives = parsed.data.alternatives.map((alt, i) => toWorkoutAlternative(alt, RANKS[i], recoveryConflict));
      break;
    }

    // Record why — feeds the next re-prompt's tail and the structured log.
    lastReason = "implausible";
    lastViolations = [
      check.ok
        ? ""
        : `${check.violations.join("; ")}. Keep every duration within ${check.band.minMinutes}-${check.band.maxMinutes} minutes.`,
      structure.ok
        ? ""
        : `${structure.violations.join("; ")}. Ground every target pace in the runner's recent runs and make each alternative's step durations sum to its total.`,
    ]
      .filter(Boolean)
      .join(" ");

    // Earlier attempts: re-prompt for a fully-valid set of 3.
    if (attempt < MAX_ATTEMPTS) continue;

    // Final attempt still imperfect → graceful degradation. Ship only the
    // alternatives that individually clear BOTH guardrails, re-ranked in order:
    // an implausible option is dropped (never shipped), and we give up (throw
    // below) only when nothing at all survives. Note the re-ranking is positional
    // — if the model's best-fit option is the one rejected, its second choice
    // becomes `primary`. No source specifies the ranking semantics; accepted.
    const survivors = parsed.data.alternatives.filter(
      (alt) =>
        validateAlternatives([alt], dashboard.activities).ok &&
        validateWorkoutStructure([alt], dashboard.activities).ok,
    );
    if (survivors.length >= MIN_ALTERNATIVES) {
      alternatives = survivors.map((alt, i) => toWorkoutAlternative(alt, RANKS[i], recoveryConflict));
      degradedCount = survivors.length;
    }
  }

  // 4. Structured log (wrangler tail): latency, tokens, guardrail outcome.
  // eslint-disable-next-line no-console -- intentional observability surface (S-03 decision)
  console.log(
    JSON.stringify({
      evt: "recommendation",
      userId,
      latencyMs: now() - started,
      inputTokens,
      outputTokens,
      ok: alternatives != null,
      degraded: degradedCount, // reliability: non-null (<3) when a salvaged partial set shipped
      easyPaceSeconds, // S-05: null when history too thin (pace band fell back to absolute caps)
      recoveryConflict, // S-06: low body battery + high intensity → hard options carry a caution
      lastViolations: alternatives && degradedCount === null ? null : lastViolations || null,
    }),
  );

  if (!alternatives) {
    throw new LlmError(`could not produce a plausible recommendation: ${lastViolations}`, lastReason);
  }

  // 5. Count a successful generation against the daily cap.
  await bumpTodayCount(supabase, userId, usedToday);

  return {
    alternatives,
    recoveryMissing: recoveryIsMissing(dashboard),
    stale: dashboard.stale,
    degraded: degradedCount,
    context: { modifiers, race_goal_id: goal.id, garmin_data_snapshot: dashboard },
  };
}
