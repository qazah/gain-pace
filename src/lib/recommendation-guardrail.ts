import { z } from "astro/zod";
import type { GarminActivity } from "@/types";

/**
 * The AI-recommendation contract + safety guardrail (S-03), kept in one
 * framework-free module (no `astro:env`, no SDK) so it unit-tests without a
 * network or build. The recommendations service imports:
 *   - RECOMMENDATION_JSON_SCHEMA — the structured-output schema for the API call
 *   - recommendationResponseSchema — Zod parse of the returned JSON
 *   - validateAlternatives — the plausible-load guardrail (the hard-regression defense)
 *
 * Guardrail intent (PRD): never recommend a volume/intensity implausible given
 * the runner's last 3–4 activities. Duration is our volume proxy — we bound each
 * alternative's duration to a band derived from recent activity, with absolute
 * sane caps as a floor/ceiling when history is thin.
 */

// ---- Structured-output schema for the Anthropic call ----
// Structured outputs do NOT support array length or numeric range constraints,
// so the "exactly 3" and positivity checks live in the Zod parse + guardrail.
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
        required: ["workout_type", "duration_minutes", "ai_explanation"],
        properties: {
          workout_type: { type: "string" },
          duration_minutes: { type: "integer" },
          ai_explanation: { type: "string" },
        },
      },
    },
  },
} as const;

// ---- Zod parse of the model's JSON (exactly 3 well-formed alternatives) ----
export const recommendationResponseSchema = z.object({
  alternatives: z
    .array(
      z.object({
        workout_type: z.string().min(1),
        duration_minutes: z.number().int().positive(),
        ai_explanation: z.string().min(1),
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

/** Derive a plausible per-session duration band from recent activities. */
export function deriveDurationBand(activities: GarminActivity[]): DurationBand {
  const durations = activities
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
