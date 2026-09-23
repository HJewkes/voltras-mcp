// Render test for the `#/goals` wall page (VW-355, plan G8'; card grids VW-386;
// phone layout VW-356).
//
// Builds real `GoalProgressView`s with `buildGoalProgressView` (the same
// function `/api/goal-progress` calls) over literal bands, so the fixtures are
// exactly the shape the route returns — then renders `GoalsView` with
// `renderToStaticMarkup`, same technique as `spa-session-summary-e1rm-toggle.test.ts`.
// Asserts the sections plan G8' names and the hidden bodyweight tile.
//
// `useIsNarrowViewport` is mocked rather than driven by a real `matchMedia`:
// the suite runs under vitest's `node` environment (no `window`), so the real
// hook's own `typeof window === 'undefined'` guard would always report wide.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../spa/use-viewport.js', () => ({ useIsNarrowViewport: vi.fn(() => false) }));

import { useIsNarrowViewport } from '../spa/use-viewport.js';
import { GoalsView } from '../spa/goals/GoalsView.js';
import {
  cardChart,
  cardMilestone,
  liftRows,
  primaryTarget,
  type GoalsPageData,
} from '../spa/goals/goals-model.js';
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
    calibrationEvidence: { matchedSessionCount: 6, baselineState: 'CALIBRATED' },
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
    committedValue: 50,
    stretchValue: 55,
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

/**
 * One card's markup, from its own accessible label up to the next card's. The
 * cards publish `aria-label="<name> goal, <status>"`, which is the only handle
 * that survives their react-native-web class soup — and the one that says the
 * PR star belongs to THIS card rather than to some ancestor's PrBadge.
 */
function cardMarkup(html: string, label: string): string {
  const start = html.indexOf(`aria-label="${label}"`);
  expect(start).toBeGreaterThan(-1);
  const labels = [...html.matchAll(/aria-label="[^"]*goal[^"]*"/g)].map((m) => m.index);
  return html.slice(start, labels.find((index) => index > start) ?? html.length);
}

describe('GoalsView (VW-355)', () => {
  it('renders the lead goal card, both card grids and the whole-body section', () => {
    const html = render(baseData().data);

    expect(html).toContain('data-testid="goal-card-title"');
    expect(html).toContain('BENCH PRESS');
    expect(html).toContain('Per-lift');
    expect(html).toContain('Muscle priorities');
    expect(html).toContain('Whole body');
    expect(html).toContain('Sessions (28d)');
  });

  it('renders one lift card per exercise-tracked target, with its block-end target', () => {
    const html = render(baseData().data);

    expect(html).toContain('aria-label="BENCH PRESS goal, On track"');
    expect(html).toContain('aria-label="CURL goal, Behind"');
    expect(html).toContain('aria-label="HAMMER CURL goal, Behind"');
    // The committed set as reps x load, and the block's best against it (VW-400).
    const curl = cardMarkup(html, 'CURL goal, Behind');
    expect(curl).toContain('8 x 50 lb');
    expect(curl).toContain('8 x 46 lb');
    expect(curl).toContain('Week 3 of 6');
  });

  it('marks the PR on the lift card that set one, and only that card', () => {
    const html = render(baseData().data);

    expect(cardMarkup(html, 'BENCH PRESS goal, On track')).toContain('Personal record');
    expect(cardMarkup(html, 'CURL goal, Behind')).not.toContain('Personal record');
  });

  it('renders a muscle card with its figure, on-track count and contributing lifts', () => {
    const html = render(baseData().data);
    const card = cardMarkup(html, 'BICEPS goal rollup, Behind');

    expect(card).toContain('Biceps highlighted on the body map');
    expect(card).toContain('0/2 on track');
    expect(card).toContain('CURL');
    expect(card).toContain('HAMMER CURL');
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

describe('the lead lift is not repeated in Per-lift (VW-467 ruling)', () => {
  it('leaves the lead lift out of the per-lift rows', () => {
    const { data } = baseData();
    const leadId = primaryTarget(data)?.view.target.id;

    expect(leadId).toBe('tgt-bench');
    expect(liftRows(data).map((row) => row.view.target.id)).toEqual([
      'tgt-curl',
      'tgt-hammer-curl',
    ]);
  });

  it('shows the lead card and no Per-lift section on a page with one lift', () => {
    const { data, benchPriority } = baseData();
    const onlyBench: GoalsPageData = {
      priorities: [data.priorities[0]!],
      progress: { [benchPriority.id]: data.progress[benchPriority.id]! },
    };

    const html = render(onlyBench);

    expect(liftRows(onlyBench)).toEqual([]);
    expect(html).toContain('BENCH PRESS');
    expect(html).not.toContain('Per-lift');
  });

  it('removes nothing when no lift target leads', () => {
    const { data, benchPriority } = baseData();
    const sessionsOnly: GoalsPageData = {
      priorities: [{ ...data.priorities[0]!, targets: [data.priorities[0]!.targets[1]!] }],
      progress: { [benchPriority.id]: [data.progress[benchPriority.id]![1]!] },
    };

    expect(primaryTarget(sessionsOnly)).toBeNull();
    expect(liftRows(sessionsOnly)).toEqual([]);
  });
});

describe('GoalsView phone layout (VW-356)', () => {
  it('stacks the card grids to one full-width column below the narrow breakpoint', () => {
    vi.mocked(useIsNarrowViewport).mockReturnValue(true);
    try {
      const html = render(baseData().data);
      expect(html).not.toContain('auto-fill');
      // Lift grid + muscle grid. `minmax(0, 1fr)`, not `1fr`: a bare `1fr` floors the column
      // at the card's min-content, which held it wider than a phone (VW-454). Only the
      // captures prove the card then fits; this pins the rule that lets it.
      expect(html.match(/grid-template-columns:minmax\(0, 1fr\)/g)?.length).toBe(2);
      expect(html).not.toContain('grid-template-columns:1fr');
    } finally {
      vi.mocked(useIsNarrowViewport).mockReturnValue(false);
    }
  });

  it('titles the per-lift cards on the page background, not inside a panel (VW-435)', () => {
    const html = render(baseData().data);
    const section = /<section[^>]*>(.*?)<\/section>/s.exec(html)?.[1] ?? '';

    expect(section).toContain('Per-lift');
    expect(section).toContain('display:grid');
    // All caps by style, like the full card's heading, never by rewriting the string.
    expect(section).toMatch(/text-transform:uppercase[^>]*>Per-lift</);
  });

  it('lays the wall grids out as auto-fill columns', () => {
    const html = render(baseData().data);
    expect(html.match(/repeat\(auto-fill, minmax\(420px, 1fr\)\)/g)?.length).toBe(2);
  });
});

describe('the two block verdicts on the goals page (VW-400)', () => {
  it('passes goal_met straight through to the cards once a matched reading reaches committed', () => {
    const { data, benchPriority } = baseData();
    const benchTarget = data.priorities[0]!.targets[0]!;
    const met = view(benchPriority, benchTarget, [actual(2, 175), actual(3, 182.5)]);
    data.progress[benchPriority.id] = [met];

    expect(met.status).toBe('goal_met');
    expect(render(data)).toContain('aria-label="BENCH PRESS goal, Goal met"');
  });

  it("hands the summary the read model's block-end target, state and week cells", () => {
    const benchView = baseData().data.progress['pri-bench']![0]!;
    const milestone = cardMilestone(benchView);

    expect(milestone.target).toEqual({
      metric: 'top_load_at_reps',
      reps: 8,
      load: 183, // the stored 182.5 at the device's 1 lb step (VW-482)
      unit: 'lb',
    });
    expect(milestone.state).toBe(benchView.mesoMilestone.state);
    expect(milestone.weeks).toHaveLength(benchView.weekOutcomes.length);
  });
});

describe('a goal accepted while calibrating (VW-444)', () => {
  const SENTENCE =
    'Starting ramp, not yet based on your lifts. 1 more comparable session to calibrate.';

  it('states a calibrating lead lift only in its chart, since the lead is not repeated in Per-lift', () => {
    const { data, benchPriority } = baseData();
    const benchTarget = data.priorities[0]!.targets[0]!;
    const cold = view(
      benchPriority,
      { ...benchTarget, basis: 'execution_ramp', infoLevel: 'cold' },
      [actual(3, 174)],
    );
    data.progress[benchPriority.id] = [cold];

    const html = render(data);

    expect(cold.status).toBe('calibrating');
    expect(primaryTarget(data)?.view.target.id).toBe('tgt-bench');
    expect(html).not.toContain(SENTENCE);
    expect(cardChart(cold).calibratingNote).toBe('1 more comparable session to calibrate.');
  });

  it('says it once, under the compact card, for a calibrating lift that is not the lead', () => {
    const { data } = baseData();
    const arms = data.priorities[1]!;
    const hammerTarget = arms.targets[1]!;
    const cold = view(
      arms.priority,
      { ...hammerTarget, basis: 'execution_ramp', infoLevel: 'cold' },
      [actual(3, 29)],
    );
    data.progress[arms.priority.id] = [data.progress[arms.priority.id]![0]!, cold];

    const html = render(data);

    expect(cold.status).toBe('calibrating');
    expect(html.split(SENTENCE)).toHaveLength(2);
  });

  it('adds no calibration sentence once no target is calibrating', () => {
    expect(render(baseData().data)).not.toContain('to calibrate');
  });

  it('gives the chart its calibrating note from the same copy, and none once calibrated', () => {
    const { data, benchPriority } = baseData();
    const benchTarget = data.priorities[0]!.targets[0]!;
    const cold = view(
      benchPriority,
      { ...benchTarget, basis: 'execution_ramp', infoLevel: 'cold' },
      [actual(3, 174)],
    );
    const calibrated = data.progress[benchPriority.id]![0]!;

    expect(cardChart(cold).calibratingNote).toBe('1 more comparable session to calibrate.');
    expect(cardChart(calibrated)).not.toHaveProperty('calibratingNote');
  });
});

describe('a calibrated starting ramp (VW-444 part 2)', () => {
  function rampData(declined: boolean): GoalsPageData {
    const { data, benchPriority } = baseData();
    const benchTarget = data.priorities[0]!.targets[0]!;
    const ramp = buildGoalProgressView({
      priority: benchPriority,
      target: { ...benchTarget, basis: 'execution_ramp', infoLevel: 'cold' },
      band: BAND,
      calibrationEvidence: { matchedSessionCount: 3, baselineState: 'PROVISIONAL' },
      recalibrationDeclined: declined,
      actuals: [actual(1, 168), actual(2, 171), actual(3, 174)],
      weeks: WEEKS,
      now: WEEK_3,
      dietState: { phase: 'maintenance', weeksInPhase: 4 },
    });
    data.progress[benchPriority.id] = [ramp];
    return data;
  }

  it('says a target based on the lifts is ready under the lead card', () => {
    const line =
      'Calibrated. Your goal is still the starting ramp; a target based on your lifts is ready.';
    // Once: the lead card keeps it (its chart has no note once calibrated), and the lead
    // is not repeated in Per-lift.
    expect(render(rampData(false)).split(line)).toHaveLength(2);
  });

  it('shows no line at all once the lifter declined', () => {
    expect(render(rampData(true))).not.toContain('Calibrated');
  });
});
