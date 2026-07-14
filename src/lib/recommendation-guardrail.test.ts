import { describe, expect, it } from "vitest";
import type { GarminActivity } from "@/types";
import {
  ABS_MAX_MINUTES,
  ABS_MIN_MINUTES,
  deriveDurationBand,
  parseRecommendation,
  validateAlternatives,
} from "./recommendation-guardrail";

function activity(durationSeconds: number | null): GarminActivity {
  return {
    id: `a-${durationSeconds}`,
    name: "Run",
    type: "running",
    startTime: "2026-07-12T06:00:00",
    distanceMeters: durationSeconds ? durationSeconds * 3 : null,
    durationSeconds,
    averageHeartRate: 150,
    calories: 400,
  };
}

// A runner whose recent sessions are ~40 min (median 40).
const RECENT: GarminActivity[] = [activity(2400), activity(2100), activity(2700), activity(2400)];

describe("deriveDurationBand", () => {
  it("brackets the recent median (band = [median*0.3, median*2.5])", () => {
    const band = deriveDurationBand(RECENT); // median 40 min
    expect(band.minMinutes).toBe(12); // 40 * 0.3
    expect(band.maxMinutes).toBe(100); // 40 * 2.5
  });

  it("falls back to absolute caps when there is no usable history", () => {
    expect(deriveDurationBand([])).toEqual({ minMinutes: ABS_MIN_MINUTES, maxMinutes: ABS_MAX_MINUTES });
    expect(deriveDurationBand([activity(null)])).toEqual({ minMinutes: ABS_MIN_MINUTES, maxMinutes: ABS_MAX_MINUTES });
  });

  it("clamps the floor to the absolute minimum for very short recent sessions", () => {
    const band = deriveDurationBand([activity(600)]); // 10 min median → 10*0.3=3 → clamped to 10
    expect(band.minMinutes).toBe(ABS_MIN_MINUTES);
  });
});

describe("validateAlternatives", () => {
  it("passes in-band workouts", () => {
    const result = validateAlternatives(
      [{ duration_minutes: 30 }, { duration_minutes: 45 }, { duration_minutes: 60 }],
      RECENT,
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("flags an implausibly long workout (the hard-regression case)", () => {
    // ~30 km run ≈ 180 min for a runner whose recent band tops out at 100 min.
    const result = validateAlternatives([{ duration_minutes: 180 }], RECENT);
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain("outside plausible band");
  });

  it("flags a non-positive duration", () => {
    const result = validateAlternatives([{ duration_minutes: 0 }], RECENT);
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain("non-positive");
  });
});

describe("parseRecommendation", () => {
  const good = {
    alternatives: [
      { workout_type: "Easy run", duration_minutes: 40, ai_explanation: "Recovery-friendly." },
      { workout_type: "Tempo", duration_minutes: 50, ai_explanation: "Builds threshold." },
      { workout_type: "Intervals", duration_minutes: 45, ai_explanation: "Sharpens speed." },
    ],
  };

  it("accepts three well-formed alternatives", () => {
    const result = parseRecommendation(good);
    expect(result.ok).toBe(true);
  });

  it("rejects the wrong number of alternatives", () => {
    const result = parseRecommendation({ alternatives: good.alternatives.slice(0, 2) });
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed alternative (missing field / bad type)", () => {
    const result = parseRecommendation({
      alternatives: [
        { workout_type: "Easy run", duration_minutes: -5, ai_explanation: "x" },
        good.alternatives[1],
        good.alternatives[2],
      ],
    });
    expect(result.ok).toBe(false);
  });
});
