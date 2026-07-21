import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { WorkoutStep } from "@/types";

/**
 * S-05 shared render for a workout's structured detail: a prominent one-line
 * summary plus, when the session has more than one segment, a collapsed-by-default
 * "show details" toggle revealing the ordered step list (effort · duration · pace).
 * A single-step session (a plain continuous run) shows only the summary, no toggle.
 * Used by both the alternative cards and the committed block so they stay identical.
 */
export default function WorkoutDetailView({ summary, steps }: { summary: string; steps: WorkoutStep[] }) {
  const [open, setOpen] = useState(false);
  const hasBreakdown = steps.length > 1;

  return (
    <div className="mb-2">
      <p className="text-sm font-medium text-white/90">{summary}</p>
      {hasBreakdown ? (
        <>
          <button
            type="button"
            onClick={() => {
              setOpen((o) => !o);
            }}
            aria-expanded={open}
            className="mt-1 flex items-center gap-1 text-xs font-medium text-purple-300 transition-colors hover:text-purple-200"
          >
            {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            {open ? "Hide details" : "Show details"}
          </button>
          {open ? (
            <ol className="mt-2 space-y-1 border-l border-white/10 pl-3">
              {steps.map((step, i) => (
                <li key={`${step.effort}-${i}`} className="flex items-center gap-2 text-xs text-blue-100/70">
                  <span className="w-20 shrink-0 font-medium text-blue-100/90 capitalize">{step.effort}</span>
                  <span className="text-blue-100/60">{step.duration_minutes} min</span>
                  <span className="text-blue-100/40">·</span>
                  <span className="text-blue-100/60">{step.target_pace}/km</span>
                </li>
              ))}
            </ol>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
