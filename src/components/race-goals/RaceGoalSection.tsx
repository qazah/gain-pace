import { useState } from "react";
import { Loader2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRaceGoal } from "@/components/hooks/useRaceGoal";
import RaceGoalForm from "./RaceGoalForm";
import RaceGoalSummary from "./RaceGoalSummary";

/**
 * Client island (client:load) that owns the race-goal section: fetches
 * /api/race-goals, then renders the form when no goal exists (or when editing)
 * and a read-only summary card otherwise. Mirrors GarminSection's state switch.
 */
export default function RaceGoalSection() {
  const { goal, loading, error, refetch, save } = useRaceGoal();
  const [editing, setEditing] = useState(false);

  function reload() {
    void refetch();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 p-8 text-blue-100/70 backdrop-blur-xl">
        <Loader2 className="size-4 animate-spin" />
        Loading your race goal…
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-6 text-center backdrop-blur-xl">
        <p className="text-sm text-red-300">{error}</p>
        <Button
          onClick={reload}
          className="rounded-lg bg-purple-600 px-4 py-2 font-medium text-white transition-colors hover:bg-purple-500"
        >
          <RotateCw className="size-4" />
          Retry
        </Button>
      </div>
    );
  }

  if (!goal || editing) {
    return (
      <RaceGoalForm
        save={save}
        initial={editing && goal ? goal : undefined}
        onSaved={() => {
          setEditing(false);
        }}
        onCancel={
          goal
            ? () => {
                setEditing(false);
              }
            : undefined
        }
      />
    );
  }

  return (
    <RaceGoalSummary
      goal={goal}
      onEdit={() => {
        setEditing(true);
      }}
    />
  );
}
