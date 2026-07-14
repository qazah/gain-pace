import type { RaceGoalInput } from "@/types";

/**
 * Single source of truth for race-goal semantic guardrails (S-02).
 *
 * Framework-free by design — no Zod, no `astro:*` imports — so it can be bundled
 * into the React client for inline validation AND imported by the API route for
 * server-side enforcement. The API route parses request SHAPE with astro/zod,
 * then calls {@link validateRaceGoal} for these SEMANTIC checks; the form calls
 * the same function so the guardrail bands live in exactly one place.
 *
 * The bands are heuristics tuned to block malformed AI context for S-03 (past
 * dates, fat-fingered distances, impossible paces) without rejecting legitimate
 * inputs. Tune the constants here if they prove too tight/loose.
 */

/** Shortest sane race distance, km. */
export const DISTANCE_MIN_KM = 1;
/** Longest supported race distance, km. Ultras >100 km are out of scope this slice. */
export const DISTANCE_MAX_KM = 100;
/** Fastest plausible pace, seconds/km (~2:30/km — below every world record). */
export const PACE_MIN_SEC_PER_KM = 150;
/** Slowest plausible pace, seconds/km (~15:00/km — lenient for walk-heavy finishers). */
export const PACE_MAX_SEC_PER_KM = 900;
/** Max event-name length. */
export const EVENT_NAME_MAX = 100;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Average pace implied by a goal, in seconds per km. Callers guard distance > 0. */
export function paceSecondsPerKm(input: Pick<RaceGoalInput, "distance_km" | "target_finish_seconds">): number {
  return input.target_finish_seconds / input.distance_km;
}

/**
 * Validate a race-goal input against the semantic guardrails.
 *
 * @param todayIso today's calendar date as YYYY-MM-DD (caller supplies it so the
 *   check is deterministic and the module stays clock-free).
 * @returns a field→message map; an EMPTY object means the input is valid.
 */
export function validateRaceGoal(input: RaceGoalInput, todayIso: string): Record<string, string> {
  const errors: Record<string, string> = {};

  const name = input.event_name.trim();
  if (name.length === 0) {
    errors.event_name = "Event name is required.";
  } else if (name.length > EVENT_NAME_MAX) {
    errors.event_name = `Event name must be ${EVENT_NAME_MAX} characters or fewer.`;
  }

  if (!DATE_RE.test(input.event_date)) {
    errors.event_date = "Enter a valid date.";
  } else if (input.event_date < todayIso) {
    errors.event_date = "Event date must be today or later.";
  }

  const distanceValid = Number.isFinite(input.distance_km);
  if (!distanceValid || input.distance_km < DISTANCE_MIN_KM || input.distance_km > DISTANCE_MAX_KM) {
    errors.distance_km = `Distance must be between ${DISTANCE_MIN_KM} and ${DISTANCE_MAX_KM} km.`;
  }

  const timeValid = Number.isInteger(input.target_finish_seconds) && input.target_finish_seconds > 0;
  if (!timeValid) {
    errors.target_finish_seconds = "Enter a target finish time.";
  }

  // Pace sanity only makes sense once distance and time are individually valid.
  if (!errors.distance_km && !errors.target_finish_seconds) {
    const pace = paceSecondsPerKm(input);
    if (pace < PACE_MIN_SEC_PER_KM || pace > PACE_MAX_SEC_PER_KM) {
      errors.target_finish_seconds = "Target time is implausible for this distance.";
    }
  }

  return errors;
}
