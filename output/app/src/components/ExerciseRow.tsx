import type { ExerciseSummary, Units } from "../types";
import { formatLoad, formatVolume } from "../units";
import { NextTime } from "./NextTime";
import { SetStrip } from "./SetStrip";
import { VerdictPanel } from "./VerdictPanel";

/** One exercise, read left to right in the page's priority order: verdict, evidence, next time. */
export function ExerciseRow({ exercise, units }: { exercise: ExerciseSummary; units: Units }) {
  const unattributed = exercise.exerciseId === null;
  return (
    <article className="row" id={`ex-${exercise.exerciseId ?? "unattributed"}`}>
      <header className="row__head">
        <h2 className={`row__name${unattributed ? " row__name--unattributed" : ""}`}>{exercise.name}</h2>
        {unattributed && <span className="tag">no exercise named</span>}
        <ExerciseMeta exercise={exercise} units={units} />
      </header>
      <VerdictPanel exercise={exercise} />
      <SetStrip exercise={exercise} units={units} />
      <NextTime exercise={exercise} units={units} />
    </article>
  );
}

function ExerciseMeta({ exercise, units }: { exercise: ExerciseSummary; units: Units }) {
  return (
    <p className="row__meta num">
      <span>{exercise.topWeightLbs === null ? "no weighted load" : `top ${formatLoad(exercise.topWeightLbs, units)}`}</span>
      {exercise.volumeLbs === null ? (
        <span className="gap">volume not recorded</span>
      ) : (
        <span>{formatVolume(exercise.volumeLbs, units)} volume</span>
      )}
      <span>
        best rep{" "}
        {exercise.bestRepVelocity === null ? <span className="gap">no telemetry</span> : `${exercise.bestRepVelocity.toFixed(2)} m/s`}
      </span>
    </p>
  );
}
