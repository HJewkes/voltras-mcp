// One fatigue rule for every live surface (VW-440): the live stage and the rest
// recap judge a set by `setFatigueState` against the server's intent-keyed stop.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FatigueVerdict, Phase, Rep } from '@voltras/workout-analytics';

import {
  initialAccumulatorState,
  type CompletedSet as StoreCompletedSet,
  type Snapshot,
  type SnapshotWatchTrigger,
} from '../spa/adapter.js';
import type { LiveModel as StoreLiveModel } from '../spa/live-stream.js';
import { RestView } from '../spa/live-page/RestView.js';
import { setFatigueState, type FatigueState } from '../spa/live-page/fatigue-state.js';
import { mapStoreToDashboardModel } from '../spa/panels/live-view.js';
import type { TrainingIntent } from '../../schemas/set.js';
import { exerciseFatigueStop } from '../../state/velocity-loss-intent.js';

const EMPTY_PHASE: Phase = {
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

/** A rep whose mean concentric velocity is `mps`. */
function rep(repNumber: number, mps: number): Rep {
  return {
    repNumber,
    concentric: { ...EMPTY_PHASE, peakVelocity: mps, _totalVelocity: mps, _movementSampleCount: 1 },
    eccentric: { ...EMPTY_PHASE },
  };
}

/** Two reps losing `lossPct` from the first to the second. */
function repsLosing(lossPct: number): Rep[] {
  return [rep(1, 1), rep(2, 1 - lossPct / 100)];
}

function closedSet(reps: Rep[], watch?: { notifyOn: SnapshotWatchTrigger[] }): StoreCompletedSet {
  return {
    weightLbs: 100,
    mode: 'weight',
    repCount: reps.length,
    exerciseName: 'Cable Row',
    bestPeakVelocityMps: null,
    peakForceLbs: null,
    reps,
    setPurpose: 'working',
    ...(watch ? { watch } : {}),
  };
}

const LIVE: StoreLiveModel = {
  connected: true,
  phase: 'con',
  phaseElapsedMs: 0,
  velocity: 0.5,
  position: 0,
  force: 0,
  repInProgress: 2,
  lastRep: null,
  peakForce: 0,
};

function modelFor(
  intent: TrainingIntent | undefined,
  set: StoreCompletedSet,
  activeWatch?: { notifyOn: SnapshotWatchTrigger[] },
) {
  const snapshot: Snapshot = {
    session: { sessionId: 's1', exerciseName: 'Cable Row' },
    devices: [],
    sets: { active: { reps: [], ...(activeWatch ? { watch: activeWatch } : {}) } },
    fatigueStop: exerciseFatigueStop(intent),
  };
  const accumulator = { ...initialAccumulatorState(), setLog: [set] };
  return mapStoreToDashboardModel({ snapshot, accumulator, live: LIVE, prescription: null })!;
}

/** The recap's Fatigue tile, the rest surface's rendering of the state. */
function recapFatigueTile(intent: TrainingIntent | undefined, lossPct: number): string {
  const model = { ...modelFor(intent, closedSet(repsLosing(lossPct))), live: null };
  const html = renderToStaticMarkup(createElement(RestView, { model }));
  const tile = /(LOW|MOD|HIGH)[^A-Z]*Fatigue/.exec(html.replace(/<[^>]*>/g, ' '));
  return tile?.[1] ?? 'none';
}

const TILE: Record<FatigueState, string> = { productive: 'LOW', threshold: 'MOD', stop: 'HIGH' };

describe('setFatigueState across surfaces (VW-440)', () => {
  it.each<[TrainingIntent | undefined, number, FatigueState]>([
    ['strength', 15, 'productive'],
    ['strength', 22, 'stop'],
    ['strength', 32, 'stop'],
    ['hypertrophy', 15, 'productive'],
    ['hypertrophy', 22, 'threshold'],
    ['hypertrophy', 32, 'stop'],
    ['power', 15, 'stop'],
    ['power', 22, 'stop'],
    ['power', 32, 'stop'],
    [undefined, 15, 'productive'],
    [undefined, 22, 'threshold'],
    [undefined, 32, 'stop'],
  ])('a %s set at %i%% loss reads %s live and in the recap', (intent, lossPct, expected) => {
    const model = modelFor(intent, closedSet(repsLosing(lossPct)));
    const recapSet = model.session.completedSets[0];

    const live = setFatigueState({ lossPct, stop: model.live!.fatigueStop });
    const recap = setFatigueState({
      lossPct,
      stop: recapSet.fatigueStop,
      verdict: recapSet.fatigueVerdict,
    });

    expect(live).toBe(expected);
    expect(recap).toBe(expected);
    expect(recapFatigueTile(intent, lossPct)).toBe(TILE[expected]);
  });

  it('names the default when the exercise carries no intent', () => {
    const model = modelFor(undefined, closedSet(repsLosing(15)));

    expect(model.live!.fatigueStop).toMatchObject({ pct: 30, intent: null, source: 'default' });
  });

  it('judges a set by its own watch threshold, the number the server fires at', () => {
    const watch = {
      notifyOn: [{ type: 'velocity_loss_exceeded', pct: 25, thresholdSource: 'explicit' as const }],
    };
    const model = modelFor('hypertrophy', closedSet(repsLosing(26), watch), watch);

    expect(setFatigueState({ lossPct: 26, stop: model.live!.fatigueStop })).toBe('stop');
    expect(setFatigueState({ lossPct: 26, stop: model.session.completedSets[0].fatigueStop })).toBe(
      'stop',
    );
  });

  it("stops a set on WA's form breakdown even under the velocity threshold", () => {
    const breakdown: FatigueVerdict = {
      state: 'form-breakdown',
      tone: 'alarm',
      dimensions: { velocityLoss: 'ok', rom: 'alarm', tempo: 'ok' },
    };

    expect(
      setFatigueState({ lossPct: 5, stop: exerciseFatigueStop('hypertrophy'), verdict: breakdown }),
    ).toBe('stop');
  });

  it('reads a warn tone from ROM or tempo as approaching, not stop', () => {
    const slowing: FatigueVerdict = {
      state: 'slowing',
      tone: 'warn',
      dimensions: { velocityLoss: 'ok', rom: 'ok', tempo: 'warn' },
    };

    expect(
      setFatigueState({ lossPct: 5, stop: exerciseFatigueStop('hypertrophy'), verdict: slowing }),
    ).toBe('threshold');
  });
});
