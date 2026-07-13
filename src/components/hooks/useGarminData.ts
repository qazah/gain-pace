import { useCallback, useEffect, useState } from "react";
import type { GarminDashboardData } from "@/types";

interface State {
  data: GarminDashboardData | null;
  loading: boolean;
  error: string | null;
}

/**
 * Fetches the dashboard's Garmin payload from GET /api/garmin/data and exposes
 * a refetch (used after a successful connect / reconnect). The endpoint is
 * graceful by construction — a sidecar/Garmin failure still returns 200 with a
 * cached snapshot + stale flag — so `error` here is only for our-own-API / network
 * failures, not for Garmin being down.
 */
export function useGarminData() {
  const [state, setState] = useState<State>({ data: null, loading: true, error: null });

  // `await`-first (no synchronous setState) so it is safe to call from the mount
  // effect without triggering cascading renders.
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/garmin/data");
      if (res.status === 401) {
        setState({ data: null, loading: false, error: "Your session expired — please sign in again." });
        return;
      }
      const json = (await res.json()) as GarminDashboardData | { status: string; message?: string };
      if ("connected" in json) {
        setState({ data: json, loading: false, error: null });
      } else {
        setState({ data: null, loading: false, error: json.message ?? "Garmin is not available right now." });
      }
    } catch {
      setState({ data: null, loading: false, error: "Couldn't reach the server. Check your connection and retry." });
    }
  }, []);

  // Called from event handlers (retry / after connect): flips to a loading state, then reloads.
  const refetch = useCallback(() => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    return load();
  }, [load]);

  useEffect(() => {
    // Fetch-on-mount: the canonical valid effect (setState lands after the await,
    // once, when data arrives — not a synchronous cascading render).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return { ...state, refetch };
}
