// The effort target caption on the live header and the rest recap (VW-670).

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ExerciseHeader } from '../spa/live-page/ExerciseHeader.js';
import { RestView } from '../spa/live-page/RestView.js';
import { effortCaption } from '../spa/live-page/live-copy.js';
import type { CompletedSet, DashboardModel, SessionModel } from '../spa/live-page/model.js';
import type { TierView } from '../read-models/session-plan.js';
import { exerciseFatigueStop } from '../../state/velocity-loss-intent.js';

const CORPUS = 'RP rp-s7-rir-self-report-accuracy-by-tier, rp-s4-beginner-rir-floor-progression';
const DECLARED: TierView = { tier: 'advanced', confidence: 'confident', source: 'declared' };

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

function sessionModel(over: Partial<SessionModel> = {}): SessionModel {
  return {
    hasSession: true,
    exerciseName: 'Cable Row',
    title: null,
    lifter: null,
    weightLbs: 100,
    unit: 'lbs',
    completedSets: [],
    plannedExercises: [],
    restSec: null,
    restBasis: null,
    plannedSets: 3,
    targetReps: 8,
    expectedSetupCard: null,
    sessionPace: null,
    ...over,
  };
}

function renderHeader(session: SessionModel): string {
  const model: DashboardModel = { live: null, session, restElapsedMs: null };
  return renderToStaticMarkup(createElement(ExerciseHeader, { model }));
}

function renderRecap(session: SessionModel): string {
  const model: DashboardModel = { live: null, session, restElapsedMs: 30_000 };
  return renderToStaticMarkup(createElement(RestView, { model }));
}

describe('effortCaption', () => {
  it('labels a coach-written RPE as the target, unconverted', () => {
    expect(effortCaption({ text: 'RPE 8', basis: 'plan', assumed: false })).toBe('Target RPE 8');
  });

  it("shows a declared tier's wall text as written", () => {
    const basis = `advanced tier (declared) · ${CORPUS}`;

    expect(effortCaption({ text: 'Target 2-3 RIR', basis, assumed: false })).toBe('Target 2-3 RIR');
  });

  it('marks a tier nobody declared as assumed', () => {
    const basis = `beginner tier (assumed) · ${CORPUS}`;
    const text = 'Technique focus, 1-2 reps shy of failure at most';

    expect(effortCaption({ text, basis, assumed: true })).toBe(`${text} (assumed tier)`);
  });

  it('keeps the assumed marker when the basis wording changes', () => {
    const text = 'Technique focus';

    expect(effortCaption({ text, basis: 'a reworded basis', assumed: true })).toBe(
      `${text} (assumed tier)`,
    );
  });

  it('gives no caption without an effort target', () => {
    expect(effortCaption(null)).toBeNull();
  });
});

describe('ExerciseHeader effort caption', () => {
  it('exposes the basis through an accessible label, not only the hover tooltip', () => {
    const html = renderHeader(sessionModel({ targetRpe: null, tier: DECLARED }));

    expect(html).toMatch(/aria-label="[^"]*advanced tier \(declared\)[^"]*"/);
  });

  it('renders the plan RPE under the lockup', () => {
    const html = renderHeader(sessionModel({ targetRpe: 8, tier: DECLARED }));

    expect(html).toContain('effort-caption');
    expect(html).toContain('Target RPE 8');
  });

  it("renders the tier's target when the plan states no RPE", () => {
    expect(renderHeader(sessionModel({ tier: DECLARED }))).toContain('Target 2-3 RIR');
  });

  it('renders no caption element without a plan RPE or a tier', () => {
    expect(renderHeader(sessionModel())).not.toContain('effort-caption');
  });

  it('renders no caption on an unplanned session, which has no lockup', () => {
    const html = renderHeader(
      sessionModel({ plannedSets: null, targetReps: null, tier: DECLARED }),
    );

    expect(html).not.toContain('effort-caption');
  });
});

describe('rest recap effort caption', () => {
  it('renders the same caption under the recap heading', () => {
    const html = renderRecap(sessionModel({ completedSets: [SET], targetRpe: 7 }));

    expect(html).toContain('effort-caption');
    expect(html).toContain('Target RPE 7');
  });

  it('renders no caption element without an effort target', () => {
    expect(renderRecap(sessionModel({ completedSets: [SET] }))).not.toContain('effort-caption');
  });
});
