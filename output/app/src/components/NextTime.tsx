import type { ExerciseSummary, LoadDrift, Progression, Units } from "../types";
import { compareSignals } from "../derive";
import { formatLoad, setLoadLabel } from "../units";
import { Absent } from "./Absent";
import { ServerText } from "./ServerText";

const ACTION: Record<Progression["delta"], { verb: string; arrow: string }> = {
  5: { verb: "Add", arrow: "↑" },
  0: { verb: "Hold", arrow: "=" },
  [-5]: { verb: "Back off", arrow: "↓" },
};

export function NextTime({ exercise, units }: { exercise: ExerciseSummary; units: Units }) {
  const { progression } = exercise;
  if (!progression) {
    return (
      <div className="next next--none">
        <div className="kicker">Next time</div>
        <Absent title="No recommendation" reason={exercise.progressionNote ?? "The server sent no progression."} />
      </div>
    );
  }
  return (
    <div className="next">
      <div className="kicker">Next time · reps vs plan</div>
      <ActionLine progression={progression} units={units} />
      <ServerText className="next__reason" text={progression.reasoning} units={units} />
      <UsualRange exercise={exercise} units={units} />
      <SignalNote exercise={exercise} />
      {exercise.loadDrift && <DriftNote drift={exercise.loadDrift} units={units} />}
    </div>
  );
}

function ActionLine({ progression, units }: { progression: Progression; units: Units }) {
  const { verb, arrow } = ACTION[progression.delta];
  const step = progression.delta === 0 ? "" : ` ${Math.abs(progression.delta)} lb`;
  return (
    <div className="next__action">
      <span className="next__arrow" aria-hidden>{arrow}</span>
      <div className="next__load num">{formatLoad(progression.targetWeightLbs, units)}</div>
      <div className="next__how">
        <div className="next__verb">
          {verb}
          {step && (units === "kg" ? <span className="next__step"> one{step} step</span> : step)}
        </div>
        <div className="next__scheme num">
          {progression.targetSets} sets × {progression.targetRepsLow}–{progression.targetRepsHigh} reps
        </div>
      </div>
    </div>
  );
}

function SignalNote({ exercise }: { exercise: ExerciseSummary }) {
  const comparison = compareSignals(exercise);
  if (!comparison || comparison.kind === "agree") return null;
  return (
    <div className="signal">
      <span className="signal__mark" aria-hidden>≠</span>
      <div>
        <b>{comparison.headline}.</b> {comparison.detail}
      </div>
    </div>
  );
}

function DriftNote({ drift, units }: { drift: LoadDrift; units: Units }) {
  const easier = drift.deltaPct < 0;
  return (
    <div className="drift">
      <span className="drift__mark" aria-hidden>{easier ? "◁" : "▷"}</span>
      <div>
        <b>
          Load {easier ? "got easier" : "got harder"}: {drift.impliedPct}% of max, planned {drift.programmedPct}%.
        </b>
        <ServerText className="drift__reason" text={drift.reason} units={units} />
      </div>
    </div>
  );
}

/** The lifter's own history at this load: always a range, never a point. */
function UsualRange({ exercise, units }: { exercise: ExerciseSummary; units: Units }) {
  const sets = exercise.sets.filter((s) => s.expectedRepRange);
  if (sets.length === 0) return null;
  const r = sets[0].expectedRepRange!;
  const inside = sets.filter((s) => s.repCount >= r.expectedLow && s.repCount <= r.expectedHigh).length;
  return (
    <span className="next__usual" title={r.basis}>
      Your usual at {setLoadLabel(sets[0], units)} is {r.expectedLow}–{r.expectedHigh} reps (from {r.n} past sets);{" "}
      {inside} of {sets.length} sets landed inside.
    </span>
  );
}
