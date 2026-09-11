import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateRecommendation } from "./recommendations";
import { LlmError } from "./recommendations";
import { makeRecommendationEnv, modelMessage, modelPayload, VALID_ALTERNATIVES } from "@/test/recommendation-env";

/**
 * Contract tests for the recommendation service (test-plan §3 Phase 1).
 *
 * Hermetic: the model client is injected, the sidecar's fetch is stubbed, and
 * the Supabase client is a fake. The oracle is the PRD, never this module —
 * expected values are stated as independent literals, following the pattern at
 * `src/lib/recommendation-guardrail.test.ts:28-32`.
 */

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // The service logs one structured line per generation (an intentional
  // observability surface); keep it out of the test output.
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe("generateRecommendation — the shipped set", () => {
  it("ships three alternatives, best-fit first", async () => {
    const env = makeRecommendationEnv();
    env.queue(modelMessage(modelPayload()));

    const result = await generateRecommendation(
      env.supabase,
      "u1",
      env.store,
      {
        time_available_minutes: 60,
        intensity: "normal",
        feeling: "normal",
      },
      { client: env.client },
    );

    // PRD l. 33/47/79: a primary recommendation plus two "if you prefer" options.
    expect(result.alternatives).toHaveLength(3);
    expect(result.alternatives.map((a) => a.rank)).toEqual(["primary", "alt_1", "alt_2"]);
    expect(env.calls()).toBe(1);
  });

  it("carries each option's type, duration, explanation and structured detail", async () => {
    const env = makeRecommendationEnv();
    env.queue(modelMessage(modelPayload()));

    const result = await generateRecommendation(
      env.supabase,
      "u1",
      env.store,
      {
        time_available_minutes: 60,
        intensity: "normal",
        feeling: "normal",
      },
      { client: env.client },
    );

    // PRD l. 51: every option carries at minimum a workout type, an estimated
    // duration and a one-sentence explanation. S-05 adds the summary + steps.
    for (const alt of result.alternatives) {
      expect(alt.workout_type.length).toBeGreaterThan(0);
      expect(alt.duration_minutes).toBeGreaterThan(0);
      expect(alt.ai_explanation.length).toBeGreaterThan(0);
      expect(alt.summary.length).toBeGreaterThan(0);
      expect(alt.steps.length).toBeGreaterThan(0);
    }

    const tempo = result.alternatives[1];
    expect(tempo.workout_type).toBe("Tempo");
    expect(tempo.duration_minutes).toBe(50);
    expect(tempo.steps.map((s) => s.effort)).toEqual(["warmup", "tempo", "cooldown"]);
    expect(tempo.steps.map((s) => s.target_pace)).toEqual(["6:00", "5:00", "6:00"]);
  });

  it("counts a successful generation against the daily cap", async () => {
    const env = makeRecommendationEnv({ usedToday: 2 });
    env.queue(modelMessage(modelPayload()));

    await generateRecommendation(
      env.supabase,
      "u1",
      env.store,
      {
        time_available_minutes: 60,
        intensity: "normal",
        feeling: "normal",
      },
      { client: env.client },
    );

    expect(env.usageUpserts).toHaveLength(1);
    expect(env.usageUpserts[0]).toMatchObject({ user_id: "u1", count: 3 });
  });
});

/**
 * PRD l. 39's own worked example — "a 30 km sprint for a 5 km/week runner" —
 * sized for this fixture's runner: a ~180 min session against recent sessions of
 * ~40 min. Stated as an independent literal so it survives any retuning of the
 * guardrail's band multipliers.
 */
const IMPLAUSIBLE = {
  ...VALID_ALTERNATIVES[0],
  workout_type: "Very long run",
  duration_minutes: 180,
  summary: "180 min easy 6:00/km",
  steps: [{ effort: "easy", duration_minutes: 180, target_pace: "6:00" }],
};

const MODIFIERS = { time_available_minutes: 60, intensity: "normal", feeling: "normal" } as const;

describe("generateRecommendation — degradation contract", () => {
  it("ships the survivors and flags the set when one option is rejected", async () => {
    const env = makeRecommendationEnv();
    env.repeat(modelMessage(modelPayload([VALID_ALTERNATIVES[0], VALID_ALTERNATIVES[1], IMPLAUSIBLE])));

    const result = await generateRecommendation(env.supabase, "u1", env.store, MODIFIERS, { client: env.client });

    // PRD l. 39: an implausible load must never reach the runner. The rest of
    // the session still ships — but the runner is told the set was reduced.
    expect(result.alternatives).toHaveLength(2);
    expect(result.degraded).toBe(2);
    expect(result.alternatives.map((a) => a.workout_type)).not.toContain("Very long run");
  });

  it("offers a lone surviving option rather than discarding it", async () => {
    const env = makeRecommendationEnv();
    env.repeat(modelMessage(modelPayload([VALID_ALTERNATIVES[1], IMPLAUSIBLE, IMPLAUSIBLE])));

    const result = await generateRecommendation(env.supabase, "u1", env.store, MODIFIERS, { client: env.client });

    // PRD l. 39 forbids shipping an implausible load; it does not ask us to
    // withhold a plausible one. One good workout beats no workout at all.
    expect(result.alternatives).toHaveLength(1);
    expect(result.alternatives[0].rank).toBe("primary");
    expect(result.degraded).toBe(1);
  });

  it("leaves the marker unset when all three options are plausible", async () => {
    const env = makeRecommendationEnv();
    env.repeat(modelMessage(modelPayload()));

    const result = await generateRecommendation(env.supabase, "u1", env.store, MODIFIERS, { client: env.client });

    expect(result.alternatives).toHaveLength(3);
    expect(result.degraded).toBeNull();
  });
});

describe("generateRecommendation — the implausible-load guardrail", () => {
  it("fails the request rather than shipping an implausible option", async () => {
    const env = makeRecommendationEnv();
    env.repeat(modelMessage(modelPayload([IMPLAUSIBLE, IMPLAUSIBLE, IMPLAUSIBLE])));

    // The floor is one surviving option, not zero: with nothing plausible left
    // the runner gets a readable failure, never a fabricated workout.
    await expect(
      generateRecommendation(env.supabase, "u1", env.store, MODIFIERS, { client: env.client }),
    ).rejects.toBeInstanceOf(LlmError);
  });

  it("drops an implausible option even when the model ranked it first", async () => {
    const env = makeRecommendationEnv();
    env.repeat(modelMessage(modelPayload([IMPLAUSIBLE, VALID_ALTERNATIVES[0], VALID_ALTERNATIVES[1]])));

    const result = await generateRecommendation(env.supabase, "u1", env.store, MODIFIERS, { client: env.client });

    // PRD l. 39: a hallucinated load is a hard regression — position in the
    // model's ranking buys it nothing. The next option becomes primary.
    expect(result.alternatives.map((a) => a.workout_type)).not.toContain("Very long run");
    expect(result.alternatives[0].workout_type).toBe("Easy run");
    expect(result.degraded).toBe(2);
  });
});
