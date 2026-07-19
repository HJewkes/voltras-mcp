/**
 * JS-timer live-set simulation for the R2 harness.
 *
 * Same choreography as the HTML gallery: CON → HOLD → ECC phase machine at the
 * fixture's real tempo, a rep commits at the eccentric boundary, ~8 reps then
 * an auto rest transition (count-up), then the set loops. The sim runs at the
 * App level so the rail set-ticks and the pinned live strip keep updating when
 * the user drills away from Live.
 *
 * Phase timings are real-world (900/300/1500 ms), so TempoBar's pacing ✓/✗
 * marks are honest; a per-rep eccentric drift (fatigue) makes later reps trip
 * the "behind target" ✗ state.
 */
import { useEffect, useRef, useState } from 'react';
import { LIVE, SESSION } from './fixture';

export type SimPhase = 'concentric' | 'hold' | 'eccentric' | null;
export type SimMode = 'running' | 'rest' | 'idle';

export interface SimState {
  mode: SimMode;
  /** Velocities committed so far in the live set (mean concentric, m/s). */
  reps: number[];
  phase: SimPhase;
  phaseElapsedMs: number;
  /** Completed phase durations (ms) for the CURRENT rep — cleared at rep boundary. */
  completed: Partial<Record<'concentric' | 'hold' | 'eccentric', number>>;
  restElapsedMs: number;
}

const INITIAL: SimState = {
  mode: 'running',
  reps: [],
  phase: null,
  phaseElapsedMs: 0,
  completed: {},
  restElapsedMs: 0,
};

const TICK_MS = 60;
const BETWEEN_REPS_MS = 700;

/** Eccentric slows as fatigue accumulates → later reps earn a pacing ✗. */
function eccDriftMs(baseMs: number, repIdx: number): number {
  return Math.round(baseMs * (1 + repIdx * 0.06));
}

export function useLiveSim(enabled: boolean): SimState {
  const [state, setState] = useState<SimState>(INITIAL);
  const machine = useRef({
    phaseIdx: 0,
    accMs: 0,
    repIdx: 0,
    seq: ['concentric', 'hold', 'eccentric', 'between'] as const,
  });

  useEffect(() => {
    if (!enabled) {
      setState((s) => (s.mode === 'idle' ? s : { ...INITIAL, mode: 'idle', reps: s.reps }));
      return;
    }
    machine.current = { phaseIdx: 0, accMs: 0, repIdx: 0, seq: machine.current.seq };
    setState({ ...INITIAL, mode: 'running' });
    const ex = SESSION[LIVE.exerciseIndex];
    const id = setInterval(() => {
      setState((prev) => {
        const m = machine.current;
        if (prev.mode === 'rest') {
          const restElapsedMs = prev.restElapsedMs + TICK_MS;
          if (restElapsedMs >= LIVE.restSeconds * 1000) {
            m.phaseIdx = 0;
            m.accMs = 0;
            m.repIdx = 0;
            return { ...INITIAL, mode: 'running' };
          }
          return { ...prev, restElapsedMs };
        }
        // running
        const durations = {
          concentric: ex.tempoMs.con,
          hold: ex.tempoMs.hold,
          eccentric: eccDriftMs(ex.tempoMs.ecc, m.repIdx),
          between: BETWEEN_REPS_MS,
        };
        const phaseName = m.seq[m.phaseIdx];
        m.accMs += TICK_MS;
        if (m.accMs >= durations[phaseName]) {
          // phase complete
          const next = { ...prev };
          if (phaseName !== 'between') {
            next.completed = { ...prev.completed, [phaseName]: durations[phaseName] };
          }
          m.accMs = 0;
          m.phaseIdx += 1;
          if (m.phaseIdx >= m.seq.length) {
            // rep boundary: commit velocity, IMMEDIATE tempo reset (no drain-out)
            m.phaseIdx = 0;
            const v = LIVE.stream[m.repIdx];
            m.repIdx += 1;
            const reps = v == null ? prev.reps : [...prev.reps, v];
            if (m.repIdx >= LIVE.targetReps) {
              return { ...INITIAL, mode: 'rest', reps };
            }
            return { ...next, reps, phase: null, phaseElapsedMs: 0, completed: {} };
          }
          const nextName = m.seq[m.phaseIdx];
          return {
            ...next,
            phase: nextName === 'between' ? null : nextName,
            phaseElapsedMs: 0,
          };
        }
        const cur = phaseName === 'between' ? null : phaseName;
        // commit the rep VISUALLY at the eccentric->between edge only; while a
        // phase runs just advance the clock.
        return { ...prev, phase: cur, phaseElapsedMs: m.accMs };
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [enabled]);

  return state;
}
