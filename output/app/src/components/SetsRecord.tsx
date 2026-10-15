import type { ReactNode } from 'react';
import type { ExerciseSummary, ExpectedRepRange, SessionSet, Units } from '../types';
import { bestE1rmIndex, epley1rm, formatClock, formatLoad, restBeforeSec } from '../derive';

const PURPOSE_LABEL: Record<SessionSet['setPurpose'], string> = {
  working: 'Working',
  warmup: 'Warm-up',
  probe: 'Probe',
  technique: 'Technique',
};

function RepRange({ reps, range }: { reps: number; range: ExpectedRepRange | null }) {
  if (!range) return <Absent text="no history" />;
  const lo = Math.min(range.expectedLow, reps) - 2;
  const hi = Math.max(range.expectedHigh, reps) + 2;
  const pos = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  const verdict = reps < range.expectedLow ? 'below' : reps > range.expectedHigh ? 'above' : 'within';
  return (
    <span className="range" title={`Usually ${range.expectedLow}–${range.expectedHigh} reps (${range.basis})`}>
      <span className="range-track" aria-hidden>
        <span className="range-band" style={{ left: pos(range.expectedLow), right: `calc(100% - ${pos(range.expectedHigh)})` }} />
        <span className={`range-dot range-dot--${verdict}`} style={{ left: pos(reps) }} />
      </span>
      <span className="range-text num">
        {range.expectedLow}–{range.expectedHigh}
        <span className="sr-only"> usual; this set was {verdict} it</span>
      </span>
    </span>
  );
}

function loadCell(set: SessionSet, units: Units): string {
  if (set.weightLbs !== null) return formatLoad(set.weightLbs, units);
  return set.loadLabel ?? 'no load';
}

function e1rmCell(set: SessionSet, units: Units): string | null {
  if (set.setPurpose !== 'working' || set.weightLbs === null) return null;
  return formatLoad(epley1rm(set.weightLbs, set.repCount), units);
}

function SetRow({ ex, i, units }: { ex: ExerciseSummary; i: number; units: Units }) {
  const set = ex.sets[i];
  const rest = restBeforeSec(ex, i);
  const e1rm = e1rmCell(set, units);
  const isVerdict = set.index === ex.verdictSetIndex;
  const isBest = set.index === bestE1rmIndex(ex) && ex.workingSetCount > 1;
  return (
    <div className={`set-row${set.setPurpose === 'working' ? '' : ' set-row--aux'}`} role="row">
      <Cell col="set">
        #{set.index}
        {isVerdict && <span className="tag tag--verdict">verdict</span>}
      </Cell>
      <Cell col="type" plain>{PURPOSE_LABEL[set.setPurpose]}</Cell>
      <Cell col="load" extra={set.weightLbs === null ? 'is-label' : ''}>{loadCell(set, units)}</Cell>
      <Cell col="reps">{set.repCount}</Cell>
      <Cell col="usual" plain><RepRange reps={set.repCount} range={set.expectedRepRange} /></Cell>
      <Cell col="vl">{set.velocityLossPct === null ? <Absent text="no data" /> : `${set.velocityLossPct}%`}</Cell>
      <Cell col="speed">
        {set.bestRepVelocity === null ? <Absent text="no data" /> : `${set.bestRepVelocity.toFixed(2)} m/s`}
      </Cell>
      <Cell col="e1rm">
        {e1rm ?? <Absent text="—" />}
        {isBest && <span className="tag">best</span>}
      </Cell>
      <Cell col="rest">{rest === null ? <Absent text="—" /> : formatClock(rest)}</Cell>
    </div>
  );
}

const COLUMNS = {
  set: 'Set',
  type: 'Type',
  load: 'Load',
  reps: 'Reps',
  usual: 'Usual reps',
  vl: 'Vel. loss',
  speed: 'Best speed',
  e1rm: 'Est. max',
  rest: 'Rest',
} as const;

type Column = keyof typeof COLUMNS;

function Cell({ col, plain, extra, children }: { col: Column; plain?: boolean; extra?: string; children: ReactNode }) {
  const cls = ['c-' + col, plain ? '' : 'num', extra ?? ''].filter(Boolean).join(' ');
  return (
    <span role="cell" data-label={COLUMNS[col]} className={cls}>
      {children}
    </span>
  );
}

function Absent({ text }: { text: string }) {
  return <span className="absent">{text}</span>;
}

function DriftDetail({ ex }: { ex: ExerciseSummary }) {
  if (!ex.loadDrift) return null;
  const { programmedPct, impliedPct, reason } = ex.loadDrift;
  return (
    <p className="record-drift">
      <strong className="num">Load drift, {programmedPct}% → {impliedPct}% of max:</strong> {reason}
    </p>
  );
}

function volumeText(ex: ExerciseSummary, units: Units): string {
  if (ex.volumeLbs === null) return 'volume not recorded (no load on any set)';
  return `${formatLoad(ex.volumeLbs, units)} volume`;
}

export function SetsRecord({ exercises, units }: { exercises: ExerciseSummary[]; units: Units }) {
  return (
    <section className="record" aria-labelledby="record-title">
      <h2 id="record-title" className="section-title">Every set</h2>
      {exercises.map((ex) => (
        <div key={ex.name} className="record-group" role="table" aria-label={`${ex.name} sets`}>
          <div className="record-head">
            <h3>{ex.name}</h3>
            <span className="meta num">
              {ex.totalReps} reps · {volumeText(ex, units)}
            </span>
          </div>
          <DriftDetail ex={ex} />
          <div className="set-row set-row--header" role="row">
            {(Object.keys(COLUMNS) as Column[]).map((c) => (
              <span key={c} role="columnheader" className={`c-${c}`}>{COLUMNS[c]}</span>
            ))}
          </div>
          {ex.sets.map((s, i) => (
            <SetRow key={s.index} ex={ex} i={i} units={units} />
          ))}
        </div>
      ))}
    </section>
  );
}
