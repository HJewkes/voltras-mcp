// Render test for the expected setup card row on the page header (VW-275).
//
// Mounts the actual `ExerciseHeader` (same technique as
// `spa-exercise-header-title.test.ts`) so the assertion covers the real markup.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ExerciseHeader } from '../spa/live-page/LiveView.js';
import type { DashboardModel, SessionModel } from '../spa/live-page/model.js';

function sessionModel(over: Partial<SessionModel> = {}): SessionModel {
  return {
    hasSession: true,
    exerciseName: 'Cable Chest Press',
    title: null,
    lifter: null,
    weightLbs: 140,
    unit: 'lbs',
    completedSets: [],
    plannedExercises: [],
    restSec: null,
    restBasis: null,
    plannedSets: null,
    targetReps: null,
    expectedSetupCard: null,
    sessionPace: null,
    ...over,
  };
}

function renderHeader(session: SessionModel): string {
  const model: DashboardModel = { live: null, session, restElapsedMs: null };
  return renderToStaticMarkup(createElement(ExerciseHeader, { model }));
}

describe('ExerciseHeader expected setup card (VW-275)', () => {
  it('renders anchor, mount hole, cable length and mode joined on one line', () => {
    const html = renderHeader(
      sessionModel({
        expectedSetupCard: { anchor: 'mid', mountHole: 3, cableLengthSetting: 36, mode: 'Normal' },
      }),
    );
    expect(html).toContain('expected-setup-card');
    expect(html).toContain('Anchor: Mid');
    expect(html).toContain('Hole 3');
    expect(html).toContain('Cable 36');
    expect(html).toContain('Normal');
  });

  it('renders anchor alone for a digest-seeded default with no other fields', () => {
    const html = renderHeader(sessionModel({ expectedSetupCard: { anchor: 'high' } }));
    expect(html).toContain('Anchor: High');
    expect(html).not.toContain('Hole');
  });

  it('renders nothing when no card resolved', () => {
    const html = renderHeader(sessionModel({ expectedSetupCard: null }));
    expect(html).not.toContain('expected-setup-card');
  });

  it('renders nothing when no session is open, even with a stale card in the model', () => {
    const html = renderHeader(
      sessionModel({ hasSession: false, expectedSetupCard: { anchor: 'low' } }),
    );
    expect(html).not.toContain('expected-setup-card');
  });
});
