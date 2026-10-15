import type { ExerciseSummary, SessionSet, Tone, Units } from "../types";
import { bestE1rmSetIndex, estimatedOneRepMax } from "../derive";
import { loadNumber, setLoadLabel } from "../units";
import { ToneGlyph } from "./ToneGlyph";

const VL_SCALE_MAX = 40;
const THRESHOLDS = [10, 20, 30];

interface StripProps {
  exercise: ExerciseSummary;
  units: Units;
}

/**
 * The evidence: one column per set in session order. Velocity loss is the bar
 * (fatigue); reps sit under it against the plan's target; e1RM is the strength line.
 */
export function SetStrip({ exercise, units }: StripProps) {
  const bestIndex = bestE1rmSetIndex(exercise);
  const range = exercise.progression;
  return (
    <figure className="strip" aria-label={`${exercise.name}: every set`}>
      <div className="strip__rowlabels" aria-hidden>
        <span className="strip__rowlabel strip__rowlabel--bars">VL</span>
        <span className="strip__rowlabel">Reps</span>
        <span className="strip__rowlabel">Load</span>
        <span className="strip__rowlabel">e1RM</span>
      </div>
      <div className="strip__plot">
        <Thresholds />
        <ol className="strip__cols">
          {exercise.sets.map((set) => (
            <SetColumn
              key={set.id}
              set={set}
              units={units}
              isBest={set.index === bestIndex}
              verdictTone={set.index === exercise.verdictSetIndex ? exercise.verdict?.tone : undefined}
              targetLow={range?.targetRepsLow}
              targetHigh={range?.targetRepsHigh}
            />
          ))}
        </ol>
      </div>
    </figure>
  );
}

function Thresholds() {
  return (
    <div className="strip__thresholds" aria-hidden>
      {THRESHOLDS.map((t) => (
        <div key={t} className="threshold" style={{ bottom: `${(t / VL_SCALE_MAX) * 100}%` }}>
          <span>VL{t}</span>
        </div>
      ))}
    </div>
  );
}

interface ColumnProps {
  set: SessionSet;
  units: Units;
  isBest: boolean;
  verdictTone?: Tone;
  targetLow?: number;
  targetHigh?: number;
}

function SetColumn({ set, units, isBest, verdictTone, targetLow, targetHigh }: ColumnProps) {
  const working = set.setPurpose === "working";
  const e1rm = working ? estimatedOneRepMax(set) : null;
  const classes = ["col", working ? "col--working" : "col--unscored", verdictTone ? `col--verdict tone-${verdictTone}` : ""];
  return (
    <li className={classes.join(" ")} aria-label={`Set ${set.index}, ${set.setPurpose}`}>
      <div className="col__barzone">
        <VelocityBar set={set} verdictTone={verdictTone} />
      </div>
      <RepCell set={set} targetLow={targetLow} targetHigh={targetHigh} />
      <div className="col__load">{set.weightLbs === null ? set.loadLabel : loadNumber(set.weightLbs, units)}</div>
      <div className={`col__e1rm num${isBest ? " col__e1rm--best" : ""}`} title={isBest ? "Best estimated 1RM this session" : undefined}>
        {e1rm === null ? "–" : Math.round(loadNumber(e1rm, units))}
      </div>
      <span className="sr-only">{`${setLoadLabel(set, units)} × ${set.repCount}`}</span>
    </li>
  );
}

function VelocityBar({ set, verdictTone }: { set: SessionSet; verdictTone?: Tone }) {
  if (set.velocityLossPct === null) {
    return (
      <div className="bar bar--nodata" title="No velocity telemetry for this set">
        <span>no data</span>
      </div>
    );
  }
  const height = Math.min(set.velocityLossPct, VL_SCALE_MAX) / VL_SCALE_MAX;
  return (
    <div className="bar" style={{ height: `${Math.max(height, 0.04) * 100}%` }}>
      <span className="bar__value num">
        {verdictTone && <ToneGlyph tone={verdictTone} size="0.95em" />}
        {set.velocityLossPct}%
      </span>
    </div>
  );
}

function RepCell({ set, targetLow, targetHigh }: { set: SessionSet; targetLow?: number; targetHigh?: number }) {
  const scorable = set.setPurpose === "working" && set.weightLbs !== null && targetLow !== undefined;
  const short = scorable && set.repCount < (targetLow as number);
  const top = scorable && set.repCount >= (targetHigh as number);
  const title = short ? "Under the target reps" : top ? "Top of the target reps" : undefined;
  return (
    <div className={`col__reps num${short ? " col__reps--short" : ""}`} title={title}>
      {set.repCount}
      {(short || top) && <span className="col__repmark" aria-label={title}>{short ? "▼" : "▲"}</span>}
    </div>
  );
}

/** Page-level key for every strip, so the rows do not repeat it. */
export function StripLegend() {
  return (
    <p className="legend">
      <span><i className="legend__bar" /> velocity loss per set</span>
      <span><i className="legend__bar legend__bar--muted" /> warm-up / technique, not scored</span>
      <span><i className="legend__ring" /> the set the verdict reads</span>
      <span><i className="legend__hatch" /> no telemetry</span>
      <span>▼ under target reps · ▲ top of target</span>
      <span>e1RM: Epley estimate, ● best this session</span>
    </p>
  );
}
