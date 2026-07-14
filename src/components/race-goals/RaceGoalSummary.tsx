import { CalendarDays, Gauge, Pencil, Route, Target, Timer } from "lucide-react";
import type { ReactNode } from "react";
import type { RaceGoal } from "@/types";
import { Button } from "@/components/ui/button";
import { paceSecondsPerKm } from "@/lib/race-goal-validation";

interface Props {
  goal: RaceGoal;
  onEdit: () => void;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** target_finish_seconds → "h:mm:ss" (or "m:ss" under an hour). */
function formatTime(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** seconds-per-km → "m:ss /km". */
function formatPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  // Guard the 60-second rounding edge (e.g. 5:60 → 6:00).
  return s === 60 ? `${m + 1}:00 /km` : `${m}:${pad(s)} /km`;
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="mb-1 flex items-center gap-1.5 text-xs text-blue-100/60">
        {icon}
        {label}
      </div>
      <div className="text-xl font-semibold text-white">{value}</div>
    </div>
  );
}

export default function RaceGoalSummary({ goal, onEdit }: Props) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-white">
          <Target className="size-5 text-purple-300" />
          <h2 className="text-lg font-semibold">Race goal</h2>
        </div>
        <Button
          onClick={onEdit}
          className="rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-white/20"
        >
          <Pencil className="size-4" />
          Edit
        </Button>
      </div>

      <p className="mb-4 text-2xl font-bold text-white">{goal.event_name}</p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Stat icon={<CalendarDays className="size-3.5" />} label="Event date" value={formatDate(goal.event_date)} />
        <Stat icon={<Route className="size-3.5" />} label="Distance" value={`${goal.distance_km} km`} />
        <Stat
          icon={<Timer className="size-3.5" />}
          label="Target time"
          value={formatTime(goal.target_finish_seconds)}
        />
        <Stat icon={<Gauge className="size-3.5" />} label="Target pace" value={formatPace(paceSecondsPerKm(goal))} />
      </div>
    </div>
  );
}
