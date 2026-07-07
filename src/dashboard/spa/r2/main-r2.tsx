/**
 * R2 React harness entry (VMCP R2 — converged drill-down shell).
 *
 * Renders the R2 synthesis navigation contract with REAL titan components +
 * fixture data + a JS-timer live sim. No server, no API — this is a design
 * harness for judging real component fidelity (see the legend toggle).
 *
 * Shell: C's header · CategoricalNav (Live/Review/Program/Body, no Idle tab)
 * · persistent SessionRail (context-swaps live↔historical) · main viewport ·
 * PinnedLiveStrip whenever the sim set runs and the user is off Live.
 */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@titan-design/react-ui/theme/global.css';
import './r2.css';

import { F, FidelityProvider, LegendBar } from './fidelity';
import { CategoricalNav, type NavKey } from './nav';
import { SessionRail } from './rail';
import { PinnedLiveStrip } from './strip';
import { useLiveSim } from './sim';
import { LiveView, RestView } from './views-live';
import { ReviewView } from './views-review';
import { BodyStub, IdleView, ProgramStub } from './views-stubs';
import { LIVE, SESSION } from './fixture';

function Header(): React.JSX.Element {
  return (
    <header className="r2-topbar">
      <span className="r2-brand">
        <span className="r2-brand-mark">◇</span> VOLTRAS{' '}
        <span className="r2-brand-dim">/ wall dashboard</span>
      </span>
      <span className="r2-topstatus">
        <span className="r2-pulse" aria-hidden="true" />
        R2 REACT HARNESS · fixture data · JS-timer sim
      </span>
    </header>
  );
}

function restLabel(elapsedMs: number): string {
  const left = Math.max(0, LIVE.restSeconds - Math.floor(elapsedMs / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

function App(): React.JSX.Element {
  const [nav, setNav] = useState<NavKey>('live');
  const [idle, setIdle] = useState(false);
  const [reviewExId, setReviewExId] = useState('cable-row');
  const sim = useLiveSim(!idle);
  const ex = SESSION[LIVE.exerciseIndex];
  const setRunning = sim.mode !== 'idle';
  const showStrip = setRunning && nav !== 'live';

  const main =
    nav === 'live' ? (
      idle ? (
        <IdleView />
      ) : sim.mode === 'rest' ? (
        <RestView sim={sim} />
      ) : (
        <LiveView sim={sim} />
      )
    ) : nav === 'review' ? (
      <ReviewView exerciseId={reviewExId} />
    ) : nav === 'program' ? (
      <ProgramStub />
    ) : (
      <BodyStub />
    );

  return (
    <div className="r2-device">
      <Header />
      <div className="r2-body">
        <F kind="new" name="CategoricalNav">
          <CategoricalNav active={nav} onSelect={setNav} />
        </F>
        <F kind="new" name="SessionRail (context-swapping)">
          <SessionRail
            context={nav === 'review' ? 'review' : 'live'}
            sim={sim}
            onDrillExercise={(id) => {
              setReviewExId(id);
              setNav('review');
            }}
          />
        </F>
        <main className="r2-stage">
          {showStrip && (
            <F kind="new" name="PinnedLiveStrip">
              <PinnedLiveStrip
                reps={sim.reps}
                targetReps={LIVE.targetReps}
                exerciseName={ex.name}
                setLabel={`set ${LIVE.setIndex + 1}`}
                resting={sim.mode === 'rest'}
                restLabel={restLabel(sim.restElapsedMs)}
                onReturn={() => setNav('live')}
              />
            </F>
          )}
          <div className="r2-stagebody">{main}</div>
        </main>
      </div>
      <div className="r2-harnessbar">
        <button type="button" className="r2-harness-btn" onClick={() => setIdle((v) => !v)}>
          {idle ? 'demo: start session' : 'demo: idle wall'}
        </button>
        <LegendBar />
      </div>
    </div>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <FidelityProvider>
      <App />
    </FidelityProvider>,
  );
}
