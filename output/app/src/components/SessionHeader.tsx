import type { SessionSummary, Units } from '../types';
import { formatLoad, sessionDuration, sessionTitle, sessionTotals } from '../derive';
import { LockIcon, ToneIcon } from './Icons';

interface Props {
  summary: SessionSummary;
  units: Units;
  onUnits: (u: Units) => void;
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="stat">
      <dt className="label">{label}</dt>
      <dd className="stat-value num">{value}</dd>
      {note && <dd className="stat-note">{note}</dd>}
    </div>
  );
}

function DurationStat({ summary }: { summary: SessionSummary }) {
  const d = sessionDuration(summary);
  if (!d) return <Stat label="Duration" value="—" note="no sets recorded" />;
  if (!d.isLowerBound) return <Stat label="Duration" value={`${d.minutes} min`} />;
  return (
    <div className="stat stat--flag">
      <dt className="label">Duration</dt>
      <dd className="stat-value num">≥ {d.minutes} min</dd>
      <dd className="stat-note tone-warn">
        <ToneIcon tone="warn" size={14} /> no end time; to last set
      </dd>
    </div>
  );
}

function UnitToggle({ units, onUnits }: Pick<Props, 'units' | 'onUnits'>) {
  return (
    <div className="seg" role="radiogroup" aria-label="Units">
      {(['lb', 'kg'] as const).map((u) => (
        <button key={u} role="radio" aria-checked={units === u} className={units === u ? 'on' : ''} onClick={() => onUnits(u)}>
          {u}
        </button>
      ))}
    </div>
  );
}

export function SessionHeader({ summary, units, onUnits }: Props) {
  const { day, time } = sessionTitle(summary);
  const totals = sessionTotals(summary);
  const unloaded = totals.unloadedSets > 0 ? `+ ${totals.unloadedSets} sets with no load` : undefined;
  return (
    <header className="session-head">
      <div className="title-row">
        <div>
          <p className="eyebrow">Session review · {time}</p>
          <h1>{day}</h1>
        </div>
        <UnitToggle units={units} onUnits={onUnits} />
      </div>
      <dl className="stats">
        <DurationStat summary={summary} />
        <Stat label="Exercises" value={String(summary.exercises.length)} />
        <Stat
          label="Working sets"
          value={String(totals.workingSets)}
          note={totals.warmupSets ? `+ ${totals.warmupSets} warm-up/other` : undefined}
        />
        <Stat
          label="Volume"
          value={totals.volumeLbs === null ? 'not recorded' : formatLoad(totals.volumeLbs, units)}
          note={unloaded}
        />
        <div className="stat stat--withheld">
          <dt className="label">Reps in reserve</dt>
          <dd className="stat-value withheld">
            <LockIcon size={20} /> Calibrating
          </dd>
          <dd className="stat-note">held back until fitted to you</dd>
        </div>
      </dl>
    </header>
  );
}
