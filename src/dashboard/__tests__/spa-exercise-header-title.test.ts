// Render test for the page-header session title (VW-43).
//
// Mounts the actual `ExerciseHeader` (`renderToStaticMarkup` under the
// react-native-web alias, same technique as `spa-rest-recap.test.ts`) rather
// than asserting on the mapper alone — the requirement is that the header
// shows NO placeholder when the plan chain doesn't resolve a title, which only
// a render assertion on the actual markup can confirm.

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
    plannedSets: null,
    targetReps: null,
    ...over,
  };
}

function renderHeader(session: SessionModel): string {
  const model: DashboardModel = { live: null, session, restElapsedMs: null };
  return renderToStaticMarkup(createElement(ExerciseHeader, { model }));
}

describe('ExerciseHeader session title (VW-43)', () => {
  it('renders the composed title when the session carries one', () => {
    const html = renderHeader(sessionModel({ title: 'Push A · Hypertrophy' }));
    expect(html).toContain('data-testid="session-title"');
    expect(html).toContain('Push A · Hypertrophy');
  });

  it('renders no title element at all — no placeholder — when the session has none', () => {
    const html = renderHeader(sessionModel({ title: null }));
    expect(html).not.toContain('data-testid="session-title"');
  });
});
