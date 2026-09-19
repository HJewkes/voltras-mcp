// Unit tests for warmup/probe/technique set treatment on the wall (VW-260).
//
// Focus: a non-working set is real and logged, but must never inflate the working-set
// tally (the rail's per-exercise `summary.sets` and the header's session-wide pace figure),
// and the rest recap must mark it with a distinct label. Pure projection + one render test —
// no DOM for the model assertions, `renderToStaticMarkup` only for the RestView label.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RestView } from '../spa/live-page/RestView.js';
import {
  deriveRailExercises,
  isWorkingSet,
  workingCompletedSets,
  type CompletedSet,
  type DashboardModel,
  type SessionModel,
  type SetPurpose,
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

function completed(setPurpose: SetPurpose, repCount = 8): CompletedSet {
  return {
    fatigueStop: exerciseFatigueStop(undefined),
    fatigueVerdict: null,
    exerciseName: 'Cable Chest Press',
    weightLbs: 140,
    mode: 'weight',
    repCount,
    reps: [0.5, 0.48],
    peakForceLbs: null,
    setPurpose,
  };
}

describe('isWorkingSet / workingCompletedSets (VW-260)', () => {
  it('counts a working set but not warmup/probe/technique sets', () => {
    const working = completed('working');
    const warmup = completed('warmup');
    const probe = completed('probe');
    const technique = completed('technique');
    expect(isWorkingSet(working, [working])).toBe(true);
    expect(isWorkingSet(warmup, [warmup])).toBe(false);
    expect(isWorkingSet(probe, [probe])).toBe(false);
    expect(isWorkingSet(technique, [technique])).toBe(false);
  });

  it('excludes non-working sets from the session-wide tally, keeping them in the log', () => {
    const session = sessionModel({
      completedSets: [completed('warmup'), completed('working'), completed('working')],
    });
    expect(session.completedSets).toHaveLength(3); // still logged
    expect(workingCompletedSets(session)).toHaveLength(2); // tally excludes the warmup
  });
});

describe('the rail row tally excludes non-working sets (VW-260)', () => {
  it('a warmup set never counts toward the active row\'s "sets done" figure', () => {
    const session = sessionModel({
      completedSets: [completed('warmup'), completed('working')],
    });
    const [row] = deriveRailExercises(model({ session }));
    // 1 working set banked, none in progress — the warmup does not add a second.
    expect(row.summary.sets).toBe(1);
  });

  it('an all-warmup exercise reads as zero working sets, not a fabricated one', () => {
    const session = sessionModel({
      completedSets: [completed('warmup'), completed('warmup')],
    });
    const [row] = deriveRailExercises(model({ session }));
    expect(row.summary.sets).toBe(0);
  });
});

describe('RestView labels a non-working set (VW-260)', () => {
  function renderRest(session: SessionModel): string {
    return renderToStaticMarkup(createElement(RestView, { model: model({ session }) }));
  }

  it('marks a warmup row WARM-UP and a working row with no marker', () => {
    const html = renderRest(
      sessionModel({ completedSets: [completed('warmup'), completed('working')] }),
    );
    expect(html).toContain('WARM-UP');
  });

  it('carries no set-type marker when every logged set is working', () => {
    const html = renderRest(sessionModel({ completedSets: [completed('working')] }));
    expect(html).not.toContain('WARM-UP');
    expect(html).not.toContain('PROBE');
    expect(html).not.toContain('TECHNIQUE');
  });
});
