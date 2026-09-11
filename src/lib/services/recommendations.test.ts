import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateRecommendation } from "./recommendations";
import { makeRecommendationEnv, modelMessage, modelPayload } from "@/test/recommendation-env";

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
