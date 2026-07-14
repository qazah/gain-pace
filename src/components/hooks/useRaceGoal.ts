import { useCallback, useEffect, useState } from "react";
import type { RaceGoal, RaceGoalInput } from "@/types";

interface State {
  goal: RaceGoal | null;
  loading: boolean;
  error: string | null;
}

export interface SaveResult {
  ok: boolean;
  /** Field→message map from the server's semantic validation (status "invalid"). */
  issues?: Record<string, string>;
  /** Form-level message for non-field failures (session/config/server/network). */
  error?: string;
}

/**
 * Fetches the runner's active race goal from GET /api/race-goals and exposes a
 * `save` action that POSTs a create-or-update. Mirrors useGarminData: a
 * `{ goal, loading, error }` state with a `refetch`. On a successful save the
 * hook updates `goal` in place so the section can switch to the summary view.
 */
export function useRaceGoal() {
  const [state, setState] = useState<State>({ goal: null, loading: true, error: null });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/race-goals");
      if (res.status === 401) {
        setState({ goal: null, loading: false, error: "Your session expired — please sign in again." });
        return;
      }
      const json = (await res.json()) as { goal?: RaceGoal | null; message?: string };
      if ("goal" in json) {
        setState({ goal: json.goal ?? null, loading: false, error: null });
      } else {
        setState({ goal: null, loading: false, error: json.message ?? "Couldn't load your race goal." });
      }
    } catch {
      setState({ goal: null, loading: false, error: "Couldn't reach the server. Check your connection and retry." });
    }
  }, []);

  const refetch = useCallback(() => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    return load();
  }, [load]);

  const save = useCallback(async (input: RaceGoalInput): Promise<SaveResult> => {
    try {
      const res = await fetch("/api/race-goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const json = (await res.json()) as {
        status: string;
        goal?: RaceGoal;
        issues?: Record<string, string>;
        message?: string;
      };
      if (json.status === "ok" && json.goal) {
        const goal = json.goal;
        setState({ goal, loading: false, error: null });
        return { ok: true };
      }
      if (json.status === "invalid") {
        return { ok: false, issues: json.issues ?? {} };
      }
      if (json.status === "unauthorized") {
        return { ok: false, error: "Your session expired — please sign in again." };
      }
      return { ok: false, error: json.message ?? "Couldn't save your race goal. Please try again." };
    } catch {
      return { ok: false, error: "Couldn't reach the server. Please try again." };
    }
  }, []);

  useEffect(() => {
    // Fetch-on-mount (setState lands after the await — not a synchronous cascade).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return { ...state, refetch, save };
}
