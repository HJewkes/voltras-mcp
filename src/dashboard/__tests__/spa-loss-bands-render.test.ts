// The live hero and the dual wings draw their loss bands from the set's stop (VW-448 seam):
// a strength set's decision lines sit at 13% and 20%, not titan's default 20% and 30%.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Phase, Rep } from '@voltras/workout-analytics';

import { initialAccumulatorState, type Snapshot } from '../spa/adapter.js';
import type { LiveModel as StoreLiveModel } from '../spa/live-stream.js';
import { DivergingLiveStage } from '../spa/live-page/DivergingLiveStage.js';
import { LivePage } from '../spa/live-page/LivePage.js';
import type { DivergingHeroSide } from '../spa/live-page/fatigue-model.js';
import type { LiveDashboardModel } from '../spa/live-page/model.js';
import { mapStoreToFatigueModel } from '../spa/panels/fatigue-view.js';
import { mapStoreToDashboardModel, type LiveViewSources } from '../spa/panels/live-view.js';
import type { TrainingIntent } from '../../schemas/set.js';
import { exerciseFatigueStop } from '../../state/velocity-loss-intent.js';

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

const VELOCITIES = [0.6, 0.58, 0.56, 0.54, 0.516];

function rep(repNumber: number, mps: number): Rep {
  return {
    repNumber,
    concentric: { ...EMPTY, peakVelocity: mps, _totalVelocity: mps, _movementSampleCount: 1 },
    eccentric: { ...EMPTY },
  };
}

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

function sourcesFor(intent: TrainingIntent | undefined): LiveViewSources {
  const active = { reps: VELOCITIES.map((v, i) => rep(i + 1, v)) };
  const snapshot: Snapshot = {
    session: { sessionId: 's1', exerciseName: 'Cable Row' },
    devices: [{ slotId: 'primary', device: { connected: true }, sets: { active } }],
    sets: { active },
    fatigueStop: exerciseFatigueStop(intent),
  };
  return {
    snapshot,
    accumulator: initialAccumulatorState(),
    live: LIVE,
    prescription: { sets: 4, repsLow: 8 },
  };
}

function lineLabels(html: string): string[] {
  return [...html.replace(/<[^>]*>/g, ' ').matchAll(/VL \d+%/g)].map((m) => m[0]);
}

function side(): DivergingHeroSide {
  return {
    repVelocitiesMps: VELOCITIES,
    velocityCurves: [],
    label: null,
    bestVelocityMps: 0.6,
    velocityLossPct: 14,
  } as DivergingHeroSide;
}

describe('loss bands on the live hero (VW-448 seam)', () => {
  it.each<[TrainingIntent | undefined, string[]]>([
    ['strength', ['VL 13%', 'VL 20%']],
    ['hypertrophy', ['VL 20%', 'VL 30%']],
    [undefined, ['VL 20%', 'VL 30%']],
  ])('the single stage draws a %s set at its stop bands', (intent, labels) => {
    const sources = sourcesFor(intent);
    const model = mapStoreToDashboardModel(sources)!;
    const fatigue = mapStoreToFatigueModel(sources);

    const html = renderToStaticMarkup(createElement(LivePage, { model, fatigue }));

    expect(lineLabels(html)).toEqual(labels);
  });

  it('the dual stage draws both wings at the same stop bands', () => {
    const model = mapStoreToDashboardModel(sourcesFor('strength'))! as LiveDashboardModel;
    const hero = {
      left: side(),
      right: side(),
      scaleMaxMps: 0.6,
      targetReps: 8,
      liveRepIndex: 4,
    };

    const html = renderToStaticMarkup(
      createElement(DivergingLiveStage, { model, hero, asymmetry: null }),
    );

    const labels = lineLabels(html);
    expect(labels.length).toBeGreaterThan(0);
    expect(new Set(labels)).toEqual(new Set(['VL 13%', 'VL 20%']));
  });
});
