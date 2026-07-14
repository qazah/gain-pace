import { useState } from "react";
import type { SubmitEvent } from "react";
import { Sparkles } from "lucide-react";
import type { WorkoutModifiers } from "@/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  onGenerate: (modifiers: WorkoutModifiers) => void;
  pending: boolean;
}

const TIME_PRESETS = [30, 45, 60, 90];
const INTENSITY = [
  { value: "low", label: "Easy" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "Hard" },
] as const;
const FEELING = [
  { value: "tired", label: "Tired" },
  { value: "normal", label: "Normal" },
  { value: "energized", label: "Energized" },
] as const;

const chip = "rounded-lg border px-3 py-1.5 text-sm transition-colors";
const chipActive = "border-purple-400 bg-purple-600/40 text-white";
const chipIdle = "border-white/20 bg-white/10 text-blue-100/80 hover:bg-white/20";

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div>
      <span className="mb-1 block text-sm text-blue-100/80">{label}</span>
      <div className="flex gap-2">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => {
              onChange(o.value);
            }}
            className={cn(chip, "flex-1", value === o.value ? chipActive : chipIdle)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function ModifierForm({ onGenerate, pending }: Props) {
  const [timeMinutes, setTimeMinutes] = useState("45");
  const [intensity, setIntensity] = useState<WorkoutModifiers["intensity"]>("normal");
  const [feeling, setFeeling] = useState<WorkoutModifiers["feeling"]>("normal");

  function onSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const minutes = Number(timeMinutes);
    if (!(minutes > 0)) return;
    onGenerate({ time_available_minutes: minutes, intensity, feeling });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div>
        <span className="mb-1 block text-sm text-blue-100/80">Time available</span>
        <div className="mb-2 flex flex-wrap gap-2">
          {TIME_PRESETS.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setTimeMinutes(String(m));
              }}
              className={cn(chip, Number(timeMinutes) === m ? chipActive : chipIdle)}
            >
              {m} min
            </button>
          ))}
        </div>
        <input
          type="number"
          inputMode="numeric"
          min="1"
          value={timeMinutes}
          onChange={(e) => {
            setTimeMinutes(e.target.value);
          }}
          placeholder="Custom minutes"
          className="w-full rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-white placeholder-white/40 transition-colors focus:ring-2 focus:ring-purple-400 focus:outline-none"
        />
      </div>

      <Segmented label="Intensity" options={INTENSITY} value={intensity} onChange={setIntensity} />
      <Segmented label="Feeling" options={FEELING} value={feeling} onChange={setFeeling} />

      <Button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-purple-600 px-4 py-2 font-medium text-white transition-colors hover:bg-purple-500"
      >
        {pending ? (
          <span className="flex items-center gap-2">
            <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            Generating…
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <Sparkles className="size-4" />
            Get today&apos;s options
          </span>
        )}
      </Button>
    </form>
  );
}
