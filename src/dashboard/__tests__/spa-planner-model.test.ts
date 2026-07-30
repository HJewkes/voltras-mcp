// Unit tests for the planner/completion SPA mappers + hash router (VW-120).

import { describe, expect, it } from 'vitest';

import { LATEST_SESSION, parseRoute, routeHash } from '../spa/routing.js';
import {
  e1rmChangePct,
  e1rmSeries,
  flattenTemplates,
  formatNumber,
  nextTargetWeightLbs,
  prescriptionLine,
  progressionLabel,
  repRange,
  resolveSelectedTemplateId,
  sessionRollup,
  setLine,
  setsAgainstPlan,
  type FlatTemplate,
} from '../spa/planner/planner-model.js';
import type { PlanExerciseView, PlanTreeView } from '../read-models/plan-tree.js';
import type {
  SessionSummaryExercise,
  SessionSummaryProgression,
  SessionSummarySet,
} from '../read-models/session-summary-view.js';

function exerciseView(overrides: Partial<PlanExerciseView> = {}): PlanExerciseView {
  return {
    id: 'pe-1',
    exerciseId: 'cable-row',
    name: 'Cable Row',
    orderIndex: 0,
    targetSets: 3,
    ...overrides,
  };
}

function tree(templateIds: string[]): PlanTreeView {
  return {
    programs: [],
    activeTemplateId: null,
    activeExerciseId: null,
    program: {
      id: 'prog-1',
      name: 'P',
      createdAt: '2026-07-01T00:00:00.000Z',
      blocks: [
        {
          id: 'blk-1',
          name: 'Block 1',
          orderIndex: 0,
          weeksCount: 1,
          weeks: [
            {
              id: 'wk-1',
              orderIndex: 0,
              templates: templateIds.map((id, index) => ({
                id,
                name: id,
                orderIndex: index,
                exercises: [],
                completed: false,
              })),
            },
          ],
        },
      ],
    },
  };
}

function flat(ids: string[]): FlatTemplate[] {
  return flattenTemplates(tree(ids));
}

describe('parseRoute', () => {
  it('defaults to the live page for empty/unknown hashes', () => {
    expect(parseRoute('')).toEqual({ name: 'live' });
    expect(parseRoute('#/')).toEqual({ name: 'live' });
    expect(parseRoute('#/nonsense')).toEqual({ name: 'live' });
  });

  it('routes the plan builder', () => {
    expect(parseRoute('#/plan')).toEqual({ name: 'plan' });
    expect(parseRoute('#/plan/')).toEqual({ name: 'plan' });
  });

  it('routes a summary with an explicit session id, decoding it', () => {
    expect(parseRoute('#/summary/sess%2F1')).toEqual({ name: 'summary', sessionId: 'sess/1' });
  });

  it('routes a bare summary to the latest session', () => {
    expect(parseRoute('#/summary')).toEqual({ name: 'summary', sessionId: LATEST_SESSION });
  });

  it('round-trips through routeHash', () => {
    for (const hash of ['#/', '#/plan', '#/summary', '#/summary/sess-1']) {
      expect(routeHash(parseRoute(hash))).toBe(hash);
    }
  });
});

describe('flattenTemplates', () => {
  it('returns [] when no program is loaded', () => {
    expect(flattenTemplates(null)).toEqual([]);
    expect(flattenTemplates({ ...tree([]), program: null })).toEqual([]);
  });

  it('carries the block/week breadcrumb for each workout', () => {
    const [first] = flat(['tpl-1']);
    expect(first?.blockName).toBe('Block 1');
    expect(first?.weekName).toBe('Week 1');
  });
});

describe('resolveSelectedTemplateId', () => {
  const templates = flat(['tpl-1', 'tpl-2']);

  it('keeps a still-present selection across a refresh', () => {
    expect(resolveSelectedTemplateId(templates, 'tpl-2', 'tpl-1')).toBe('tpl-2');
  });

  it('falls back to the live session’s template when the selection is gone', () => {
    expect(resolveSelectedTemplateId(templates, 'deleted', 'tpl-2')).toBe('tpl-2');
  });

  it('falls back to the first workout when nothing else resolves', () => {
    expect(resolveSelectedTemplateId(templates, null, null)).toBe('tpl-1');
    expect(resolveSelectedTemplateId([], null, null)).toBeNull();
  });
});

describe('prescriptionLine', () => {
  it('renders sets × rep-band with load, RPE, and rest', () => {
    expect(
      prescriptionLine(
        exerciseView({ targetRepsLow: 8, targetRepsHigh: 12, targetWeightLbs: 135, restSec: 90 }),
      ),
    ).toBe('3 × 8-12 · @ 135 lb · 90s rest');
  });

  it('never invents a rep band or a load', () => {
    expect(prescriptionLine(exerciseView())).toBe('3 sets');
  });

  it('collapses a single-value band', () => {
    expect(repRange(5, 5)).toBe('5');
    expect(repRange(5, undefined)).toBe('5');
    expect(repRange(undefined, 8)).toBeNull();
  });
});

function progression(
  overrides: Partial<SessionSummaryProgression> = {},
): SessionSummaryProgression {
  return {
    delta: 5,
    reasoning: 'hit the band',
    basedOnSessionId: 'sess-1',
    targetSets: 3,
    targetRepsLow: 8,
    targetRepsHigh: 12,
    targetWeightLbs: 135,
    ...overrides,
  };
}

function summaryExercise(overrides: Partial<SessionSummaryExercise> = {}): SessionSummaryExercise {
  return {
    exerciseId: 'cable-row',
    name: 'Cable Row',
    setCount: 3,
    workingSetCount: 3,
    totalReps: 30,
    volumeLbs: 4050,
    topWeightLbs: 135,
    bestRepVelocity: 0.82,
    maxVelocityLossPct: 18.4,
    verdict: null,
    fatigue: null,
    verdictSetIndex: null,
    sets: [],
    progression: progression(),
    progressionNote: null,
    ...overrides,
  };
}

describe('progression readouts', () => {
  it('labels the delta with a sign, and a hold as "hold"', () => {
    expect(progressionLabel(progression({ delta: 5 }))).toBe('+5 lb');
    expect(progressionLabel(progression({ delta: -5 }))).toBe('-5 lb');
    expect(progressionLabel(progression({ delta: 0 }))).toBe('hold');
    expect(progressionLabel(null)).toBe('—');
  });

  it('adds the delta to the load actually lifted, not the plan target', () => {
    // Top load (145) has outgrown the plan's 135 — progress from what was lifted.
    expect(nextTargetWeightLbs(summaryExercise({ topWeightLbs: 145 }))).toBe(150);
  });

  it('falls back to the planned load when the session recorded none', () => {
    expect(nextTargetWeightLbs(summaryExercise({ topWeightLbs: null }))).toBe(140);
  });

  it('returns null rather than inventing a target with no load anywhere', () => {
    expect(
      nextTargetWeightLbs(
        summaryExercise({
          topWeightLbs: null,
          progression: progression({ targetWeightLbs: null }),
        }),
      ),
    ).toBeNull();
    expect(nextTargetWeightLbs(summaryExercise({ progression: null }))).toBeNull();
  });

  it('reports sets against the plan when there is one', () => {
    expect(setsAgainstPlan(summaryExercise())).toBe('3 / 3 sets');
    expect(setsAgainstPlan(summaryExercise({ workingSetCount: 2 }))).toBe('2 / 3 sets');
    expect(setsAgainstPlan(summaryExercise({ progression: null, workingSetCount: 1 }))).toBe(
      '1 working set',
    );
  });

  it('does not render an overshoot as a fraction greater than one', () => {
    // VW-121 / F5: an extra set produced literally `3 / 2 sets` — "three out of
    // two", which is not a sentence. The same two numbers, said truthfully.
    const over = summaryExercise({
      workingSetCount: 3,
      progression: progression({ targetSets: 2 }),
    });
    expect(setsAgainstPlan(over)).toBe('3 sets · target 2');
    expect(setsAgainstPlan(over)).not.toContain('/');
  });
});

describe('formatNumber', () => {
  it('rounds to one decimal and appends the unit', () => {
    expect(formatNumber(18.44, '%')).toBe('18.4 %');
    expect(formatNumber(135)).toBe('135');
  });

  it('renders a gap, never a zero, for an absent measurement', () => {
    expect(formatNumber(null)).toBe('—');
    expect(formatNumber(undefined)).toBe('—');
    expect(formatNumber(Number.NaN)).toBe('—');
  });
});

function summarySet(overrides: Partial<SessionSummarySet> = {}): SessionSummarySet {
  return {
    id: 'set-1',
    index: 1,
    startedAt: '2026-07-30T10:00:00.000Z',
    endedAt: '2026-07-30T10:00:40.000Z',
    weightLbs: 135,
    repCount: 10,
    isWarmup: false,
    velocityLossPct: 12,
    bestRepVelocity: 0.8,
    ...overrides,
  };
}

describe('e1rmSeries', () => {
  it('estimates a point per working set, labelled by set ordinal', () => {
    const series = e1rmSeries(
      summaryExercise({
        sets: [
          summarySet({ id: 's1', index: 1, weightLbs: 135, repCount: 10 }),
          summarySet({ id: 's2', index: 2, weightLbs: 135, repCount: 8 }),
        ],
      }),
    );
    expect(series.map((p) => p.sessionLabel)).toEqual(['Set 1', 'Set 2']);
    // Epley: 135 * (1 + 10/30) = 180; 135 * (1 + 8/30) = 171.
    expect(series.map((p) => p.e1rm)).toEqual([180, 171]);
    expect(series[0]?.date).toBe('2026-07-30T10:00:00.000Z');
  });

  it('marks the session best, and only when there is something to compare it to', () => {
    const two = e1rmSeries(
      summaryExercise({
        sets: [
          summarySet({ id: 's1', index: 1, repCount: 8 }),
          summarySet({ id: 's2', index: 2, repCount: 10 }),
        ],
      }),
    );
    expect(two.map((p) => p.isPR === true)).toEqual([false, true]);
    const one = e1rmSeries(summaryExercise({ sets: [summarySet()] }));
    expect(one[0]?.isPR).toBeUndefined();
  });

  it('drops warm-ups and sets with no load, rather than plotting a fabricated zero', () => {
    const series = e1rmSeries(
      summaryExercise({
        sets: [
          summarySet({ id: 'w', index: 1, isWarmup: true }),
          summarySet({ id: 'n', index: 2, weightLbs: null }),
          summarySet({ id: 'z', index: 3, repCount: 0 }),
          summarySet({ id: 'ok', index: 4 }),
        ],
      }),
    );
    expect(series.map((p) => p.sessionLabel)).toEqual(['Set 4']);
  });
});

describe('e1rmChangePct', () => {
  it('reports first-to-last percentage change', () => {
    expect(
      e1rmChangePct([
        { date: 'a', e1rm: 200 },
        { date: 'b', e1rm: 180 },
      ]),
    ).toBe(-10);
  });

  it('has no direction with fewer than two points', () => {
    expect(e1rmChangePct([{ date: 'a', e1rm: 200 }])).toBeNull();
    expect(e1rmChangePct([])).toBeNull();
  });
});

describe('sessionRollup', () => {
  const view = (exercises: SessionSummaryExercise[], endedAt: string | null) => ({
    session: {
      id: 'sess-1',
      startedAt: '2026-07-30T10:00:00.000Z',
      endedAt,
      exerciseId: null,
      exerciseName: null,
    },
    exercises,
  });

  it('sums sets, reps and volume across every exercise', () => {
    const rollup = sessionRollup(
      view(
        [summaryExercise(), summaryExercise({ exerciseId: 'bench', setCount: 2, totalReps: 16 })],
        '2026-07-30T10:45:00.000Z',
      ),
    );
    expect(rollup).toMatchObject({
      exerciseCount: 2,
      setCount: 5,
      totalReps: 46,
      volumeLbs: 8100,
      durationMin: 45,
    });
  });

  it('keeps volume null when no exercise recorded a load, and duration null in progress', () => {
    const rollup = sessionRollup(view([summaryExercise({ volumeLbs: null })], null));
    expect(rollup.volumeLbs).toBeNull();
    expect(rollup.durationMin).toBeNull();
  });
});

describe('setLine', () => {
  it('renders reps × load, and a gap for an unrecorded load', () => {
    expect(setLine(summarySet())).toBe('10 × 135 lb');
    expect(setLine(summarySet({ weightLbs: null }))).toBe('10 × —');
  });
});
