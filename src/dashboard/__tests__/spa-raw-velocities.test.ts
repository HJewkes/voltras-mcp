// The SPA hands titan unrounded per-rep velocities (titan 0.21.1 bands each bar on
// the exact loss and formats the number itself), so a bar and the aura agree at a
// band edge, and the rest recap's loss is the live aura's own exact loss.

import { describe, expect, it } from 'vitest';
import { getSetVelocityLossPct, type Phase, type Rep } from '@voltras/workout-analytics';

import {
  initialAccumulatorState,
  type CompletedSet as StoreCompletedSet,
  type Snapshot,
} from '../spa/adapter.js';
import type { LiveModel as StoreLiveModel } from '../spa/live-stream.js';
import { velocityLossPct } from '../spa/live-page/model.js';
import { mapStoreToDivergingHeroModel } from '../spa/panels/fatigue-view.js';
import { mapStoreToDashboardModel, type LiveViewSources } from '../spa/panels/live-view.js';

const EMPTY: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 0,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  _peakVelocityTime: 0,
  _lastMovementVelocity: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

/** A strength set whose last rep sits 14% below the best: 13.3 when rounded to 0.52. */
const VELOCITIES = [0.6, 0.58, 0.56, 0.54, 0.516];

function rep(repNumber: number, mps: number): Rep {
  return {
    repNumber,
    concentric: { ...EMPTY, peakVelocity: mps, _totalVelocity: mps, _movementSampleCount: 1 },
    eccentric: { ...EMPTY },
  };
}

const REPS = VELOCITIES.map((v, i) => rep(i + 1, v));

const LIVE: StoreLiveModel = {
  connected: true,
  phase: 'con',
  phaseElapsedMs: 0,
  velocity: 0.5,
  position: 0,
  force: 0,
  repInProgress: 6,
  lastRep: null,
  peakForce: 0,
};

function sources(snapshot: Snapshot, setLog: StoreCompletedSet[] = []): LiveViewSources {
  return {
    snapshot,
    accumulator: { ...initialAccumulatorState(), setLog },
    live: LIVE,
    prescription: null,
  };
}

describe('unrounded velocities to titan (titan 0.21.1)', () => {
  it('gives the live hero and the strip the exact per-rep velocities', () => {
    const active = { reps: REPS };
    const model = mapStoreToDashboardModel(
      sources({ session: { sessionId: 's1' }, devices: [], sets: { active } }),
    )!;

    expect(model.live!.repVelocities).toEqual(VELOCITIES);
  });

  it("gives a closed set's recap bars the exact velocities, so its loss is the aura's", () => {
    const closed: StoreCompletedSet = {
      weightLbs: 100,
      mode: 'weight',
      repCount: REPS.length,
      exerciseName: 'Cable Row',
      bestPeakVelocityMps: null,
      peakForceLbs: null,
      reps: REPS,
      setPurpose: 'working',
    };
    const model = mapStoreToDashboardModel(
      sources({ session: { sessionId: 's1' }, devices: [], sets: { active: null } }, [closed]),
    )!;
    const recap = model.session.completedSets[0]!;

    expect(recap.reps).toEqual(VELOCITIES);
    expect(velocityLossPct(recap.reps)).toBeCloseTo(getSetVelocityLossPct({ reps: REPS }), 10);
  });

  it('gives both dual wings the exact velocities', () => {
    const active = { reps: REPS };
    const hero = mapStoreToDivergingHeroModel(
      sources({
        session: { sessionId: 's1' },
        devices: [
          { slotId: 'left', device: { connected: true }, sets: { active } },
          { slotId: 'right', device: { connected: true }, sets: { active } },
        ],
        sets: { active },
      }),
    );

    expect(hero.left?.repVelocitiesMps).toEqual(VELOCITIES);
    expect(hero.right?.repVelocitiesMps).toEqual(VELOCITIES);
  });
});
