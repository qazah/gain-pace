import { useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  BatteryMedium,
  CalendarCheck,
  HeartPulse,
  Loader2,
  Moon,
  RefreshCw,
  TriangleAlert,
  Unlink,
} from "lucide-react";
import type { GarminActivity, GarminDashboardData, GarminRecovery } from "@/types";
import { Button } from "@/components/ui/button";
import ConnectGarmin from "./ConnectGarmin";
import ManualWorkoutEntry from "./ManualWorkoutEntry";

interface Props {
  data: GarminDashboardData;
  onReconnect: () => void;
  /** Called after the Garmin connection is severed; parent refetches → connect screen. */
  onDisconnected: () => void;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatDistance(meters: number | null): string {
  if (meters == null) return "—";
  return `${(meters / 1000).toFixed(2)} km`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  return iso.replace("T", " ").slice(0, 16);
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-blue-100/60">
        {icon}
        {label}
      </div>
      <div className="text-2xl font-semibold text-white">{value}</div>
    </div>
  );
}

function RecoveryCard({ recovery }: { recovery: GarminRecovery | null }) {
  // Garmin has no data for a day until the watch syncs it (e.g. today's sleep
  // before the morning sync). `recovery` is non-null but every metric is null —
  // prompt a sync instead of showing a card full of dashes.
  const hasData =
    recovery != null &&
    (recovery.sleepScore != null ||
      recovery.overnightHrv != null ||
      recovery.sleepDurationSeconds != null ||
      recovery.bodyBattery.current != null);

  return (
    <section>
      <h3 className="mb-3 text-sm font-semibold tracking-wide text-blue-100/80 uppercase">Recovery</h3>
      {hasData ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Metric
            icon={<Moon className="size-3.5" />}
            label="Sleep score"
            value={recovery.sleepScore != null ? String(recovery.sleepScore) : "—"}
          />
          <Metric
            icon={<HeartPulse className="size-3.5" />}
            label="Overnight HRV"
            value={recovery.overnightHrv != null ? `${recovery.overnightHrv} ms` : "—"}
          />
          <Metric
            icon={<BatteryMedium className="size-3.5" />}
            label="Body Battery"
            value={recovery.bodyBattery.current != null ? String(recovery.bodyBattery.current) : "—"}
          />
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-blue-100/60">
          <RefreshCw className="size-4 shrink-0 text-purple-300" />
          No recovery data for today yet — sync your Garmin watch to see sleep, HRV, and Body Battery.
        </div>
      )}
    </section>
  );
}

function ActivitiesCard({ activities }: { activities: GarminActivity[] }) {
  return (
    <section>
      <h3 className="mb-3 text-sm font-semibold tracking-wide text-blue-100/80 uppercase">Recent activities</h3>
      {activities.length > 0 ? (
        <ul className="space-y-2">
          {activities.map((a) => (
            <li
              key={a.id}
              className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3"
            >
              <div className="flex items-center gap-2">
                <Activity className="size-4 text-purple-300" />
                <div>
                  <div className="text-sm font-medium text-white">{a.name ?? a.type ?? "Activity"}</div>
                  <div className="text-xs text-blue-100/50">{formatDate(a.startTime)}</div>
                </div>
              </div>
              <div className="text-right text-xs text-blue-100/70">
                <div>{formatDistance(a.distanceMeters)}</div>
                <div>{formatDuration(a.durationSeconds)}</div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-blue-100/50">No recent activities found.</p>
      )}
    </section>
  );
}

function DisconnectControl({ onDisconnected }: { onDisconnected: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disconnect() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/garmin/disconnect", { method: "POST" });
      const json = (await res.json()) as { status: string; message?: string };
      if (json.status === "ok") {
        onDisconnected();
        return;
      }
      setError(json.message ?? "Couldn't disconnect. Please try again.");
    } catch {
      setError("Couldn't reach the server. Please try again.");
    } finally {
      setPending(false);
    }
  }

  if (!confirming) {
    return (
      <section className="border-t border-white/10 pt-4">
        <button
          type="button"
          onClick={() => {
            setConfirming(true);
          }}
          className="flex items-center gap-1.5 text-xs text-blue-100/50 transition-colors hover:text-red-300"
        >
          <Unlink className="size-3.5" />
          Disconnect Garmin
        </button>
      </section>
    );
  }

  return (
    <section className="border-t border-white/10 pt-4">
      <div className="space-y-3 rounded-xl border border-amber-400/30 bg-amber-900/20 p-4">
        <div className="flex items-start gap-2 text-sm text-amber-200">
          <TriangleAlert className="size-4 shrink-0" />
          <p>
            Disconnect Garmin? This removes your stored Garmin login and synced data from GainPace. You&apos;ll need to
            reconnect to see your data again.
          </p>
        </div>
        {error ? <p className="text-sm text-red-300">{error}</p> : null}
        <div className="flex gap-2">
          <Button
            onClick={disconnect}
            disabled={pending}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500"
          >
            {pending ? (
              <span className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                Disconnecting…
              </span>
            ) : (
              "Disconnect"
            )}
          </Button>
          <Button
            onClick={() => {
              setConfirming(false);
              setError(null);
            }}
            disabled={pending}
            className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/20"
          >
            Cancel
          </Button>
        </div>
      </div>
    </section>
  );
}

export default function GarminDashboard({ data, onReconnect, onDisconnected }: Props) {
  return (
    <div className="space-y-6">
      {data.reconnectRequired ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-900/20 px-3 py-2 text-sm text-amber-200">
            <TriangleAlert className="size-4 shrink-0" />
            Your Garmin session expired and couldn&apos;t be renewed automatically. Reconnect to refresh your data.
          </div>
          <ConnectGarmin reconnect onConnected={onReconnect} />
        </div>
      ) : data.stale ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-900/20 px-3 py-2 text-sm text-amber-200">
          <TriangleAlert className="size-4 shrink-0" />
          Garmin is unavailable right now — showing your last synced data, which may be out of date.
        </div>
      ) : null}

      <section>
        <h3 className="mb-3 text-sm font-semibold tracking-wide text-blue-100/80 uppercase">Today&apos;s workout</h3>
        {data.scheduledWorkout ? (
          <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
            <CalendarCheck className="size-5 text-purple-300" />
            <div>
              <div className="text-sm font-medium text-white">{data.scheduledWorkout.title ?? "Scheduled workout"}</div>
              {data.scheduledWorkout.sportType ? (
                <div className="text-xs text-blue-100/50 capitalize">{data.scheduledWorkout.sportType}</div>
              ) : null}
            </div>
          </div>
        ) : (
          <ManualWorkoutEntry />
        )}
      </section>

      <RecoveryCard recovery={data.recovery} />
      <ActivitiesCard activities={data.activities} />
      <DisconnectControl onDisconnected={onDisconnected} />
    </div>
  );
}
