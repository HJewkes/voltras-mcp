// The rest stage counts DOWN from the resolved rest in every case, and marks a
// derived length so it never reads as the coach's (VW-441).

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RestView } from '../spa/live-page/RestView.js';
import { restBasisCaption } from '../spa/live-page/live-copy.js';
import type { CompletedSet, RestBasisModel, SessionModel } from '../spa/live-page/model.js';
import { exerciseFatigueStop } from '../../state/velocity-loss-intent.js';

const SET: CompletedSet = {
  fatigueStop: exerciseFatigueStop(undefined),
  fatigueVerdict: null,
  exerciseName: 'Cable Row',
  weightLbs: 100,
  mode: 'weight',
  repCount: 8,
  reps: [0.6, 0.55],
  peakForceLbs: null,
  setPurpose: 'working',
};

function session(restSec: number | null, restBasis: RestBasisModel | null): SessionModel {
  return {
    hasSession: true,
    exerciseName: 'Cable Row',
    title: null,
    lifter: null,
    weightLbs: 100,
    unit: 'lbs',
    completedSets: [SET],
    plannedExercises: [],
    restSec,
    restBasis,
    plannedSets: null,
    targetReps: null,
    expectedSetupCard: null,
    sessionPace: null,
  };
}

function renderRest(restSec: number | null, restBasis: RestBasisModel | null): string {
  const model = { live: null, session: session(restSec, restBasis), restElapsedMs: 30_000 };
  return renderToStaticMarkup(createElement(RestView, { model }));
}

function text(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
}

describe('rest countdown (VW-441)', () => {
  it('counts down a coach-set rest with no marking', () => {
    const html = renderRest(90, { source: 'explicit_plan', intent: null, extensionSeconds: 0 });

    expect(text(html)).toContain('1:00');
    expect(html).not.toContain('rest-basis-caption');
  });

  it('counts down the goal default and marks it as a default', () => {
    const html = renderRest(105, {
      source: 'intent_default',
      intent: 'hypertrophy',
      extensionSeconds: 0,
    });

    expect(text(html)).toContain('1:15');
    expect(text(html)).toContain('Default rest for hypertrophy');
  });

  it('counts down an unplanned exercise from the 120 s default, marked', () => {
    const html = renderRest(120, { source: 'intent_default', intent: null, extensionSeconds: 0 });

    expect(text(html)).toContain('1:30');
    expect(text(html)).toContain('Default rest');
  });

  it('names the extension on an extended default', () => {
    const html = renderRest(135, {
      source: 'intent_default_extended',
      intent: 'hypertrophy',
      extensionSeconds: 30,
    });

    expect(text(html)).toContain('1:45');
    expect(text(html)).toContain('Default rest for hypertrophy +30 s ');
    expect(text(html)).not.toContain('fewer reps');
  });

  it('counts up only when no rest resolved', () => {
    expect(text(renderRest(null, null))).toContain('0:30');
  });
});

describe('restBasisCaption', () => {
  it('marks nothing for the coach', () => {
    expect(
      restBasisCaption({ source: 'explicit_plan', intent: 'strength', extensionSeconds: 0 }),
    ).toBeNull();
  });
});
