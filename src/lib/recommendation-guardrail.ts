import { z } from "astro/zod";
import type { GarminActivity, WorkoutEffort, WorkoutModifiers } from "@/types";

/**
 * The AI-recommendation contract + safety guardrail (S-03/S-05), kept in one
 * framework-free module (no `astro:env`, no SDK) so it unit-tests without a
 * network or build. The recommendations service imports:
 *   - RECOMMENDATION_JSON_SCHEMA — the structured-output schema for the API call
 *   - recommendationResponseSchema — Zod parse of the returned JSON
 *   - validateAlternatives — the plausible-load guardrail (duration; S-03)
 *   - validateWorkoutStructure — the plausible-pace + duration-sum guardrail (S-05)
 *
 * Guardrail intent (PRD): never recommend a volume/intensity implausible given
 * the runner's last 3–4 activities. Duration is our volume proxy — we bound each
 * alternative's duration to a band derived from recent activity, with absolute
 * sane caps as a floor/ceiling when history is thin. S-05 adds the pace analogue:
 * each structured step's target pace must sit in a band scaled off the runner's
 * recent implied pace, and the step durations must sum to the stated total.
 */

// Runtime enum of workout efforts and the source of truth for pace-band lookup.
// `satisfies readonly WorkoutEffort[]` rejects any entry not in the union; the
// EFFORT_PACE_MULTIPLIERS Record<WorkoutEffort, …> below fails to compile if an
// effort is ever missing, so the two stay in lockstep.
export const WORKOUT_EFFORTS = [
  "warmup",
  "easy",
  "steady",
  "tempo",
  "threshold",
  "interval",
  "recovery",
  "cooldown",
] as const satisfies readonly WorkoutEffort[];

// ---- Structured-output schema for the Anthropic call ----
// Structured outputs do NOT support array length, enum, or numeric range
// constraints, so "exactly 3", the effort enum, the pace format, and all range
// checks live in the Zod parse + guardrail.
export const RECOMMENDATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["alternatives"],
  properties: {
    alternatives: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "workout_type",
          "duration_minutes",
          "ai_explanation",
          "training_arc_note",
          "recovery_warning",
          "summary",
          "steps",
        ],
        properties: {
          workout_type: { type: "string" },
          duration_minutes: { type: "integer" },
          ai_explanation: { type: "string" },
          training_arc_note: { type: "string" },
          recovery_warning: { type: "string" },
          summary: { type: "string" },
          steps: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["effort", "duration_minutes", "target_pace"],
              properties: {
                effort: { type: "string" },
                duration_minutes: { type: "integer" },
                target_pace: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
} as const;

// ---- Pace parsing helpers ("m:ss" per km ↔ seconds) ----
const PACE_RE = /^(\d{1,2}):([0-5]\d)$/;

/** Parse an "m:ss" per-km pace to seconds, or null when unparseable. */
export function parsePaceToSeconds(pace: string): number | null {
  const m = PACE_RE.exec(pace.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Format seconds-per-km back to an "m:ss" display string (for guardrail messages). */
export function formatPace(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

// A single time-based segment. `target_pace` stays the model's "m:ss" string for
// the UI; `paceSecondsPerKm` is the parsed number the pace guardrail compares.
const stepSchema = z
  .object({
    effort: z.enum(WORKOUT_EFFORTS),
    duration_minutes: z.number().int().positive(),
    target_pace: z.string(),
  })
  .transform((step, ctx) => {
    const paceSecondsPerKm = parsePaceToSeconds(step.target_pace);
    if (paceSecondsPerKm == null) {
      ctx.addIssue({ code: "custom", message: `target_pace "${step.target_pace}" is not an m:ss per-km pace` });
      return z.NEVER;
    }
    return { ...step, paceSecondsPerKm };
  });

// ---- Zod parse of the model's JSON (exactly 3 well-formed alternatives) ----
export const recommendationResponseSchema = z.object({
  alternatives: z
    .array(
      z.object({
        workout_type: z.string().min(1),
        duration_minutes: z.number().int().positive(),
        ai_explanation: z.string().min(1),
        // S-04: the model is asked for a per-alternative long-term arc note. Kept
        // lenient here (optional + empty/whitespace → null) so a missing or blank
        // note degrades gracefully — it never fails an otherwise-plausible workout.
        training_arc_note: z
          .string()
          .nullish()
          .transform((v) => {
            const t = (v ?? "").trim();
            return t.length > 0 ? t : null;
          }),
        // S-06: optional low-recovery caution. Same lenient parse as
        // training_arc_note — the service decides when it applies (deterministic
        // flag + hard-option), so a missing/blank value here degrades to null.
        recovery_warning: z
          .string()
          .nullish()
          .transform((v) => {
            const t = (v ?? "").trim();
            return t.length > 0 ? t : null;
          }),
        // S-05: a human one-liner and the structured breakdown. `steps` is
        // required and ≥1 so every prescribed pace lives in a guarded step.
        summary: z.string().min(1),
        steps: z.array(stepSchema).min(1),
      }),
    )
    .length(3),
});

export type ParsedRecommendation = z.infer<typeof recommendationResponseSchema>;

/** Parse raw model output; returns the validated shape or a list of issues. */
export function parseRecommendation(
  raw: unknown,
): { ok: true; data: ParsedRecommendation } | { ok: false; issues: string } {
  const parsed = recommendationResponseSchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  return { ok: false, issues: JSON.stringify(z.treeifyError(parsed.error)) };
}

// ---- Plausible-load guardrail ----

/** Shortest / longest plausible single-session duration, minutes (absolute caps). */
export const ABS_MIN_MINUTES = 10;
export const ABS_MAX_MINUTES = 240;
/** Band multipliers around the runner's recent median session duration. */
export const MIN_FACTOR = 0.3;
export const MAX_FACTOR = 2.5;

export interface DurationBand {
  minMinutes: number;
  maxMinutes: number;
}

/**
 * Recent RUNS only — cross-training (cycling, swims, etc.) pollutes both the
 * duration band and the easy-pace anchor that the guardrails are built on.
 * Matches "running", "trail_running", "treadmill_running", …; a null/unknown
 * type is excluded (better to fall back to caps than anchor on a non-run).
 */
function isRun(activity: GarminActivity): boolean {
  return activity.type?.toLowerCase().includes("run") ?? false;
}

/** Derive a plausible per-session duration band from recent runs. */
export function deriveDurationBand(activities: GarminActivity[]): DurationBand {
  const durations = activities
    .filter(isRun)
    .map((a) => a.durationSeconds)
    .filter((s): s is number => typeof s === "number" && s > 0)
    .map((s) => s / 60);

  if (durations.length === 0) {
    return { minMinutes: ABS_MIN_MINUTES, maxMinutes: ABS_MAX_MINUTES };
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  return {
    minMinutes: Math.max(ABS_MIN_MINUTES, Math.round(median * MIN_FACTOR)),
    maxMinutes: Math.min(ABS_MAX_MINUTES, Math.round(median * MAX_FACTOR)),
  };
}

/**
 * Check each alternative's duration against the plausible band. Returns the list
 * of violations (empty = safe). The service re-prompts once when non-empty and
 * treats a persistent violation as a failure (never ships an implausible load).
 */
export function validateAlternatives(
  alternatives: { duration_minutes: number }[],
  activities: GarminActivity[],
): { ok: boolean; violations: string[]; band: DurationBand } {
  const band = deriveDurationBand(activities);
  const violations: string[] = [];

  alternatives.forEach((alt, i) => {
    const d = alt.duration_minutes;
    if (!(d > 0)) {
      violations.push(`alternative ${i}: non-positive duration (${d})`);
    } else if (d < band.minMinutes || d > band.maxMinutes) {
      violations.push(
        `alternative ${i}: duration ${d}min outside plausible band [${band.minMinutes}, ${band.maxMinutes}]min`,
      );
    }
  });

  return { ok: violations.length === 0, violations, band };
}

// ---- Plausible-pace guardrail (S-05) ----
// The pace analogue of the duration guardrail. We anchor an "easy pace" from the
// runner's recent runs' implied pace, scale a band per effort off that anchor,
// and reject any step whose pace falls outside its band. We also check that the
// step durations sum (within tolerance) to the alternative's stated total.

/** Absolute sane per-km pace caps (seconds): floor 2:30/km, ceiling 12:00/km. */
export const ABS_MIN_PACE_SECONDS = 150;
export const ABS_MAX_PACE_SECONDS = 720;
/** ± tolerance applied around each effort's target pace band. */
export const PACE_TOLERANCE = 0.08;
/** Allowed drift between the step-duration sum and the alternative's total. */
export const DURATION_SUM_TOLERANCE = 0.15;

/**
 * Per-effort pace multipliers relative to the runner's easy pace E (sec/km;
 * smaller = faster). A single-point effort has lo === hi; ranges (recovery,
 * interval) admit a spread. Tune during manual verification.
 */
export const EFFORT_PACE_MULTIPLIERS: Record<WorkoutEffort, { lo: number; hi: number }> = {
  warmup: { lo: 1.0, hi: 1.2 }, // warm-ups often run slower than easy
  cooldown: { lo: 1.0, hi: 1.2 }, // cool-downs often run slower than easy
  easy: { lo: 1.0, hi: 1.1 }, // easy tolerates a touch slower
  recovery: { lo: 1.0, hi: 1.15 }, // jog between reps: easy or slower
  steady: { lo: 0.93, hi: 0.93 },
  tempo: { lo: 0.88, hi: 0.88 },
  threshold: { lo: 0.85, hi: 0.85 },
  interval: { lo: 0.75, hi: 0.8 }, // legitimately much faster than easy
};

export interface PaceBand {
  minSeconds: number;
  maxSeconds: number;
}

/**
 * Derive the runner's easy-pace anchor (sec/km) from the median implied pace of
 * recent runs with usable distance+duration. Null when history is too thin — the
 * caller then falls back to the absolute caps only.
 */
export function deriveEasyPace(activities: GarminActivity[]): number | null {
  const paces: number[] = [];
  for (const a of activities) {
    if (!isRun(a)) continue;
    const meters = a.distanceMeters;
    const seconds = a.durationSeconds;
    if (meters != null && meters > 0 && seconds != null && seconds > 0) {
      paces.push(seconds / (meters / 1000));
    }
  }

  if (paces.length === 0) return null;

  const sorted = [...paces].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Plausible pace band (seconds/km) for one effort. With a known easy pace the
 * band is the effort multiplier ± tolerance, clamped to the absolute caps; with
 * no easy pace it degrades to the absolute caps only (a looser band).
 */
export function derivePaceBand(effort: WorkoutEffort, easyPaceSeconds: number | null): PaceBand {
  if (easyPaceSeconds == null) {
    return { minSeconds: ABS_MIN_PACE_SECONDS, maxSeconds: ABS_MAX_PACE_SECONDS };
  }
  const { lo, hi } = EFFORT_PACE_MULTIPLIERS[effort];
  const minSeconds = Math.max(ABS_MIN_PACE_SECONDS, Math.round(easyPaceSeconds * lo * (1 - PACE_TOLERANCE)));
  const maxSeconds = Math.min(ABS_MAX_PACE_SECONDS, Math.round(easyPaceSeconds * hi * (1 + PACE_TOLERANCE)));
  // Guard against an inverted band if the anchor itself sits beyond a cap.
  return minSeconds <= maxSeconds ? { minSeconds, maxSeconds } : { minSeconds: maxSeconds, maxSeconds: minSeconds };
}

interface StructuredStep {
  effort: WorkoutEffort;
  duration_minutes: number;
  paceSecondsPerKm: number;
}
interface StructuredAlternative {
  duration_minutes: number;
  steps: StructuredStep[];
}

/**
 * Validate every alternative's structured steps: (a) each step's pace sits in its
 * effort band, and (b) the step durations sum within tolerance to the stated
 * total. Returns the list of violations (empty = safe). The service re-prompts
 * once when non-empty and treats a persistent violation as a failure — an
 * implausible pace is never shipped. `easyPaceSeconds` is surfaced for logging.
 */
export function validateWorkoutStructure(
  alternatives: StructuredAlternative[],
  activities: GarminActivity[],
): { ok: boolean; violations: string[]; easyPaceSeconds: number | null } {
  const easyPaceSeconds = deriveEasyPace(activities);
  const violations: string[] = [];

  alternatives.forEach((alt, i) => {
    alt.steps.forEach((step, j) => {
      const band = derivePaceBand(step.effort, easyPaceSeconds);
      const p = step.paceSecondsPerKm;
      if (p < band.minSeconds || p > band.maxSeconds) {
        violations.push(
          `alternative ${i} step ${j} (${step.effort}): pace ${formatPace(p)}/km outside plausible band [${formatPace(band.minSeconds)}, ${formatPace(band.maxSeconds)}]/km`,
        );
      }
    });

    const sum = alt.steps.reduce((acc, s) => acc + s.duration_minutes, 0);
    const target = alt.duration_minutes;
    if (target > 0 && Math.abs(sum - target) / target > DURATION_SUM_TOLERANCE) {
      violations.push(
        `alternative ${i}: step durations sum to ${sum}min but the total is ${target}min (must be within ${Math.round(DURATION_SUM_TOLERANCE * 100)}%)`,
      );
    }
  });

  return { ok: violations.length === 0, violations, easyPaceSeconds };
}

// ---- Low-recovery conflict (S-06) ----
// Deterministic detection of "the runner asked for a hard session while their
// recovery is low." Code owns *whether* to warn; the model owns the wording.
// This never blocks a recommendation — it only gates whether a caution shows.

/** Body battery (0–100) below this, with intensity=high, trips the conflict flag. */
export const LOW_BODY_BATTERY = 20;

/** Efforts that make an option "hard" — the only options that carry a caution. */
const HARD_EFFORTS = new Set<WorkoutEffort>(["tempo", "threshold", "interval"]);

/** True when an alternative contains at least one hard segment. */
export function isHardWorkout(steps: { effort: WorkoutEffort }[]): boolean {
  return steps.some((s) => HARD_EFFORTS.has(s.effort));
}

/**
 * True when the runner requested high intensity while their current body battery
 * is below the low threshold. A null body battery (recovery missing) is never a
 * conflict — we don't warn on absent data.
 */
export function isRecoveryConflict(
  bodyBatteryCurrent: number | null,
  intensity: WorkoutModifiers["intensity"],
): boolean {
  return bodyBatteryCurrent != null && bodyBatteryCurrent < LOW_BODY_BATTERY && intensity === "high";
}
