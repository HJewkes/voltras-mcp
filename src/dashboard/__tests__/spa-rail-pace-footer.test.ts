// The rail's pace footer (VW-290): the tile derivation, and that `LivePage`
// actually renders it for a session carrying a pace and renders NOTHING for one
// without a plan attached.
//
// The render assertion mounts the real `LivePage` (`renderToStaticMarkup` under the
// react-native-web alias, same technique as `spa-auto-armed-badge.test.ts`) so a
// broken wiring between the snapshot field and the rail fails here, not just at the
// helper.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LivePage } from '../spa/live-page/LivePage.js';
import {
  derivePaceMetrics,
  type DashboardModel,
  type SessionModel,
  type SessionPaceView,
} from '../spa/live-page/model.js';

const pace = (over: Partial<SessionPaceView> = {}): SessionPaceView => ({
  plannedMinutes: 62,
  elapsedMinutes: 18,
  plannedSetsRemaining: 9,
  projectedEndAt: '2026-05-09T13:02:00.000Z',
  ...over,
});

function sessionModel(over: Partial<SessionModel> = {}): SessionModel {
  return {
    hasSession: true,
    exerciseName: 'Cable Chest Press',
    title: 'Push A',
    lifter: null,
    weightLbs: 140,
    unit: 'lbs',
    completedSets: [],
    plannedExercises: [],
    restSec: null,
    plannedSets: null,
    targetReps: null,
    expectedSetupCard: null,
    sessionPace: null,
    ...over,
  };
}

const dashboardModel = (session: SessionModel): DashboardModel => ({
  live: null,
  session,
  restElapsedMs: null,
});

describe('derivePaceMetrics', () => {
  it('reports the planned sets left and the projected finish', () => {
    const [left, eta] = derivePaceMetrics(pace());
    expect(left).toEqual({ label: 'Left', value: '9 sets' });
    expect(eta?.label).toBe('ETA');
    expect(eta?.value).toBe(
      new Date('2026-05-09T13:02:00.000Z').toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }),
    );
  });

  it('says "1 set", not "1 sets", on the last one', () => {
    expect(derivePaceMetrics(pace({ plannedSetsRemaining: 1 }))[0]?.value).toBe('1 set');
  });

  it('derives no tiles at all without a pace', () => {
    expect(derivePaceMetrics(null)).toEqual([]);
  });
});

describe('LivePage rail footer', () => {
  it('renders the pace tiles for a session with a plan attached', () => {
    const html = renderToStaticMarkup(
      createElement(LivePage, { model: dashboardModel(sessionModel({ sessionPace: pace() })) }),
    );
    expect(html).toContain('Left');
    expect(html).toContain('9 sets');
    expect(html).toContain('ETA');
    // The minutes half of the same estimate, on the rail's own clock + budget.
    expect(html).toContain('18:00');
    expect(html).toContain('62:00');
  });

  it('hides the footer for a session with no plan attached', () => {
    const html = renderToStaticMarkup(
      createElement(LivePage, { model: dashboardModel(sessionModel({ sessionPace: null })) }),
    );
    expect(html).not.toContain('ETA');
    expect(html).not.toContain('9 sets');
  });
});
