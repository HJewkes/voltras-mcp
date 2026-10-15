import type { SessionSummary, Units } from "../types";
import { ExerciseRow } from "./ExerciseRow";
import { GlanceList } from "./GlanceList";
import { SessionHeader } from "./SessionHeader";
import { SetList, SetTable } from "./SetTable";
import { StripLegend } from "./SetStrip";

interface PageProps {
  summary: SessionSummary;
  units: Units;
  onUnits: (units: Units) => void;
}

export function SessionPage({ summary, units, onUnits }: PageProps) {
  return (
    <main className="page">
      <SessionHeader summary={summary} units={units} onUnits={onUnits} />
      {summary.exercises.length > 1 && <GlanceList exercises={summary.exercises} units={units} />}
      <div className="rows">
        {summary.exercises.map((exercise) => (
          <ExerciseRow key={exercise.exerciseId ?? exercise.name} exercise={exercise} units={units} />
        ))}
      </div>
      <StripLegend />
      <SetTable exercises={summary.exercises} units={units} />
      <SetList exercises={summary.exercises} units={units} />
    </main>
  );
}
