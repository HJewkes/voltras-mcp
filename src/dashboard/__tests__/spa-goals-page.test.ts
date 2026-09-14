// Render test for the `#/goals` wall page (VW-355, plan G8').
//
// Builds real `GoalProgressView`s with `buildGoalProgressView` (the same
// function `/api/goal-progress` calls) over literal bands, so the fixtures are
// exactly the shape the route returns — then renders `GoalsView` with
// `renderToStaticMarkup`, same technique as `spa-session-summary-e1rm-toggle.test.ts`.
// Asserts the sections plan G8' names and the hidden bodyweight tile.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { GoalsView } from '../spa/goals/GoalsView.js';
import type { GoalsPageData } from '../spa/goals/goals-model.js';
import {
  buildGoalProgressView,
  buildPriorityRollup,
  type GoalActual,
  type GoalProgressView,
} from '../read-models/goal-progress.js';
import type { GoalBand, GoalBandWeek } from '../../analytics/goal-band.js';
import type { GoalPriorityRow } from '../goal-progress-api.js';
import type { StoredGoalTarget, StoredPriority } from '../../store/types.js';

const START = '2026-08-03T00:00:00.000Z';
const WEEK_3 = '2026-08-18T12:00:00.000Z';
const WEEKS: GoalBandWeek[] = [1, 2, 3, 4, 5, 6].map((index) => ({ index, isDeload: false }));

const BAND: GoalBand = {
  basis: 'rp_ramp',
  infoLevel: 'ramp',
  bandLowPctPerWeek: 1.470588,
  bandHighPctPerWeek: 2.941176,
  corridorPct: null,
  expected: [
    { weekIndex: 1, low: 170, high: 170 },
    { weekIndex: 2, low: 172.5, high: 175 },
    { weekIndex: 3, low: 175, high: 180 },
    { weekIndex: 4, low: 177.5, high: 185 },
    { weekIndex: 5, low: 180, high: 190 },
    { weekIndex: 6, low: 182.5, high: 195 },
  ],
  committedValue: 182.5,
  stretchValue: 195,
  direction: 'up',
  provisional: false,
  notes: [],
};

function priority(over: Partial<StoredPriority> & { id: string }): StoredPriority {
  return {
    userId: 'local',
    horizonWeeks: 6,
    kind: 'lift',
    ref: 'bench-press',
    level: 'specialize',
    declaredAt: START,
    mesosHeld: 1,
    ...over,
  };
}

function target(
  over: Partial<StoredGoalTarget> & { id: string; priorityId: string; metric: string },
): StoredGoalTarget {
  return {
    exerciseId: 'bench-press',
    anchorReps: 8,
    startValue: 170,
    startMeasuredAt: START,
    bandLowPctPerWeek: 1.470588,
    bandHighPctPerWeek: 2.941176,
    committedValue: 182.5,
    stretchValue: 195,
    basis: 'rp_ramp',
    infoLevel: 'ramp',
    tierUsed: 'early-intermediate',
    tierProvisional: false,
    dietPhaseAtDerivation: 'maintenance',
    acceptedBy: 'user',
    acknowledgedStretch: true,
    derivedAt: START,
    endsAt: '2026-09-14T00:00:00.000Z',
    ...over,
  } as StoredGoalTarget;
}

function actual(weekIndex: number, value: number, overrides: Partial<GoalActual> = {}): GoalActual {
  const dayOffset = (weekIndex - 1) * 7 + 1;
  const ts = new Date(Date.parse(START) + dayOffset * 24 * 60 * 60 * 1000).toISOString();
  return { ts, value, matched: true, isPR: false, ...overrides };
}

function view(
  pri: StoredPriority,
  tgt: StoredGoalTarget,
  actuals: readonly GoalActual[],
): GoalProgressView {
  return buildGoalProgressView({
    priority: pri,
    target: tgt,
    band: BAND,
    actuals,
    weeks: WEEKS,
    now: WEEK_3,
    dietState: { phase: 'maintenance', weeksInPhase: 4 },
  });
}

/** A full fixture: one specialize lift (on track, with a PR), one muscle priority whose two
 *  lifts corroborate, one `sessions_28d` commitment. No `bodyweight` target — VW-327 hasn't
 *  landed, so the tile must render nothing. */
function baseData(): { data: GoalsPageData; benchPriority: StoredPriority } {
  const benchPriority = priority({ id: 'pri-bench', kind: 'lift', ref: 'bench-press' });
  const benchTarget = target({
    id: 'tgt-bench',
    priorityId: benchPriority.id,
    metric: 'top_load_at_reps',
    exerciseId: 'bench-press',
  });
  const benchView = view(benchPriority, benchTarget, [
    actual(1, 168),
    actual(2, 171),
    actual(3, 174, { isPR: true }),
  ]);

  const armsPriority = priority({
    id: 'pri-arms',
    kind: 'muscle',
    ref: 'biceps',
    level: 'specialize',
  });
  const curlTarget = target({
    id: 'tgt-curl',
    priorityId: armsPriority.id,
    metric: 'top_load_at_reps',
    exerciseId: 'curl',
    committedValue: 45,
    stretchValue: 50,
  });
  const curlView = view(armsPriority, curlTarget, [actual(2, 44), actual(3, 46)]); // ahead
  const hammerCurlTarget = target({
    id: 'tgt-hammer-curl',
    priorityId: armsPriority.id,
    metric: 'top_load_at_reps',
    exerciseId: 'hammer-curl',
    committedValue: 35,
    stretchValue: 40,
  });
  const hammerCurlView = view(armsPriority, hammerCurlTarget, [actual(2, 30), actual(3, 29)]); // behind
  const armsRollup = buildPriorityRollup([curlView, hammerCurlView])[0];

  const sessionsTarget = target({
    id: 'tgt-sessions',
    priorityId: benchPriority.id,
    metric: 'sessions_28d',
    exerciseId: undefined,
    anchorReps: undefined,
    committedValue: 12,
    stretchValue: 16,
  });
  const sessionsView = view(benchPriority, sessionsTarget, [actual(3, 9)]);

  const priorities: GoalPriorityRow[] = [
    { priority: benchPriority, targets: [benchTarget, sessionsTarget], rollup: null },
    { priority: armsPriority, targets: [curlTarget, hammerCurlTarget], rollup: armsRollup },
  ];
  const data: GoalsPageData = {
    priorities,
    progress: {
      [benchPriority.id]: [benchView, sessionsView],
      [armsPriority.id]: [curlView, hammerCurlView],
    },
  };
  return { data, benchPriority };
}

function render(data: GoalsPageData): string {
  return renderToStaticMarkup(createElement(GoalsView, { data }));
}

describe('GoalsView (VW-355)', () => {
  it('renders the priority header, per-lift table, muscle rollup and whole-body sections', () => {
    const html = render(baseData().data);

    expect(html).toContain('BENCH PRESS'); // priority header
    expect(html).toContain('Committed'); // MesoStatusCard metrics
    expect(html).toContain('CURL'); // per-lift table row
    expect(html).toContain('HAMMER CURL');
    expect(html).toContain('BICEPS'); // muscle rollup row
    expect(html).toContain('lifts on track');
    expect(html).toContain('Whole body');
    expect(html).toContain('Sessions (28d)');
  });

  it('hides the bodyweight tile with no bodyweight target at all (VW-327 not landed)', () => {
    const html = render(baseData().data);
    expect(html).not.toContain('Bodyweight');
  });

  it('hides the bodyweight tile when a bodyweight target exists but has no readings yet', () => {
    const { data, benchPriority } = baseData();
    const bwTarget = target({
      id: 'tgt-bw',
      priorityId: benchPriority.id,
      metric: 'bodyweight',
      exerciseId: undefined,
      anchorReps: undefined,
      committedValue: 195,
      stretchValue: 190,
    });
    const bwView = view(benchPriority, bwTarget, []);
    data.priorities[0]!.targets.push(bwTarget);
    data.progress[benchPriority.id]!.push(bwView);

    expect(render(data)).not.toContain('Bodyweight');
  });

  it('shows the bodyweight tile once a bodyweight target has a reading', () => {
    const { data, benchPriority } = baseData();
    const bwTarget = target({
      id: 'tgt-bw',
      priorityId: benchPriority.id,
      metric: 'bodyweight',
      exerciseId: undefined,
      anchorReps: undefined,
      committedValue: 195,
      stretchValue: 190,
    });
    const bwView = view(benchPriority, bwTarget, [actual(3, 192)]);
    data.priorities[0]!.targets.push(bwTarget);
    data.progress[benchPriority.id]!.push(bwView);

    expect(render(data)).toContain('Bodyweight');
  });

  it('renders an empty state with no priorities declared', () => {
    const html = render({ priorities: [], progress: {} });
    expect(html).toContain('No priorities declared');
  });
});
