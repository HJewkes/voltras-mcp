// Unit tests for the planner/completion SPA mappers + hash router (VW-120).

import { describe, expect, it } from 'vitest';

import { LATEST_SESSION, parseRoute, routeHash } from '../spa/routing.js';
import {
  flattenTemplates,
  formatNumber,
  nextTargetWeightLbs,
  prescriptionLine,
  progressionLabel,
  repRange,
  resolveSelectedTemplateId,
  setsAgainstPlan,
  type FlatTemplate,
} from '../spa/planner/planner-model.js';
import type { PlanExerciseView, PlanTreeView } from '../read-models/plan-tree.js';
import type {
  SessionSummaryExercise,
  SessionSummaryProgression,
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
    expect(setsAgainstPlan(summaryExercise({ progression: null, workingSetCount: 1 }))).toBe(
      '1 working set',
    );
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
