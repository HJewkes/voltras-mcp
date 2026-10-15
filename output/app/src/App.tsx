import { useMemo, useState } from 'react';
import { fixtures, type FixtureKey } from './fixtures';
import type { SessionSummary, Units } from './types';
import { SessionHeader } from './components/SessionHeader';
import { ExerciseRow } from './components/ExerciseRow';
import { SetsRecord } from './components/SetsRecord';
import { NavIcon } from './components/Icons';

const NAV = ['Live', 'Review', 'Plan', 'Goals', 'Check-in', 'Body'];

function Nav() {
  return (
    <nav className="nav" aria-label="Pages">
      <div className="nav-inner">
        {NAV.map((name) => (
          <a key={name} href="#" className={name === 'Review' ? 'active' : ''} aria-current={name === 'Review' ? 'page' : undefined}>
            <NavIcon name={name} />
            <span>{name}</span>
          </a>
        ))}
      </div>
    </nav>
  );
}

// One shared y-scale for every exercise so fatigue reads across rows.
function vlScaleMax(summary: SessionSummary): number {
  const all = summary.exercises.flatMap((e) => e.sets.map((s) => s.velocityLossPct ?? 0));
  return Math.max(40, Math.ceil(Math.max(...all, 0) / 10) * 10);
}

function readParams() {
  const q = new URLSearchParams(window.location.search);
  const fixture = (q.get('fixture') ?? 'full') as FixtureKey;
  return {
    fixture: fixture in fixtures ? fixture : 'full',
    units: (q.get('units') === 'kg' ? 'kg' : 'lb') as Units,
    theme: q.get('theme') === 'light' ? 'light' : 'dark',
    shot: q.has('shot'),
  };
}

function FixturePicker({ current }: { current: FixtureKey }) {
  return (
    <div className="fixture-picker" aria-label="Mock fixture">
      {(Object.keys(fixtures) as FixtureKey[]).map((k) => (
        <a key={k} href={`?fixture=${k}`} className={k === current ? 'on' : ''}>
          {fixtures[k].label}
        </a>
      ))}
    </div>
  );
}

export function App() {
  const params = useMemo(readParams, []);
  const [units, setUnits] = useState<Units>(params.units);
  const summary = useMemo(() => fixtures[params.fixture as FixtureKey].build(), [params.fixture]);
  const scaleMax = vlScaleMax(summary);
  document.documentElement.dataset.theme = params.theme;
  return (
    <div className="shell">
      <Nav />
      <main className="page">
        <SessionHeader summary={summary} units={units} onUnits={setUnits} />
        <section className="board" aria-label="How each exercise went">
          {summary.exercises.map((ex) => (
            <ExerciseRow key={ex.name} exercise={ex} units={units} scaleMax={scaleMax} />
          ))}
        </section>
        <SetsRecord exercises={summary.exercises} units={units} />
      </main>
      {!params.shot && <FixturePicker current={params.fixture as FixtureKey} />}
    </div>
  );
}
