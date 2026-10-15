import type { ExerciseSummary, SessionSet, Units } from "../types";
import { bestE1rmSetIndex, estimatedOneRepMax, formatDuration, formatTime, restBeforeSeconds } from "../derive";
import { loadNumber, setLoadLabel } from "../units";
import { Gap } from "./Absent";
import { ToneGlyph } from "./ToneGlyph";

/** The raw record: every set, grouped by exercise, in session order. */
export function SetTable({ exercises, units }: { exercises: ExerciseSummary[]; units: Units }) {
  const allSets = exercises.flatMap((e) => e.sets).sort((a, b) => a.index - b.index);
  return (
    <section className="record" aria-labelledby="record-title">
      <h2 id="record-title" className="record__title">Every set</h2>
      <table className="record__table num">
        <thead>
          <tr>
            <th>#</th><th>Purpose</th><th>Load</th><th>Reps</th><th>Usual reps</th>
            <th>VL</th><th>Best rep</th><th>e1RM</th><th>Start</th><th>Set</th><th>Rest before</th><th>Notes</th>
          </tr>
        </thead>
        {exercises.map((exercise) => (
          <ExerciseGroup key={exercise.exerciseId ?? exercise.name} exercise={exercise} allSets={allSets} units={units} />
        ))}
      </table>
    </section>
  );
}

interface GroupProps {
  exercise: ExerciseSummary;
  allSets: SessionSet[];
  units: Units;
}

function ExerciseGroup({ exercise, allSets, units }: GroupProps) {
  const best = bestE1rmSetIndex(exercise);
  return (
    <tbody>
      <tr className="record__group">
        <th colSpan={12}>
          {exercise.name}
          <span className="record__groupmeta">
            {exercise.workingSetCount} working of {exercise.setCount} sets · {exercise.totalReps} reps
          </span>
        </th>
      </tr>
      {exercise.sets.map((set) => (
        <SetRow
          key={set.id}
          set={set}
          units={units}
          rest={restBeforeSeconds(allSets, allSets.indexOf(set))}
          isVerdictSet={set.index === exercise.verdictSetIndex}
          verdictTone={exercise.verdict?.tone}
          isBest={set.index === best}
        />
      ))}
    </tbody>
  );
}

interface RowProps {
  set: SessionSet;
  units: Units;
  rest: number | null;
  isVerdictSet: boolean;
  verdictTone?: "ok" | "warn" | "alarm";
  isBest: boolean;
}

function SetRow({ set, units, rest, isVerdictSet, verdictTone, isBest }: RowProps) {
  const e1rm = set.setPurpose === "working" ? estimatedOneRepMax(set) : null;
  const durationSec = Math.round((Date.parse(set.endedAt) - Date.parse(set.startedAt)) / 1000);
  const range = set.expectedRepRange;
  return (
    <tr className={set.setPurpose === "working" ? "" : "record__unscored"}>
      <td data-h="#">{set.index}</td>
      <td data-h="Purpose">{set.setPurpose === "warmup" ? "warm-up" : set.setPurpose}</td>
      <td data-h="Load">{setLoadLabel(set, units)}</td>
      <td data-h="Reps"><b>{set.repCount}</b></td>
      <td data-h="Usual reps" title={range?.basis}>
        {range ? `${range.expectedLow}–${range.expectedHigh} (n ${range.n})` : <span className="dim-text">—</span>}
      </td>
      <td data-h="VL">{set.velocityLossPct === null ? <Gap /> : `${set.velocityLossPct}%`}</td>
      <td data-h="Best rep">{set.bestRepVelocity === null ? <Gap /> : `${set.bestRepVelocity.toFixed(2)} m/s`}</td>
      <td data-h="e1RM">{e1rm === null ? <span className="dim-text">—</span> : `${Math.round(loadNumber(e1rm, units))}${isBest ? " ●" : ""}`}</td>
      <td data-h="Start">{formatTime(set.startedAt)}</td>
      <td data-h="Set">{formatDuration(durationSec)}</td>
      <td data-h="Rest">{rest === null ? <span className="dim-text">—</span> : formatDuration(rest)}</td>
      <td data-h="Notes">
        {isVerdictSet && verdictTone && (
          <span className={`verdict-mark tone-${verdictTone}`}>
            <ToneGlyph tone={verdictTone} /> verdict set
          </span>
        )}
      </td>
    </tr>
  );
}

/** Phone form of the raw record: one dense line per set instead of a twelve-column table. */
export function SetList({ exercises, units }: { exercises: ExerciseSummary[]; units: Units }) {
  const allSets = exercises.flatMap((e) => e.sets).sort((a, b) => a.index - b.index);
  return (
    <section className="setlist" aria-label="Every set">
      <h2 className="record__title">Every set</h2>
      {exercises.map((exercise) => (
        <div key={exercise.exerciseId ?? exercise.name} className="setlist__group">
          <h3>
            {exercise.name}
            <span className="record__groupmeta">{exercise.workingSetCount} working of {exercise.setCount} sets</span>
          </h3>
          <ol>
            {exercise.sets.map((set) => (
              <SetLine key={set.id} set={set} units={units} rest={restBeforeSeconds(allSets, allSets.indexOf(set))}
                isVerdictSet={set.index === exercise.verdictSetIndex} />
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}

function SetLine({ set, units, rest, isVerdictSet }: { set: SessionSet; units: Units; rest: number | null; isVerdictSet: boolean }) {
  const e1rm = set.setPurpose === "working" ? estimatedOneRepMax(set) : null;
  const range = set.expectedRepRange;
  return (
    <li className={`setline num${set.setPurpose === "working" ? "" : " record__unscored"}`}>
      <span className="setline__main">
        <span className="setline__idx">#{set.index}</span> {setLoadLabel(set, units)} × <b>{set.repCount}</b>
        {set.setPurpose !== "working" && <span className="setline__purpose"> {set.setPurpose === "warmup" ? "warm-up" : set.setPurpose}</span>}
        {isVerdictSet && <span className="setline__verdict"> · verdict set</span>}
      </span>
      <span className="setline__detail">
        VL {set.velocityLossPct === null ? <Gap /> : `${set.velocityLossPct}%`} · best{" "}
        {set.bestRepVelocity === null ? <Gap /> : `${set.bestRepVelocity.toFixed(2)} m/s`}
        {e1rm !== null && ` · e1RM ${Math.round(loadNumber(e1rm, units))}`}
        {range && ` · usual ${range.expectedLow}–${range.expectedHigh}`}
        {` · ${formatTime(set.startedAt)}`}
        {rest !== null && ` · rest ${formatDuration(rest)}`}
      </span>
    </li>
  );
}
