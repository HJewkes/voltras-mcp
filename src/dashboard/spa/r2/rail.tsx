/**
 * SessionRail — NET-NEW shell component (Phase-2 seed).
 *
 * The persistent, context-swapping session pane (A's role, B's contents):
 * expandable workout items composing the REAL titan ExerciseCard (which owns
 * the real SetRow table — `previous` + `targets` restored per the component
 * audit — and the real mini velocity strips), SupersetWrapper for the fixture
 * superset pair, and PlaceholderStrip for the pending set slot. Context =
 * live session on Live/rest, the SAME session as historical under Review.
 *
 * The live exercise's card receives the sim's in-flight velocities, so the
 * rail reflects the running set even when the user has drilled away.
 */
import React, { useState } from 'react';
import {
  ExerciseCard,
  PlaceholderStrip,
  SupersetWrapper,
  type SetRowProps,
} from '@titan-design/react-ui';
import { LIVE, SESSION, type FixtureExercise } from './fixture';
import type { SimState } from './sim';
import { F } from './fidelity';
import { SessionPaceTile } from './pace';

export type RailContext = 'live' | 'review';

function toSetRows(ex: FixtureExercise, liveReps: number[] | null): SetRowProps[] {
  return ex.sets.map((s, i) => {
    const isLive = liveReps != null && s.live === true;
    return {
      mode: isLive ? 'active' : 'completed',
      setNumber: i + 1,
      previous: s.previous,
      reps: isLive ? liveReps.length : s.reps,
      weight: ex.weight,
      rpe: isLive ? null : s.rpe,
      unit: 'lbs' as const,
      velocities: isLive ? liveReps : s.velocities,
      targets: { reps: s.reps, weight: ex.weight },
      isNextSet: false,
    };
  });
}

function railVelocities(ex: FixtureExercise, liveReps: number[] | null): number[][] {
  return ex.sets.map((s) => (liveReps != null && s.live === true ? liveReps : s.velocities));
}

function RailItem({
  ex,
  liveReps,
  context,
  open,
  onToggle,
  onDrill,
}: {
  ex: FixtureExercise;
  liveReps: number[] | null;
  context: RailContext;
  open: boolean;
  onToggle: () => void;
  onDrill?: () => void;
}): React.JSX.Element {
  const isLiveEx = liveReps != null;
  return (
    <div className={`r2-rail-item${isLiveEx ? ' live' : ''}`}>
      <F kind="real" name="titan:ExerciseCard (+SetRow w/ previous+targets)">
        <ExerciseCard
          name={ex.name}
          state={open ? 'expanded' : 'collapsed'}
          onToggle={onToggle}
          onNavigateDetail={onDrill}
          summary={{ sets: ex.sets.length, reps: ex.sets[0].reps, weight: ex.weight, unit: 'lbs' }}
          e1rm={{ value: ex.e1rm, unit: 'lbs' }}
          isPR={ex.pr === true}
          setVelocities={railVelocities(ex, liveReps)}
          totalPlannedSets={ex.sets.length}
          sets={toSetRows(ex, liveReps)}
          tempo={[ex.tempoMs.ecc / 1000, ex.tempoMs.hold / 1000, ex.tempoMs.con / 1000, 0]}
          prescription={`${ex.sets.length}×${ex.sets[0].reps} @ ${ex.weight} lbs`}
        />
      </F>
      {isLiveEx && open && (
        <div className="r2-rail-pending">
          <F kind="real" name="titan:PlaceholderStrip" block={false}>
            <PlaceholderStrip
              mode="segmented"
              segments={LIVE.targetReps - (liveReps?.length ?? 0)}
            />
          </F>
          <span className="r2-rail-pending-label">
            set {LIVE.setIndex + 1} live · {liveReps?.length ?? 0}/{LIVE.targetReps} reps
          </span>
        </div>
      )}
      {context === 'review' && (
        <button type="button" className="r2-rail-drill" onClick={onDrill}>
          drill in main view ▸
        </button>
      )}
    </div>
  );
}

export function SessionRail({
  context,
  sim,
  onDrillExercise,
}: {
  context: RailContext;
  sim: SimState;
  onDrillExercise: (exerciseId: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({ 'cable-row': true });
  const liveActive = sim.mode !== 'idle';
  const items: React.JSX.Element[] = [];
  let i = 0;
  while (i < SESSION.length) {
    const ex = SESSION[i];
    const next = SESSION[i + 1];
    const item = (exx: FixtureExercise): React.JSX.Element => (
      <RailItem
        key={exx.id}
        ex={exx}
        liveReps={liveActive && exx.id === LIVE.exerciseId ? sim.reps : null}
        context={context}
        open={open[exx.id] === true}
        onToggle={() => setOpen((o) => ({ ...o, [exx.id]: o[exx.id] !== true }))}
        onDrill={() => onDrillExercise(exx.id)}
      />
    );
    if (ex.superset === 'A' && next?.superset === 'A') {
      items.push(
        <F key="ss" kind="real" name="titan:SupersetWrapper">
          <SupersetWrapper label="Superset A">
            {item(ex)}
            {item(next)}
          </SupersetWrapper>
        </F>,
      );
      i += 2;
    } else {
      items.push(item(ex));
      i += 1;
    }
  }
  return (
    <aside className="r2-rail" aria-label="Session rail">
      <div className={`r2-rail-head${context === 'review' ? ' hist' : ''}`}>
        <span className="r2-rail-ctx">
          <span className="r2-rail-dot" aria-hidden="true" />
          {context === 'review' ? 'Reviewing · session Mar 11' : 'Live session'}
        </span>
        <span className="r2-rail-title">Pull A · Intensification</span>
        <span className="r2-rail-meta">
          {context === 'review' ? '22 sets · 48 min · complete' : `set ${LIVE.setIndex + 1} live`}
        </span>
      </div>
      <div className="r2-rail-scroll">{items}</div>
      <F kind="new" name="SessionPaceTile" note="mock derivation — no WA support yet">
        <SessionPaceTile />
      </F>
    </aside>
  );
}
