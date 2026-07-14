import { useCallback, useEffect, useState } from "react";
import type { RecommendationResult, WorkoutModifiers, WorkoutSelection } from "@/types";

type Status = "loading" | "idle" | "generating" | "results" | "error" | "not_ready" | "rate_limited";

interface State {
  status: Status;
  /** Today's committed workout (if the runner already selected one). */
  today: WorkoutSelection | null;
  /** The current generation's result (when status === "results"). */
  result: RecommendationResult | null;
  /** Form-level error message (when status === "error"). */
  error: string | null;
  /** Which prerequisite is missing (when status === "not_ready"). */
  notReadyReason: "goal" | "garmin" | null;
  /** Rank of the alternative the runner just committed (marks it in the results). */
  committedRank: string | null;
}

const INITIAL: State = {
  status: "loading",
  today: null,
  result: null,
  error: null,
  notReadyReason: null,
  committedRank: null,
};

/**
 * Drives the S-03 flow: loads today's committed selection on mount, generates
 * recommendations from modifiers, and commits a chosen alternative. Mirrors the
 * useGarminData / useRaceGoal fetch-and-branch shape; branches on the JSON
 * `status` returned by the API rather than only the HTTP code.
 */
export function useRecommendation() {
  const [state, setState] = useState<State>(INITIAL);

  const refetchToday = useCallback(async () => {
    try {
      const res = await fetch("/api/recommendations/select");
      if (res.status === 401) {
        setState((s) => ({ ...s, status: "error", error: "Your session expired — please sign in again." }));
        return;
      }
      const json = (await res.json()) as { selection?: WorkoutSelection | null };
      setState((s) => ({ ...s, status: "idle", today: json.selection ?? null }));
    } catch {
      setState((s) => ({ ...s, status: "error", error: "Couldn't reach the server. Please retry." }));
    }
  }, []);

  const generate = useCallback(async (modifiers: WorkoutModifiers) => {
    setState((s) => ({ ...s, status: "generating", error: null, notReadyReason: null, committedRank: null }));
    try {
      const res = await fetch("/api/recommendations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(modifiers),
      });
      if (res.status === 401) {
        setState((s) => ({ ...s, status: "error", error: "Your session expired — please sign in again." }));
        return;
      }
      const json = (await res.json()) as {
        status: string;
        result?: RecommendationResult;
        reason?: "goal" | "garmin";
        message?: string;
      };
      switch (json.status) {
        case "ok":
          setState((s) => ({ ...s, status: "results", result: json.result ?? null }));
          return;
        case "not_ready":
          setState((s) => ({ ...s, status: "not_ready", notReadyReason: json.reason ?? null }));
          return;
        case "rate_limited":
          setState((s) => ({ ...s, status: "rate_limited" }));
          return;
        default:
          setState((s) => ({
            ...s,
            status: "error",
            error: json.message ?? "Couldn't generate recommendations. Please try again.",
          }));
      }
    } catch {
      setState((s) => ({ ...s, status: "error", error: "Couldn't reach the server. Please try again." }));
    }
  }, []);

  const select = useCallback(
    async (rank: "primary" | "alt_1" | "alt_2") => {
      const result = state.result;
      const alternative = result?.alternatives.find((a) => a.rank === rank);
      if (!result || !alternative) return;
      try {
        const res = await fetch("/api/recommendations/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ alternative, context: result.context }),
        });
        if (res.status === 401) {
          setState((s) => ({ ...s, status: "error", error: "Your session expired — please sign in again." }));
          return;
        }
        const json = (await res.json()) as { status: string; selection?: WorkoutSelection };
        if (json.status === "ok" && json.selection) {
          setState((s) => ({ ...s, today: json.selection ?? null, committedRank: rank }));
        }
      } catch {
        setState((s) => ({ ...s, status: "error", error: "Couldn't save your selection. Please try again." }));
      }
    },
    [state.result],
  );

  /** Back to the modifier form (regenerate / start over). */
  const reset = useCallback(() => {
    setState((s) => ({ ...s, status: "idle", result: null, error: null, notReadyReason: null, committedRank: null }));
  }, []);

  useEffect(() => {
    // Fetch-on-mount: load today's committed selection (setState lands after the await).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refetchToday();
  }, [refetchToday]);

  return { ...state, generate, select, reset, refetchToday };
}
