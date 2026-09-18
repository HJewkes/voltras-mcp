// The wall's per-set missed-target verdict (VW-262) — hit / miss / no-target,
// and proof that the wall and `report.session_results` cannot disagree about
// the same set because both derive from `analytics/target-verdict.ts`.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ServerState } from '../../state/server-state.js';
import type { StoredPlannedExercise, StoredSession, StoredSet } from '../../store/types.js';
import { buildSessionResults } from '../../tools/report-tools.js';
import { RestView } from '../spa/live-page/RestView.js';
import {
  completedSetVerdict,
  deriveMissedSetsMetric,
  type CompletedSet,
  type DashboardModel,
  type PlannedExerciseModel,
  type SessionModel,
} from '../spa/live-page/model.js';
import { exerciseFatigueStop } from '../../state/velocity-loss-intent.js';

function sessionModel(over: Partial<SessionModel> = {}): SessionModel {
  return {
    hasSession: true,
    exerciseName: 'Seated Row',
    title: null,
    lifter: null,
    weightLbs: null,
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

function planned(over: Partial<PlannedExerciseModel> = {}): PlannedExerciseModel {
  return {
    name: 'Seated Row',
    plannedSets: 3,
    targetReps: 8,
    repsLabel: '8–12',
    weightLbs: 170,
    active: true,
    ...over,
  };
}

function completed(repCount: number): CompletedSet {
  return {
    fatigueStop: exerciseFatigueStop(undefined),
    fatigueVerdict: null,
    exerciseName: 'Seated Row',
    weightLbs: 170,
    mode: 'weight',
    repCount,
    reps: [],
    peakForceLbs: null,
    setPurpose: 'working',
  };
}

describe('completedSetVerdict', () => {
  it('hits at or above the planned rep floor', () => {
    const session = sessionModel({ plannedExercises: [planned()] });
    expect(completedSetVerdict(completed(12), session)).toBe('hit');
    expect(completedSetVerdict(completed(8), session)).toBe('hit');
  });

  it('misses below the planned rep floor', () => {
    const session = sessionModel({ plannedExercises: [planned()] });
    expect(completedSetVerdict(completed(6), session)).toBe('miss');
  });

  it('is no-target with no plan attached', () => {
    const session = sessionModel();
    expect(completedSetVerdict(completed(6), session)).toBe('no-target');
  });
});

describe('deriveMissedSetsMetric', () => {
  it('is null when nothing missed', () => {
    const session = sessionModel({
      plannedExercises: [planned()],
      completedSets: [completed(12), completed(9)],
    });
    expect(deriveMissedSetsMetric({ live: null, session, restElapsedMs: null })).toBeNull();
  });

  it('reports how many sets missed this session', () => {
    const session = sessionModel({
      plannedExercises: [planned()],
      completedSets: [completed(12), completed(9), completed(6)],
    });
    expect(deriveMissedSetsMetric({ live: null, session, restElapsedMs: null })).toEqual({
      label: 'Missed',
      value: '1',
    });
  });
});

describe('RestView', () => {
  it('shows a MISS verdict tile for a set that fell short', () => {
    const session = sessionModel({
      plannedExercises: [planned()],
      completedSets: [completed(12), completed(9), completed(6)],
    });
    const model: DashboardModel = { live: null, session, restElapsedMs: null };
    const html = renderToStaticMarkup(createElement(RestView, { model }));
    expect(html).toContain('MISS');
  });

  it('shows no Target tile with no plan attached', () => {
    const session = sessionModel({ completedSets: [completed(6)] });
    const model: DashboardModel = { live: null, session, restElapsedMs: null };
    const html = renderToStaticMarkup(createElement(RestView, { model }));
    expect(html).not.toContain('MISS');
    expect(html).not.toContain('HIT');
  });
});

// ---------------------------------------------------------------------------
// Equality: `report.session_results`' "missed: X of Y" line and the wall's
// verdict must agree on the SAME fixture — three working sets (12, 9, 6 reps)
// against an 8-rep floor, one below it.
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-1';
const ROW_ID = 'seated-row';
const ENDED_AT = new Date(2026, 8, 8, 12, 0, 0).toISOString();
const REP_COUNTS = [12, 9, 6];
const TARGET_REPS_LOW = 8;

function makeReportState(): ServerState {
  const session: StoredSession = { id: SESSION_ID, startedAt: ENDED_AT, endedAt: ENDED_AT };
  const sets: StoredSet[] = REP_COUNTS.map((reps, i) => ({
    id: `s${i + 1}`,
    sessionId: SESSION_ID,
    startedAt: ENDED_AT,
    endedAt: ENDED_AT,
    partial: false,
    exerciseId: ROW_ID,
    reps: [],
    weightLbs: 170,
    firmwareRepCount: reps,
  }));
  const planned: StoredPlannedExercise = {
    id: 'pe-1',
    workoutTemplateId: 'tpl-1',
    exerciseId: ROW_ID,
    orderIndex: 0,
    targetSets: 3,
    targetRepsLow: TARGET_REPS_LOW,
    targetRepsHigh: 12,
  };
  return {
    config: { adapter: 'node' },
    store: {
      getSession: () => Promise.resolve(session),
      getSetsForSession: () => Promise.resolve(sets),
      getAssignmentsForSession: () =>
        Promise.resolve([
          { id: 'a1', sessionId: SESSION_ID, workoutTemplateId: 'tpl-1', assignedAt: ENDED_AT },
        ]),
      getPlannedExercisesForTemplate: () => Promise.resolve([planned]),
      getPlannedExercise: () => Promise.resolve(undefined),
    },
    exercises: { getById: (id: string) => ({ id, name: 'Seated Row' }) },
  } as unknown as ServerState;
}

it('the report string and the wall verdict agree on the same fixture', async () => {
  const results = await buildSessionResults(makeReportState(), SESSION_ID);
  const reportMissed = /missed: (\d+) of/.exec(results.exercises[0]?.result ?? '');
  expect(reportMissed).not.toBeNull();

  const session = sessionModel({
    plannedExercises: [planned({ targetReps: TARGET_REPS_LOW })],
    completedSets: REP_COUNTS.map((reps) => completed(reps)),
  });
  const wallMetric = deriveMissedSetsMetric({ live: null, session, restElapsedMs: null });

  expect(wallMetric?.value).toBe(reportMissed?.[1]);
});
