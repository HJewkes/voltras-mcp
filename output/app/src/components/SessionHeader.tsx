import type { SessionSummary, Units } from "../types";
import { formatDay, formatTime, sessionTotals } from "../derive";
import { formatVolume } from "../units";

interface HeaderProps {
  summary: SessionSummary;
  units: Units;
  onUnits: (units: Units) => void;
}

export function SessionHeader({ summary, units, onUnits }: HeaderProps) {
  const totals = sessionTotals(summary);
  const { session } = summary;
  return (
    <header className="session">
      <div className="session__when">
        <div className="kicker">{session.endedAt ? "Session complete" : "Session still open"}</div>
        <h1 className="session__date">
          {formatDay(session.startedAt)} · {formatTime(session.startedAt)}–
          {session.endedAt ? formatTime(session.endedAt) : <span className="open-end">open</span>}
          {totals.minutes !== null && <span className="session__mins"> · {totals.minutes} min</span>}
        </h1>
      </div>
      <dl className="session__totals num">
        <Total label="Exercises" value={summary.exercises.length} />
        <Total label="Sets" value={`${totals.workingSetCount}`} sub={`working of ${totals.setCount}`} />
        <Total label="Reps" value={totals.totalReps} />
        <VolumeTotal volumeLbs={totals.volumeLbs} unloaded={totals.unloadedExercises} units={units} />
      </dl>
      <div className="session__side">
        <EffortWithheld />
        <UnitToggle units={units} onUnits={onUnits} />
      </div>
      {!session.endedAt && <OpenBanner lastSetEndedAt={totals.lastSetEndedAt} setCount={totals.setCount} />}
    </header>
  );
}

function Total({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="total">
      <dt>{label}</dt>
      <dd>
        {value}
        {sub && <span className="total__sub"> {sub}</span>}
      </dd>
    </div>
  );
}

function VolumeTotal({ volumeLbs, unloaded, units }: { volumeLbs: number | null; unloaded: string[]; units: Units }) {
  return (
    <div className="total">
      <dt>Volume</dt>
      <dd>
        {volumeLbs === null ? <span className="gap">not recorded</span> : formatVolume(volumeLbs, units)}
        {volumeLbs !== null && unloaded.length > 0 && (
          <span className="total__sub"> excl. {unloaded.join(", ")} (no load)</span>
        )}
      </dd>
    </div>
  );
}

/** RIR is withheld until the lifter's own curve is trusted: say so once, page-wide. */
function EffortWithheld() {
  return (
    <div className="withheld" title="Reps in reserve is shown once the system has fitted a trusted curve to your own sets.">
      <span className="withheld__label">RIR</span>
      <span className="withheld__text">withheld · still learning your sets</span>
    </div>
  );
}

function UnitToggle({ units, onUnits }: { units: Units; onUnits: (units: Units) => void }) {
  return (
    <div className="units" role="group" aria-label="Units">
      {(["lb", "kg"] as const).map((u) => (
        <button key={u} type="button" aria-pressed={units === u} onClick={() => onUnits(u)}>
          {u}
        </button>
      ))}
    </div>
  );
}

function OpenBanner({ lastSetEndedAt, setCount }: { lastSetEndedAt: string | null; setCount: number }) {
  return (
    <p className="open-banner">
      <b>No end time recorded.</b> These figures cover the {setCount} sets logged so far
      {lastSetEndedAt && <> (last set ended {formatTime(lastSetEndedAt)})</>}. They can change once the session closes.
    </p>
  );
}
