import { useEffect, useState } from "react";

const STAGES = [
  "Reading your recovery…",
  "Weighing your race goal…",
  "Fitting today's time and energy…",
  "Drafting your options…",
];

/**
 * Continuous-progress UI for the 2–10s recommendation call (NFR: any wait >2s
 * must show progress). Three shimmering placeholder cards + rotating status copy.
 */
export default function RecommendationSkeleton() {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setStage((s) => (s + 1) % STAGES.length);
    }, 1800);
    return () => {
      clearInterval(id);
    };
  }, []);

  return (
    <div className="space-y-4">
      <p className="flex items-center gap-2 text-sm text-blue-100/70">
        <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
        {STAGES[stage]}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="animate-pulse rounded-xl border border-white/10 bg-white/5 p-4">
            <div className="mb-3 h-4 w-2/3 rounded bg-white/10" />
            <div className="mb-2 h-3 w-1/3 rounded bg-white/10" />
            <div className="mb-1 h-3 w-full rounded bg-white/10" />
            <div className="h-3 w-4/5 rounded bg-white/10" />
          </div>
        ))}
      </div>
    </div>
  );
}
