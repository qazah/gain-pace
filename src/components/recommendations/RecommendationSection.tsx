import { CalendarCheck, Loader2, RotateCw, Sparkles, Target, TrendingUp, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRecommendation } from "@/components/hooks/useRecommendation";
import ModifierForm from "./ModifierForm";
import RecommendationSkeleton from "./RecommendationSkeleton";
import RecommendationResults from "./RecommendationResults";
import WorkoutDetailView from "./WorkoutDetailView";

/**
 * Client island (client:load) for the S-03 loop. Gates on prerequisites,
 * drives the modifier form, shows skeleton progress during the AI call, renders
 * the alternatives, and commits a selection. Mirrors GarminSection's state switch.
 */

const cardBase = "rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl";

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m} min`;
}

export default function RecommendationSection() {
  const { status, today, result, error, notReadyReason, committedRank, generate, select, reset } = useRecommendation();

  const heading = (
    <div className="mb-4 flex items-center gap-2 text-white">
      <Sparkles className="size-5 text-purple-300" />
      <h2 className="text-lg font-semibold">Today&apos;s workout</h2>
    </div>
  );

  if (status === "loading") {
    return (
      <div className={`flex items-center justify-center gap-2 ${cardBase} text-blue-100/70`}>
        <Loader2 className="size-4 animate-spin" />
        Loading…
      </div>
    );
  }

  if (status === "not_ready") {
    const isGoal = notReadyReason === "goal";
    return (
      <div className={cardBase}>
        {heading}
        <div className="flex items-start gap-2 text-sm text-blue-100/80">
          <Target className="mt-0.5 size-4 shrink-0 text-purple-300" />
          <p>
            {isGoal
              ? "Set your race goal first — the recommendation is tailored to it. Use the Race goal section below."
              : "Connect your Garmin account first — recommendations use your recovery and recent activity. Use the Garmin section below."}
          </p>
        </div>
      </div>
    );
  }

  if (status === "rate_limited") {
    return (
      <div className={cardBase}>
        {heading}
        <p className="text-sm text-blue-100/80">
          You&apos;ve reached today&apos;s recommendation limit. Come back tomorrow for fresh options.
        </p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className={`space-y-3 ${cardBase} text-center`}>
        <p className="text-sm text-red-300">{error}</p>
        <Button
          onClick={reset}
          className="rounded-lg bg-purple-600 px-4 py-2 font-medium text-white transition-colors hover:bg-purple-500"
        >
          <RotateCw className="size-4" />
          Try again
        </Button>
      </div>
    );
  }

  if (status === "generating") {
    return (
      <div className={cardBase}>
        {heading}
        <RecommendationSkeleton />
      </div>
    );
  }

  if (status === "results" && result) {
    return (
      <div className={cardBase}>
        {heading}
        <RecommendationResults result={result} committedRank={committedRank} onSelect={select} onStartOver={reset} />
      </div>
    );
  }

  // idle: show today's committed workout (if any) + the modifier form to (re)generate.
  return (
    <div className={cardBase}>
      {heading}
      {today ? (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-green-400/30 bg-green-900/15 px-4 py-3">
          <CalendarCheck className="mt-0.5 size-5 shrink-0 text-green-300" />
          <div>
            <div className="mb-1 text-sm font-medium text-white">
              Committed: {today.workout_type} · {formatDuration(today.duration_minutes)}
            </div>
            {today.workout_detail ? (
              <WorkoutDetailView summary={today.workout_detail.summary} steps={today.workout_detail.steps} />
            ) : null}
            {today.recovery_warning ? (
              <div className="mt-1 flex items-start gap-1.5 text-xs text-amber-200">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>{today.recovery_warning}</span>
              </div>
            ) : null}
            <p className="mt-0.5 text-xs text-blue-100/70">{today.ai_explanation}</p>
            {today.training_arc_note ? (
              <div className="mt-1 flex items-start gap-1.5 text-xs text-blue-100/60">
                <TrendingUp className="mt-0.5 size-3.5 shrink-0 text-purple-300" />
                <span>{today.training_arc_note}</span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      <ModifierForm onGenerate={generate} pending={false} />
    </div>
  );
}
