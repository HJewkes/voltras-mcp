// Unit tests for the post-session-end stage (VW-261).
//
// Focus: `stageIsEnded` — the pure predicate that tells the live page a session just closed
// (so it should route to the summary) apart from the true cold state, where no session has
// ever been recorded. Pure projection — no DOM, no I/O.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EmptyLiveView, SessionEndedView } from '../spa/live-page/EmptyLiveView.js';
import {
  stageIsEmpty,
  stageIsEnded,
  type CompletedSet,
  type DashboardModel,
  type SessionModel,
} from '../spa/live-page/model.js';
import { exerciseFatigueStop } from '../../state/velocity-loss-intent.js';

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

function model(over: Partial<DashboardModel> = {}): DashboardModel {
  return { live: null, session: sessionModel(), restElapsedMs: null, ...over };
}

function completed(exerciseName: string, repCount = 8): CompletedSet {
  return {
    fatigueStop: exerciseFatigueStop(undefined),
    fatigueVerdict: null,
    exerciseName,
    weightLbs: 140,
    mode: 'weight',
    repCount,
    reps: [],
    peakForceLbs: null,
    setPurpose: 'working',
  };
}

describe('stageIsEnded (VW-261)', () => {
  it('is false for the true cold state — no session ever recorded', () => {
    const m = model({ session: sessionModel({ hasSession: false }) });
    expect(stageIsEmpty(m)).toBe(true);
    expect(stageIsEnded(m)).toBe(false);
  });

  it('is false while a session is open and resting between sets', () => {
    const m = model({
      session: sessionModel({ hasSession: true, completedSets: [completed('Cable Chest Press')] }),
    });
    expect(stageIsEnded(m)).toBe(false);
  });

  it('is true once session.end closes a session that logged a set', () => {
    const m = model({
      session: sessionModel({ hasSession: false, completedSets: [completed('Cable Chest Press')] }),
    });
    expect(stageIsEnded(m)).toBe(true);
  });

  it('is true once session.end closes a session mid-rest, before the next set logs', () => {
    const m = model({ session: sessionModel({ hasSession: false }), restElapsedMs: 4000 });
    expect(stageIsEnded(m)).toBe(true);
  });
});

describe('SessionEndedView (VW-261)', () => {
  it('names the transition and links to the latest summary', () => {
    const html = renderToStaticMarkup(createElement(SessionEndedView));
    expect(html).toContain('Session complete');
    expect(html).toContain('role="link"');
    expect(html).toContain('View session summary');
  });
});

describe('EmptyLiveView cold state is unchanged (VW-261)', () => {
  it('still shows "No Voltra connected" on a known disconnect', () => {
    const m = model({ connection: { connected: false, label: 'OFFLINE' } });
    const html = renderToStaticMarkup(createElement(EmptyLiveView, { model: m }));
    expect(html).toContain('No Voltra connected');
  });

  it('still shows "Waiting for a set" with no session and no known disconnect', () => {
    const m = model({ session: sessionModel({ hasSession: false }) });
    const html = renderToStaticMarkup(createElement(EmptyLiveView, { model: m }));
    expect(html).toContain('Waiting for a set');
  });
});
