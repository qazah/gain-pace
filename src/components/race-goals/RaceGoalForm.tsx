import { useState } from "react";
import type { SubmitEvent } from "react";
import { Flag, Save, Target } from "lucide-react";
import type { RaceGoal, RaceGoalInput } from "@/types";
import { FormField } from "@/components/auth/FormField";
import { ServerError } from "@/components/auth/ServerError";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { validateRaceGoal } from "@/lib/race-goal-validation";
import type { SaveResult } from "@/components/hooks/useRaceGoal";

interface Props {
  save: (input: RaceGoalInput) => Promise<SaveResult>;
  /** When present, the form edits an existing goal (fields prefilled). */
  initial?: RaceGoal;
  onSaved: () => void;
  /** When present, renders a Cancel button (only meaningful when editing). */
  onCancel?: () => void;
}

/** Common race distances → exact km under the schema's NUMERIC(6,2). */
const PRESETS: { label: string; km: number }[] = [
  { label: "5K", km: 5.0 },
  { label: "10K", km: 10.0 },
  { label: "Half", km: 21.1 },
  { label: "Marathon", km: 42.2 },
];

const inputClass =
  "w-full rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-white placeholder-white/40 transition-colors focus:ring-2 focus:ring-purple-400 focus:outline-none";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function splitSeconds(total: number): { h: string; m: string; s: string } {
  return {
    h: String(Math.floor(total / 3600)),
    m: String(Math.floor((total % 3600) / 60)),
    s: String(total % 60),
  };
}

export default function RaceGoalForm({ save, initial, onSaved, onCancel }: Props) {
  const initialTime = initial ? splitSeconds(initial.target_finish_seconds) : { h: "", m: "", s: "" };
  const [eventName, setEventName] = useState(initial?.event_name ?? "");
  const [eventDate, setEventDate] = useState(initial?.event_date ?? "");
  const [distanceKm, setDistanceKm] = useState(initial ? String(initial.distance_km) : "");
  const [hours, setHours] = useState(initialTime.h);
  const [minutes, setMinutes] = useState(initialTime.m);
  const [seconds, setSeconds] = useState(initialTime.s);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function buildInput(): RaceGoalInput {
    const h = Number(hours) || 0;
    const m = Number(minutes) || 0;
    const s = Number(seconds) || 0;
    return {
      event_name: eventName.trim(),
      event_date: eventDate,
      distance_km: Number(distanceKm),
      target_finish_seconds: h * 3600 + m * 60 + s,
    };
  }

  async function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    const input = buildInput();
    const issues = validateRaceGoal(input, todayIso());
    if (Object.keys(issues).length > 0) {
      setFieldErrors(issues);
      return;
    }
    setFieldErrors({});
    setPending(true);
    try {
      const result = await save(input);
      if (result.ok) {
        onSaved();
        return;
      }
      if (result.issues && Object.keys(result.issues).length > 0) {
        setFieldErrors(result.issues);
      } else {
        setFormError(result.error ?? "Couldn't save your race goal. Please try again.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl">
      <div className="mb-4 flex items-center gap-2 text-white">
        <Target className="size-5 text-purple-300" />
        <h2 className="text-lg font-semibold">{initial ? "Edit your race goal" : "Set your race goal"}</h2>
      </div>

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <p className="text-sm text-blue-100/70">
          Tell GainPace the race you&apos;re training for so it can tailor today&apos;s workout options to your goal.
        </p>

        <FormField
          id="race-event-name"
          label="Event name"
          value={eventName}
          onChange={setEventName}
          placeholder="Berlin Marathon"
          icon={<Flag className="size-4" />}
          error={fieldErrors.event_name}
        />

        <div>
          <label htmlFor="race-event-date" className="mb-1 block text-sm text-blue-100/80">
            Event date
          </label>
          <input
            id="race-event-date"
            type="date"
            min={todayIso()}
            value={eventDate}
            onChange={(e) => {
              setEventDate(e.target.value);
            }}
            className={cn(inputClass, fieldErrors.event_date && "border-red-400/60 focus:ring-red-400")}
          />
          {fieldErrors.event_date ? <p className="mt-1 text-xs text-red-300">{fieldErrors.event_date}</p> : null}
        </div>

        <div>
          <span className="mb-1 block text-sm text-blue-100/80">Distance</span>
          <div className="mb-2 flex flex-wrap gap-2">
            {PRESETS.map((p) => {
              const active = Number(distanceKm) === p.km;
              return (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    setDistanceKm(String(p.km));
                  }}
                  className={cn(
                    "rounded-lg border px-3 py-1.5 text-sm transition-colors",
                    active
                      ? "border-purple-400 bg-purple-600/40 text-white"
                      : "border-white/20 bg-white/10 text-blue-100/80 hover:bg-white/20",
                  )}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          <input
            id="race-distance-km"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={distanceKm}
            onChange={(e) => {
              setDistanceKm(e.target.value);
            }}
            placeholder="Custom distance (km)"
            className={cn(inputClass, fieldErrors.distance_km && "border-red-400/60 focus:ring-red-400")}
          />
          {fieldErrors.distance_km ? <p className="mt-1 text-xs text-red-300">{fieldErrors.distance_km}</p> : null}
        </div>

        <div>
          <span className="mb-1 block text-sm text-blue-100/80">Target finish time</span>
          <div className="flex items-center gap-2">
            <TimePart
              label="hrs"
              value={hours}
              onChange={setHours}
              max={99}
              error={!!fieldErrors.target_finish_seconds}
            />
            <span className="text-white/50">:</span>
            <TimePart
              label="min"
              value={minutes}
              onChange={setMinutes}
              max={59}
              error={!!fieldErrors.target_finish_seconds}
            />
            <span className="text-white/50">:</span>
            <TimePart
              label="sec"
              value={seconds}
              onChange={setSeconds}
              max={59}
              error={!!fieldErrors.target_finish_seconds}
            />
          </div>
          {fieldErrors.target_finish_seconds ? (
            <p className="mt-1 text-xs text-red-300">{fieldErrors.target_finish_seconds}</p>
          ) : null}
        </div>

        <ServerError message={formError} />

        <div className="flex gap-2">
          <Button
            type="submit"
            disabled={pending}
            className="flex-1 rounded-lg bg-purple-600 px-4 py-2 font-medium text-white transition-colors hover:bg-purple-500"
          >
            {pending ? (
              <span className="flex items-center gap-2">
                <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Saving…
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <Save className="size-4" />
                Save goal
              </span>
            )}
          </Button>
          {onCancel ? (
            <Button
              type="button"
              onClick={onCancel}
              disabled={pending}
              className="rounded-lg border border-white/20 bg-white/10 px-4 py-2 font-medium text-white transition-colors hover:bg-white/20"
            >
              Cancel
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

interface TimePartProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  max: number;
  error: boolean;
}

function TimePart({ label, value, onChange, max, error }: TimePartProps) {
  return (
    <label className="flex flex-1 flex-col items-center">
      <input
        type="number"
        inputMode="numeric"
        min="0"
        max={max}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        placeholder="0"
        aria-label={label}
        className={cn(
          "w-full rounded-lg border bg-white/10 px-3 py-2 text-center text-white placeholder-white/40 transition-colors focus:ring-2 focus:outline-none",
          error ? "border-red-400/60 focus:ring-red-400" : "border-white/20 focus:ring-purple-400",
        )}
      />
      <span className="mt-1 text-xs text-blue-100/50">{label}</span>
    </label>
  );
}
