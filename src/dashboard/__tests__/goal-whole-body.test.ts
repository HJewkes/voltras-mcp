// The whole-body read model on the goals payload (VW-459): direction from the
// band, the diet phase now, the rate `goal.weekly_review` judges, the session
// window, and the week-1 bodyweight band. Real store, real tools: every target
// here is derived and accepted the way the lifter's would be.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { log } from '../../logger.js';
import type { ServerState } from '../../state/server-state.js';
import { LOCAL_USER_ID } from '../../store/sqlite-store.js';
import type { StoredPriority } from '../../store/types.js';
import { registerGoalTools } from '../../tools/goal-tools.js';
import { fetchGoalProgressViews } from '../goal-progress-api.js';
import type { GoalProgressView } from '../read-models/index.js';
import { cardChart } from '../spa/goals/goals-model.js';
import { seedTrainingDay } from '../../__tests__/fixtures/training-day.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A Wednesday, so no case depends on the weekday the suite runs. */
const NOW = new Date('2026-09-16T12:00:00.000Z');
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * DAY_MS).toISOString();

type ToolResult = { content: { text: string }[]; isError?: boolean };
interface FakeTool {
  callback?: (args: unknown) => Promise<ToolResult>;
  update(updates: { callback: FakeTool['callback'] }): void;
}

const GOAL_TOOLS = [
  'goal.declare_priorities',
  'goal.propose_targets',
  'goal.accept_target',
  'goal.list',
  'goal.retire',
  'goal.new_chapter',
  'goal.weekly_review',
];

let store: SessionStore;
let tools: Map<string, FakeTool>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  store = openTestStore();
  tools = new Map();
  for (const name of GOAL_TOOLS) {
    const tool: FakeTool = { update: (u) => (tool.callback = u.callback) };
    tools.set(name, tool);
  }
  const state = { store, exercises: { list: () => [] } } as unknown as ServerState;
  registerGoalTools(
    undefined as unknown as Parameters<typeof registerGoalTools>[0],
    state,
    tools as unknown as Parameters<typeof registerGoalTools>[2],
  );
});
afterEach(async () => {
  await store.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function call(name: string, args: unknown): Promise<ToolResult> {
  return tools.get(name)!.callback!(args);
}

async function invoke(name: string, args: unknown): Promise<Record<string, unknown>> {
  const result = await call(name, args);
  if (result.isError === true) throw new Error(result.content[0]!.text);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

async function declarePhase(
  phase: 'fat-loss' | 'maintenance' | 'recomposition',
  startedDaysAgo: number,
  recompMode?: 'hold' | 'slow-loss',
): Promise<void> {
  await store.declareDietPhase({
    userId: LOCAL_USER_ID,
    phase,
    startedAt: daysAgo(startedDaysAgo),
    declaredAt: daysAgo(startedDaysAgo),
    ...(recompMode === undefined ? {} : { recompMode }),
  });
}

async function weighIn(lbs: number, ago: number): Promise<void> {
  await store.putBodyMetric({
    userId: LOCAL_USER_ID,
    measuredAt: daysAgo(ago),
    bodyweightLbs: lbs,
  });
}

/** Declare a whole-body priority, propose, accept the coach default, and read the page's view. */
async function acceptedView(ref: 'bodyweight' | 'sessions'): Promise<GoalProgressView> {
  const priority = await declare(ref);
  const proposed = await invoke('goal.propose_targets', { priorityId: priority.id });
  const [leg] = proposed.targets as { targetId: string }[];
  await invoke('goal.accept_target', { targetId: leg!.targetId });
  const [view] = await fetchGoalProgressViews(store, priority, NOW);
  return view!;
}

async function declare(ref: string): Promise<StoredPriority> {
  const declared = await invoke('goal.declare_priorities', {
    items: [{ kind: 'muscle', ref, level: 'maintain' }],
    horizonWeeks: 8,
  });
  return (declared.priorities as StoredPriority[])[0]!;
}

describe('direction comes from the band', () => {
  it('reads a maintenance hold as hold, not a gain', async () => {
    await declarePhase('maintenance', 14);
    await weighIn(180, 1);

    const view = await acceptedView('bodyweight');

    expect(view.committed).toBeLessThan(view.stretch);
    expect(view.direction).toBe('hold');
    expect(cardChart(view).direction).toBeUndefined();
  });

  it('reads slow-loss recomposition as down, though its committed edge is a hold', async () => {
    await declarePhase('recomposition', 14, 'slow-loss');
    await weighIn(180, 1);

    const view = await acceptedView('bodyweight');

    expect(view.committed).toBe(180);
    expect(view.stretch).toBeLessThan(180);
    expect(view.direction).toBe('down');
    expect(cardChart(view).direction).toBe('down');
  });
});

describe('the bodyweight view', () => {
  it('carries the diet phase now, not the phase the target was derived under', async () => {
    await declarePhase('maintenance', 60);
    await weighIn(180, 40);
    const priority = await declare('bodyweight');
    vi.setSystemTime(new Date(NOW.getTime() - 30 * DAY_MS));
    const proposed = await invoke('goal.propose_targets', { priorityId: priority.id });
    const [leg] = proposed.targets as { targetId: string }[];
    await invoke('goal.accept_target', { targetId: leg!.targetId });
    vi.setSystemTime(NOW);
    await declarePhase('recomposition', 15, 'hold');

    const [view] = await fetchGoalProgressViews(store, priority, NOW);

    expect(view!.target.dietPhaseAtDerivation).toBe('maintenance');
    expect(view!.bodyweight?.dietPhase).toEqual({
      phase: 'recomposition',
      weeksInPhase: 3,
      recompMode: 'hold',
    });
  });

  it('reports the same rate goal.weekly_review judges', async () => {
    await declarePhase('fat-loss', 70);
    for (let day = 69; day >= 0; day--) await weighIn(200 - 0.0015 * (69 - day) ** 2, day);
    const view = await acceptedView('bodyweight');

    const review = await invoke('goal.weekly_review', {});

    const observation = review.observation as Record<string, unknown>;
    expect(view.bodyweight?.rate).toEqual({
      observedPctPerWeek: observation.observedPctPerWeek,
      bandLowPctPerWeek: observation.bandLowPctPerWeek,
      bandHighPctPerWeek: observation.bandHighPctPerWeek,
      weeksOutsideBand: observation.weeksOutsideBand,
      vetoed: (review.vetoes as unknown[]).length > 0,
    });
    expect(view.bodyweight?.rate?.observedPctPerWeek).not.toBeNull();
  });

  it('returns an accepted bodyweight target that has no readings left', async () => {
    await declarePhase('fat-loss', 60);
    await weighIn(200, 50);
    const priority = await declare('bodyweight');
    vi.setSystemTime(new Date(NOW.getTime() - 49 * DAY_MS));
    const proposed = await invoke('goal.propose_targets', { priorityId: priority.id });
    await invoke('goal.accept_target', {
      targetId: (proposed.targets as { targetId: string }[])[0]!.targetId,
    });
    vi.setSystemTime(NOW);

    const [view] = await fetchGoalProgressViews(store, priority, NOW);

    expect(view?.target.metric).toBe('bodyweight');
    expect(view?.actuals).toEqual([]);
  });
});

describe('week 1 of a bodyweight rate band', () => {
  it('opens from the start weight to the end of the first week’s stretch step', async () => {
    await declarePhase('fat-loss', 0);
    await weighIn(200, 0);

    const view = await acceptedView('bodyweight');

    expect(view.expected[0]).toEqual({ weekIndex: 1, low: 200, high: view.expected[1]!.high });
    expect(view.expected[1]!.high).toBe(198);
    expect(view.weekOutcomes[0]?.outcome).toBe('on_track');
  });

  it('still reads a cut’s first weigh-in above the start weight as behind the committed edge', async () => {
    await declarePhase('fat-loss', 0);
    await weighIn(200, 0);
    const view = await acceptedView('bodyweight');
    await weighIn(200.4, -0.01);

    const [later] = await fetchGoalProgressViews(
      store,
      view.priority,
      new Date(NOW.getTime() + DAY_MS),
    );

    expect(later!.weekOutcomes[0]?.outcome).not.toBe('on_track');
  });
});

describe('the sessions view', () => {
  it('counts due-by-now, the training days and the days leaving the window, from the view’s now', async () => {
    for (const ago of [25, 22, 10, 2]) {
      await seedTrainingDay(store, {
        kind: 'training',
        id: `s-${ago}`,
        startedAt: daysAgo(ago),
        endedAt: daysAgo(ago - 0.01),
      });
    }
    await seedTrainingDay(store, {
      kind: 'training',
      id: 's-10b',
      startedAt: daysAgo(9.99),
      endedAt: daysAgo(9.98),
    });
    const accepted = await acceptedView('sessions');
    const viewNow = new Date(NOW.getTime() + 3.5 * DAY_MS);

    const [view] = await fetchGoalProgressViews(store, accepted.priority, viewNow);

    expect(accepted.committed).toBe(4);
    expect(view!.sessions).toEqual({
      dueByNow: 0.5,
      sessionDays: [daysAgo(21.99), daysAgo(9.99), daysAgo(1.99)].map(localDay),
      agingOutNext7d: 1,
    });
  });
});

describe('goal.declare_priorities', () => {
  it('refuses a second whole-body priority with the same ref', async () => {
    await declare('bodyweight');

    const result = await call('goal.declare_priorities', {
      items: [{ kind: 'muscle', ref: 'Bodyweight', level: 'specialize' }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('GOAL_WHOLE_BODY_PRIORITY_EXISTS');
  });

  it('refuses the same whole-body ref twice in one declaration', async () => {
    const result = await call('goal.declare_priorities', {
      items: [
        { kind: 'muscle', ref: 'sessions', level: 'maintain' },
        { kind: 'muscle', ref: 'sessions', level: 'specialize' },
      ],
    });

    expect(result.content[0]!.text).toContain('GOAL_WHOLE_BODY_PRIORITY_EXISTS');
  });

  it('still lets the same ref be re-declared to change its level', async () => {
    const first = await declare('sessions');

    const again = await invoke('goal.declare_priorities', {
      items: [{ kind: 'muscle', ref: 'sessions', level: 'specialize' }],
    });

    expect((again.priorities as StoredPriority[])[0]!.id).toBe(first.id);
  });
});

describe('a target whose band cannot be re-derived', () => {
  it('is logged at warn, not debug', async () => {
    const warn = vi.spyOn(log, 'warn');
    const priority = await declare('bodyweight');
    await store.putGoalTarget({
      id: 'tgt-lift',
      priorityId: priority.id,
      metric: 'top_load_at_reps',
      exerciseId: 'bench-press',
      anchorReps: 5,
      startValue: 0,
      startMeasuredAt: daysAgo(7),
      bandLowPctPerWeek: 1,
      bandHighPctPerWeek: 2,
      committedValue: 100,
      stretchValue: 110,
      basis: 'rp_ramp',
      infoLevel: 'ramp',
      tierUsed: 'intermediate',
      tierProvisional: false,
      dietPhaseAtDerivation: 'maintenance',
      acceptedBy: 'user',
      acknowledgedStretch: false,
      derivedAt: daysAgo(7),
      endsAt: daysAgo(-49),
    });

    await fetchGoalProgressViews(store, priority, NOW);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("'tgt-lift' band could not be re-derived"),
    );
  });
});

function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('a slow-loss recomposition on the page (VW-468)', () => {
  const WEEK_MS = 7 * DAY_MS;

  /** Accept a 190 lb slow-loss goal at `NOW`, weigh in `lbs` in block week `week`, and read that week. */
  async function viewWith(lbs: number, week: number): Promise<GoalProgressView> {
    await declarePhase('recomposition', 60, 'slow-loss');
    await weighIn(190, 0);
    const priority = await declare('bodyweight');
    const proposed = await invoke('goal.propose_targets', { priorityId: priority.id });
    const [leg] = proposed.targets as { targetId: string }[];
    await invoke('goal.accept_target', { targetId: leg!.targetId });
    const at = new Date(NOW.getTime() + (week - 1) * WEEK_MS + DAY_MS);
    vi.setSystemTime(at);
    await store.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: at.toISOString(),
      bodyweightLbs: lbs,
    });
    const [view] = await fetchGoalProgressViews(store, priority, at);
    return view!;
  }

  const outcomeOfWeek = (view: GoalProgressView, week: number) =>
    view.weekOutcomes.find((entry) => entry.weekIndex === week)?.outcome;

  it('reads a flat week a few tenths over the start as holding', async () => {
    expect(outcomeOfWeek(await viewWith(190.3, 3), 3)).toBe('on_track');
  });

  it('reads a week a pound over the start as missed', async () => {
    expect(outcomeOfWeek(await viewWith(191.2, 3), 3)).toBe('missed');
  });

  it('does not call the hold met on an early reading', async () => {
    const view = await viewWith(189.8, 3);
    expect(view.status).not.toBe('goal_met');
    expect(view.status).not.toBe('beyond_goal');
  });

  it('calls the hold met on the final week’s reading', async () => {
    expect((await viewWith(189.9, 8)).status).toBe('goal_met');
  });

  it('calls a final week past the noise floor under the start beyond the goal', async () => {
    expect((await viewWith(188.5, 8)).status).toBe('beyond_goal');
  });

  it('does not call the hold met when the final week ends heavy', async () => {
    const view = await viewWith(191.4, 8);
    expect(view.status).not.toBe('goal_met');
    expect(view.status).not.toBe('beyond_goal');
  });
});
