import { useState } from "react";
import { PencilLine } from "lucide-react";

/**
 * No-plan fallback (PRD Open Question 1). When Garmin has no scheduled workout
 * for today, let the runner type today's plan so the downstream product loop
 * still works. For S-01 this feeds the display only — full persistence of the
 * manual plan is an S-03 concern.
 */
export default function ManualWorkoutEntry() {
  const [value, setValue] = useState("");

  return (
    <div>
      <label htmlFor="manual-workout" className="mb-1 flex items-center gap-1.5 text-sm text-blue-100/80">
        <PencilLine className="size-4 text-purple-300" />
        No workout scheduled in Garmin — enter today&apos;s plan
      </label>
      <input
        id="manual-workout"
        type="text"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
        }}
        placeholder="e.g. Easy 5 km @ 6:00/km"
        className="w-full rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-white placeholder-white/40 transition-colors focus:ring-2 focus:ring-purple-400 focus:outline-none"
      />
      {value.trim() ? <p className="mt-2 text-sm text-blue-100/70">Today&apos;s plan: {value}</p> : null}
    </div>
  );
}
