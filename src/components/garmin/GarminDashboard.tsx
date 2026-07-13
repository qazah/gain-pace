import type { ReactNode } from "react";
import { Activity, BatteryMedium, CalendarCheck, HeartPulse, Moon, RefreshCw, TriangleAlert } from "lucide-react";
import type { GarminActivity, GarminDashboardData, GarminRecovery } from "@/types";
import ConnectGarmin from "./ConnectGarmin";
import ManualWorkoutEntry from "./ManualWorkoutEntry";

interface Props {
  data: GarminDashboardData;
  onReconnect: () => void;
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

export default function GarminDashboard({ data, onReconnect }: Props) {
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
    </div>
  );
}
