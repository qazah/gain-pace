import { Check, Clock, Star, TriangleAlert } from "lucide-react";
import type { RecommendationResult, WorkoutAlternative } from "@/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  result: RecommendationResult;
  committedRank: string | null;
  onSelect: (rank: "primary" | "alt_1" | "alt_2") => void;
  onStartOver: () => void;
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m} min`;
}

function Card({
  alt,
  primary,
  committed,
  onSelect,
}: {
  alt: WorkoutAlternative;
  primary: boolean;
  committed: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        primary ? "border-purple-400/60 bg-purple-600/15" : "border-white/10 bg-white/5",
      )}
    >
      <div className="mb-1 flex items-center gap-1.5">
        {primary ? <Star className="size-4 text-purple-300" /> : null}
        <span className="text-sm font-semibold text-white">{alt.workout_type}</span>
      </div>
      <div className="mb-2 flex items-center gap-1 text-xs text-blue-100/60">
        <Clock className="size-3.5" />
        {formatDuration(alt.duration_minutes)}
      </div>
      <p className="mb-3 text-sm text-blue-100/80">{alt.ai_explanation}</p>
      <Button
        onClick={onSelect}
        disabled={committed}
        className={cn(
          "w-full rounded-lg px-3 py-1.5 text-sm font-medium text-white transition-colors",
          committed ? "bg-green-600/40" : "bg-purple-600 hover:bg-purple-500",
        )}
      >
        {committed ? (
          <span className="flex items-center justify-center gap-1.5">
            <Check className="size-4" />
            Committed
          </span>
        ) : (
          "Choose this"
        )}
      </Button>
    </div>
  );
}

export default function RecommendationResults({ result, committedRank, onSelect, onStartOver }: Props) {
  const primary = result.alternatives.find((a) => a.rank === "primary");
  const alternatives = result.alternatives.filter((a) => a.rank !== "primary");

  return (
    <div className="space-y-4">
      {result.stale || result.recoveryMissing ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-900/20 px-3 py-2 text-xs text-amber-200">
          <TriangleAlert className="size-4 shrink-0" />
          {result.recoveryMissing
            ? "No recovery data synced today — these options weigh your goal and recent activity, with lower confidence on today's readiness."
            : "Garmin data may be out of date — recommendations use your last synced snapshot."}
        </div>
      ) : null}

      {primary ? (
        <div>
          <h3 className="mb-2 text-sm font-semibold tracking-wide text-blue-100/80 uppercase">Recommended for today</h3>
          <Card
            alt={primary}
            primary
            committed={committedRank === "primary"}
            onSelect={() => {
              onSelect("primary");
            }}
          />
        </div>
      ) : null}

      {alternatives.length > 0 ? (
        <div>
          <h3 className="mb-2 text-sm font-semibold tracking-wide text-blue-100/80 uppercase">If you prefer</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {alternatives.map((alt) => (
              <Card
                key={alt.rank}
                alt={alt}
                primary={false}
                committed={committedRank === alt.rank}
                onSelect={() => {
                  onSelect(alt.rank);
                }}
              />
            ))}
          </div>
        </div>
      ) : null}

      <Button
        onClick={onStartOver}
        className="rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/20"
      >
        Change modifiers
      </Button>
    </div>
  );
}
