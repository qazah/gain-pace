import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateRecommendation } from "./recommendations";
import { APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import { LlmError } from "./recommendations";
import { makeRecommendationEnv, modelMessage, modelPayload, VALID_ALTERNATIVES } from "@/test/recommendation-env";
import type { ModelRequest } from "@/test/recommendation-env";

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

    // PRD l. 34/47/79: a primary recommendation plus two "if you prefer" options.
    expect(result.alternatives).toHaveLength(3);
    expect(result.alternatives.map((a) => a.rank)).toEqual(["primary", "alt_1", "alt_2"]);
    expect(env.calls()).toBe(1);

    // The context travels back to the select endpoint and is persisted with the
    // chosen workout; losing it strands the saved session from its goal.
    expect(result.context).toMatchObject({
      race_goal_id: "goal-1",
      modifiers: { time_available_minutes: 60 },
    });
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

    // PRD l. 55: every option carries at minimum a workout type, an estimated
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
 * PRD l. 42's own worked example — "a 30 km sprint for a 5 km/week runner" —
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

    // PRD l. 42: an implausible load must never reach the runner. The rest of
    // the session still ships — but the runner is told the set was reduced.
    expect(result.alternatives).toHaveLength(2);
    expect(result.degraded).toBe(2);
    expect(result.alternatives.map((a) => a.workout_type)).not.toContain("Very long run");
  });

  it("offers a lone surviving option rather than discarding it", async () => {
    const env = makeRecommendationEnv();
    env.repeat(modelMessage(modelPayload([VALID_ALTERNATIVES[1], IMPLAUSIBLE, IMPLAUSIBLE])));

    const result = await generateRecommendation(env.supabase, "u1", env.store, MODIFIERS, { client: env.client });

    // PRD l. 42 forbids shipping an implausible load; it does not ask us to
    // withhold a plausible one. One good workout beats no workout at all.
    expect(result.alternatives).toHaveLength(1);
    expect(result.alternatives[0].rank).toBe("primary");
    expect(result.degraded).toBe(1);
  });

  it("drops an option whose steps do not add up, even while salvaging", async () => {
    const env = makeRecommendationEnv();
    // Total duration is plausible (40 min against a ~40 min median), so the LOAD
    // guardrail passes it; only the structure check can catch that the steps sum
    // to 10. S-05 / PRD l. 57: a prescription whose parts contradict its stated
    // length is not a workout the runner can follow.
    const stepsDoNotSum = {
      ...VALID_ALTERNATIVES[0],
      workout_type: "Mismatched steps",
      duration_minutes: 40,
      steps: [{ effort: "easy", duration_minutes: 10, target_pace: "6:00" }],
    };
    env.repeat(modelMessage(modelPayload([VALID_ALTERNATIVES[0], VALID_ALTERNATIVES[1], stepsDoNotSum])));

    const result = await generateRecommendation(env.supabase, "u1", env.store, MODIFIERS, { client: env.client });

    // Both guardrails must keep filtering while the set is being salvaged, not
    // only on the clean path.
    expect(result.alternatives).toHaveLength(2);
    expect(result.degraded).toBe(2);
    expect(result.alternatives.map((a) => a.workout_type)).not.toContain("Mismatched steps");
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

    // PRD l. 42: a hallucinated load is a hard regression — position in the
    // model's ranking buys it nothing. The next option becomes primary.
    expect(result.alternatives.map((a) => a.workout_type)).not.toContain("Very long run");
    expect(result.alternatives[0].workout_type).toBe("Easy run");
    expect(result.degraded).toBe(2);
  });
});

/**
 * Each failure class must be diagnosable on its own, so the caller can tell a
 * timeout from a refusal from shape drift. One parameterised case per class —
 * six near-identical tests would catch the same regression six times.
 */
const FAILURE_CASES = [
  {
    label: "a connection timeout",
    reason: "timeout",
    respond: () => new APIConnectionTimeoutError({ message: "Request timed out." }),
  },
  {
    label: "a transport error",
    reason: "transport",
    respond: () => new Error("socket hang up"),
  },
  {
    label: "a response cut off mid-JSON",
    reason: "truncated",
    respond: () => modelMessage('{"alternatives": [{"workout_type": "Easy', { stop_reason: "max_tokens" }),
  },
  {
    label: "a response that parses but has the wrong shape",
    reason: "invalid_shape",
    respond: () => modelMessage({ alternatives: [] }),
  },
  {
    label: "a persistently implausible set",
    reason: "implausible",
    respond: () => modelMessage(modelPayload([IMPLAUSIBLE, IMPLAUSIBLE, IMPLAUSIBLE])),
  },
] as const;

describe("generateRecommendation — failure taxonomy", () => {
  it.each(FAILURE_CASES)("reports $label as $reason", async ({ reason, respond }) => {
    const env = makeRecommendationEnv();
    env.repeat(respond());

    await expect(
      generateRecommendation(env.supabase, "u1", env.store, MODIFIERS, { client: env.client }),
    ).rejects.toMatchObject({ name: "LlmError", reason });
  });

  it("reports a refusal without spending further attempts on it", async () => {
    const env = makeRecommendationEnv();
    env.repeat(modelMessage(modelPayload(), { stop_reason: "refusal" }));

    await expect(
      generateRecommendation(env.supabase, "u1", env.store, MODIFIERS, { client: env.client }),
    ).rejects.toMatchObject({ name: "LlmError", reason: "refusal" });

    // A refusal is a decision, not a glitch — re-asking wastes the runner's time.
    expect(env.calls()).toBe(1);
  });

  it("keeps an unknown field out of the result instead of failing the request", async () => {
    const env = makeRecommendationEnv();
    const withExtra = VALID_ALTERNATIVES.map((alt) => ({ ...alt, coach_confidence: 0.9 }));
    env.repeat(modelMessage(modelPayload(withExtra)));

    const result = await generateRecommendation(env.supabase, "u1", env.store, MODIFIERS, { client: env.client });

    // Deliberate leniency: a field the model starts sending must not 502 the
    // runner. It is dropped, not rejected — changing this is a conscious call.
    expect(result.alternatives).toHaveLength(3);
    expect(result.alternatives[0]).not.toHaveProperty("coach_confidence");
  });
});

/**
 * PRD l. 101 bounds the whole operation, not each attempt — research 2026-09-11
 * measured a worst case around three minutes once the SDK's own retries and the
 * app loop compound. The bound is asserted behaviourally, by how many attempts
 * the service opened. Measuring elapsed time would test the clock, and naming
 * the budget constant would pin a number no source fixes.
 */
describe("generateRecommendation — the wall-clock budget", () => {
  /**
   * Reads zero when the run starts and, from the next reading on, a point far
   * beyond any budget this service could reasonably adopt. Deliberately not
   * derived from the budget constant, so retuning it cannot quietly defeat the test.
   */
  function clockThatJumpsAfterTheFirstReading(): () => number {
    let read = false;
    return () => {
      if (!read) {
        read = true;
        return 0;
      }
      return 60 * 60 * 1000; // an hour later
    };
  }

  it("opens no further attempt once the budget is spent", async () => {
    const env = makeRecommendationEnv();
    // A response the service would normally retry — so opening a second attempt
    // is precisely what the budget has to prevent here.
    env.repeat(modelMessage({ alternatives: [] }));

    await expect(
      generateRecommendation(env.supabase, "u1", env.store, MODIFIERS, {
        client: env.client,
        now: clockThatJumpsAfterTheFirstReading(),
      }),
    ).rejects.toMatchObject({ name: "LlmError", reason: "timeout" });

    // The first attempt always runs: the budget stops the retry, not the request.
    expect(env.calls()).toBe(1);
  });

  it("still retries a rejected response while the budget holds", async () => {
    const env = makeRecommendationEnv();
    env.repeat(modelMessage({ alternatives: [] }));

    await expect(
      generateRecommendation(env.supabase, "u1", env.store, MODIFIERS, {
        client: env.client,
        now: () => 0, // time never advances, so the budget can never be spent
      }),
    ).rejects.toMatchObject({ name: "LlmError", reason: "invalid_shape" });

    // More than one attempt proves the guard does not fire on a healthy run.
    // The exact ceiling is MAX_ATTEMPTS' business, not this test's.
    expect(env.calls()).toBeGreaterThan(1);
  });
});

/**
 * What we ask the model for is part of the contract, not an internal detail:
 * Risk #1 (test-plan §2) is a parse failure that leaves the runner with an
 * error instead of three options, and it reached production on 2026-09-13.
 * These two assertions exist because the Stryker run of Phase 5 showed the
 * request body was entirely unguarded — `create({})` survived.
 */
/** The prompt text of a recorded request; the service sends plain text. */
function promptOf(request: ModelRequest): string {
  const { content } = request.messages[0];
  if (typeof content !== "string") {
    throw new Error("expected a plain-text prompt, got structured content");
  }
  return content;
}

describe("generateRecommendation — what we ask the model for", () => {
  it("asks for structured output against the recommendation schema", async () => {
    const env = makeRecommendationEnv();
    env.queue(modelMessage(modelPayload()));

    await generateRecommendation(env.supabase, "u1", env.store, MODIFIERS, { client: env.client });

    // Without the schema the model may answer in prose, and every attempt then
    // fails the parse — the runner sees a 502, not a recommendation.
    expect(env.requests[0]).toMatchObject({
      output_config: { format: { type: "json_schema" } },
      messages: [{ role: "user" }],
    });
    expect(env.requests[0].system).toBeTruthy();
  });

  it("tells the model what was rejected when it asks again", async () => {
    const env = makeRecommendationEnv();
    env.repeat(modelMessage({ alternatives: [] }));

    await expect(
      generateRecommendation(env.supabase, "u1", env.store, MODIFIERS, { client: env.client }),
    ).rejects.toMatchObject({ name: "LlmError" });

    // A retry that repeats the first prompt verbatim is not a retry: the model
    // has been given no reason to answer any differently.
    const [first, second] = env.requests;
    expect(promptOf(second)).not.toEqual(promptOf(first));
    expect(promptOf(second).length).toBeGreaterThan(promptOf(first).length);
    // ...and the opening ask is not itself a re-prompt: telling the model its
    // previous answer was rejected before it has given one is nonsense input
    // on every single request.
    expect(promptOf(first)).not.toContain("was rejected");
  });
});
