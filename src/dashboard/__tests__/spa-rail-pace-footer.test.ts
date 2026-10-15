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
  derivePaceSuggestion,
  type DashboardModel,
  type PlannedExerciseModel,
  type SessionModel,
  type SessionPaceView,
} from '../spa/live-page/model.js';

const pace = (over: Partial<SessionPaceView> = {}): SessionPaceView => ({
  plannedMinutes: 62,
  elapsedMinutes: 18,
  plannedSetsRemaining: 9,
  projectedEndAt: '2026-05-09T13:02:00.000Z',
  state: 'on_pace',
  slipMinutes: 0,
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
    restBasis: null,
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

const paceTile = (view: SessionPaceView) =>
  derivePaceMetrics(view).find((tile) => tile.label === 'Pace');

describe('derivePaceMetrics pace tile (VMCP-02.76)', () => {
  it('reads "on pace" for a session within tolerance', () => {
    expect(paceTile(pace({ state: 'on_pace', slipMinutes: 1 }))?.value).toBe('on pace');
  });

  it('reads the minutes behind with a plus sign', () => {
    expect(paceTile(pace({ state: 'behind', slipMinutes: 9 }))?.value).toBe('+9 min');
  });

  it('reads the minutes ahead with a minus sign', () => {
    expect(paceTile(pace({ state: 'ahead', slipMinutes: -7 }))?.value).toBe('-7 min');
  });

  it('shows no pace tile while idle, only the budget tiles', () => {
    const tiles = derivePaceMetrics(pace({ state: 'idle', slipMinutes: 0 }));
    expect(tiles.map((tile) => tile.label)).toEqual(['Left', 'ETA']);
  });
});

const planned = (exerciseId: string, name: string, active = false): PlannedExerciseModel => ({
  exerciseId,
  name,
  plannedSets: 3,
  targetReps: 10,
  repsLabel: 10,
  weightLbs: null,
  active,
});

const plan = [
  planned('ex-press', 'Cable Chest Press', true),
  planned('ex-fly', 'Cable Fly'),
  planned('ex-raise', 'Lateral Raise'),
];

describe('derivePaceSuggestion', () => {
  it('names each trimmed exercise and the minutes saved', () => {
    const view = pace({
      state: 'behind',
      slipMinutes: 5,
      suggestion: {
        kind: 'trim',
        cuts: [
          { exerciseId: 'ex-raise', fromSets: 3, toSets: 2 },
          { exerciseId: 'ex-fly', fromSets: 3, toSets: 2 },
        ],
        savesMinutes: 6,
        coversSlip: true,
      },
    });
    expect(derivePaceSuggestion(view, plan)).toBe(
      'Behind plan: trim Lateral Raise to 2 sets and Cable Fly to 2 sets to save 6 min.',
    );
  });

  it('says the trim falls short when it cannot cover the slip', () => {
    const view = pace({
      state: 'behind',
      slipMinutes: 20,
      suggestion: {
        kind: 'trim',
        cuts: [{ exerciseId: 'ex-raise', fromSets: 3, toSets: 1 }],
        savesMinutes: 6,
        coversSlip: false,
      },
    });
    expect(derivePaceSuggestion(view, plan)).toBe(
      'Behind plan: trim Lateral Raise to 1 set to save 6 min, short of the 20 min you are behind.',
    );
  });

  it('names the exercise an add suggestion targets', () => {
    const view = pace({
      state: 'ahead',
      slipMinutes: -8,
      suggestion: { kind: 'add', exerciseId: 'ex-press', sets: 2, costsMinutes: 6 },
    });
    expect(derivePaceSuggestion(view, plan)).toBe(
      'Ahead of plan: room for 2 more sets of Cable Chest Press (about 6 min).',
    );
  });

  it('says nothing without a suggestion or without a pace', () => {
    expect(derivePaceSuggestion(pace(), plan)).toBeNull();
    expect(derivePaceSuggestion(null, plan)).toBeNull();
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

  it('renders the behind tile and the trim sentence under the rail', () => {
    const view = pace({
      state: 'behind',
      slipMinutes: 9,
      suggestion: {
        kind: 'trim',
        cuts: [{ exerciseId: 'ex-raise', fromSets: 3, toSets: 1 }],
        savesMinutes: 6,
        coversSlip: false,
      },
    });
    const html = renderToStaticMarkup(
      createElement(LivePage, {
        model: dashboardModel(sessionModel({ sessionPace: view, plannedExercises: plan })),
      }),
    );
    expect(html).toContain('Pace');
    expect(html).toContain('+9 min');
    expect(html).toContain('trim Lateral Raise to 1 set to save 6 min, short of the 9 min');
  });

  it('renders the budget but no pace tile or sentence while idle', () => {
    const html = renderToStaticMarkup(
      createElement(LivePage, {
        model: dashboardModel(
          sessionModel({ sessionPace: pace({ state: 'idle' }), plannedExercises: plan }),
        ),
      }),
    );
    expect(html).toContain('62:00');
    expect(html).not.toContain('+0 min');
    expect(html).not.toContain('on pace');
    expect(html).not.toContain('Behind plan');
  });

  it('hides the footer for a session with no plan attached', () => {
    const html = renderToStaticMarkup(
      createElement(LivePage, { model: dashboardModel(sessionModel({ sessionPace: null })) }),
    );
    expect(html).not.toContain('ETA');
    expect(html).not.toContain('9 sets');
    expect(html).not.toContain('Pace');
    expect(html).not.toContain('Behind plan');
  });
});
