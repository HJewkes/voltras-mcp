// Route-level tests for `GET /api/goals` and `GET /api/goal-progress` (VW-352,
// G5 of the goal-coach plan).
//
// Runs the real `node:http` server against an in-memory store fake, so the
// band re-derivation, the plan-tree-shaped 404 and the 501 gate are exercised
// end to end. The pure per-target projection is covered separately in
// `goal-progress-read-model.test.ts`.

import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { EMPTY_PHASE } from '@voltras/workout-analytics';

import {
  DEFAULT_DASHBOARD_HOST,
  startDashboardServer,
  type DashboardServerHandle,
  type DashboardServerState,
} from '../server.js';
import type {
  StoredBlockSchedule,
  ExerciseSetsFilter,
  GoalTargetSelector,
  ListGoalTargetsOptions,
  StoredGoalTarget,
  StoredPriority,
  StoredRep,
  StoredSession,
  StoredSet,
  SessionReviewRow,
  StoredTrainingProfile,
} from '../../store/types.js';

/** A rep with no measurable movement — enough for a rep count, never a fatigue verdict. */
function makeRep(setId: string, index: number): StoredRep {
  return {
    id: `${setId}-rep-${index}`,
    setId,
    index,
    repNumber: index + 1,
    concentric: { ...EMPTY_PHASE },
    eccentric: { ...EMPTY_PHASE },
  };
}

const handles: DashboardServerHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    await handles
      .pop()
      ?.close()
      .catch(() => undefined);
  }
});

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function storedSet(over: Partial<StoredSet> & { id: string }): StoredSet {
  return {
    sessionId: 'ses-1',
    startedAt: daysAgo(7),
    endedAt: daysAgo(7),
    partial: false,
    weightLbs: 100,
    reps: Array.from({ length: 8 }, (_, i) => makeRep(over.id, i)),
    ...over,
  } as StoredSet;
}

/** One working set per named week, so each lands in its own weekly bucket. */
function historyAt(exerciseId: string, readings: { daysBack: number; weightLbs: number }[]) {
  return readings.map((reading, index) =>
    storedSet({
      id: `${exerciseId}-at-${index}`,
      sessionId: `ses-${exerciseId}-at-${index}`,
      exerciseId,
      startedAt: daysAgo(reading.daysBack),
      endedAt: daysAgo(reading.daysBack),
      weightLbs: reading.weightLbs,
    }),
  );
}

/** A month of weekly working sets, so `history.trend` has points to fit. */
function weeklyHistory(exerciseId: string): StoredSet[] {
  return [0, 1, 2, 3].map((week) =>
    storedSet({
      id: `${exerciseId}-${week}`,
      sessionId: `ses-${exerciseId}-${week}`,
      exerciseId,
      startedAt: daysAgo(28 - week * 7),
      endedAt: daysAgo(28 - week * 7),
      weightLbs: 180 + week * 5,
    }),
  );
}

function priority(over: Partial<StoredPriority> & { id: string }): StoredPriority {
  return {
    userId: 'local',
    horizonWeeks: 0,
    kind: 'lift',
    ref: 'bench-press',
    level: 'specialize',
    declaredAt: daysAgo(30),
    mesosHeld: 1,
    ...over,
  };
}

function target(
  over: Partial<StoredGoalTarget> & { id: string; priorityId: string },
): StoredGoalTarget {
  return {
    metric: 'top_load_at_reps',
    exerciseId: 'bench-press',
    anchorReps: 8,
    startValue: 180,
    startMeasuredAt: daysAgo(28),
    bandLowPctPerWeek: 0,
    bandHighPctPerWeek: 1,
    committedValue: 190,
    stretchValue: 200,
    basis: 'rp_ramp',
    infoLevel: 'ramp',
    tierUsed: 'beginner',
    tierProvisional: false,
    dietPhaseAtDerivation: 'maintenance',
    acceptedBy: 'user',
    acknowledgedStretch: false,
    derivedAt: daysAgo(28),
    endsAt: daysAgo(-56),
    ...over,
  };
}

/** In-memory implementation of every store method the goal-coach routes touch. */
class FakeStore {
  constructor(
    private readonly priorities: StoredPriority[],
    private readonly targets: StoredGoalTarget[],
    private readonly sets: StoredSet[],
  ) {}

  listPriorities = async (): Promise<StoredPriority[]> =>
    this.priorities.filter((p) => p.retiredAt === undefined);

  listGoalTargets = async (
    selector: GoalTargetSelector,
    options?: ListGoalTargetsOptions,
  ): Promise<StoredGoalTarget[]> =>
    this.targets.filter(
      (t) =>
        'priorityId' in selector &&
        t.priorityId === selector.priorityId &&
        (options?.includeRetired === true || t.retiredAt === undefined),
    );

  getTrainingProfile = async (): Promise<StoredTrainingProfile | undefined> => undefined;
  countSessions = async (): Promise<number> => new Set(this.sets.map((s) => s.sessionId)).size;
  listTrainingDayInstants = async (): Promise<string[]> => this.sets.map((s) => s.endedAt);
  // VW-489: this fake's rows stand for reviewed history, so nothing is pending.
  listSessionReviewRows = async (): Promise<SessionReviewRow[]> => [];
  getSessionDateSpan = async (): Promise<{ first: string | null; last: string | null }> => ({
    first: daysAgo(28),
    last: daysAgo(0),
  });
  getTrainingWeeksForBlock = async () => [];
  getDietPhaseCovering = async () => undefined;
  getTrainingBlock = async () => undefined;
  // VW-480: the payload's `mesocycle`. Undated until `dateBlock` is called.
  private dated: StoredBlockSchedule | undefined;

  dateBlock(startsOn: string, weeksCount: number): void {
    this.dated = {
      id: 'sched',
      blockId: 'blk',
      seq: 1,
      startsOn,
      weeksCount,
      skips: [],
      kind: 'planned',
      changedBy: 'user',
      declaredAt: daysAgo(1),
    };
  }

  listTrainingPrograms = async () =>
    this.dated === undefined
      ? []
      : [{ id: 'prog', name: 'Voltra Return — 2026', createdAt: daysAgo(90) }];
  getTrainingBlocksForProgram = async () =>
    this.dated === undefined
      ? []
      : [{ id: 'blk', programId: 'prog', orderIndex: 0, name: 'Block 2', weeksCount: 2 }];
  getLiveBlockSchedule = async () => this.dated;
  getWorkoutTemplatesForWeek = async () => [];
  getAssignmentsForTemplate = async () => [];
  listBodyMetrics = async () => [];
  getBaseline = async () => undefined;
  chapterStartedAt = async () => null;

  listSessions = async (filter: { from?: string; to?: string }): Promise<StoredSession[]> =>
    [...new Set(this.sets.map((s) => s.sessionId))]
      .map((id) => ({ id, startedAt: this.sets.find((s) => s.sessionId === id)!.startedAt }))
      .filter(
        (s) =>
          (filter.from === undefined || s.startedAt >= filter.from) &&
          (filter.to === undefined || s.startedAt < filter.to),
      );

  getSetsForSession = async (sessionId: string): Promise<StoredSet[]> =>
    this.sets.filter((s) => s.sessionId === sessionId);

  getSetsForExercise = async (filter: ExerciseSetsFilter): Promise<StoredSet[]> =>
    this.sets.filter((s) => s.exerciseId === filter.exerciseId);
}

function makeState(store: FakeStore): DashboardServerState {
  return { slots: new Map(), store: store as unknown as DashboardServerState['store'] };
}

interface Result {
  status: number;
  body: unknown;
}

async function call(port: number, path: string): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    const req = httpRequest(
      { host: DEFAULT_DASHBOARD_HOST, port, path, method: 'GET' },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text === '' ? null : JSON.parse(text) });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function start(state: DashboardServerState): Promise<number> {
  const handle = await startDashboardServer({ port: 0, state });
  handles.push(handle);
  return handle.port;
}

interface GoalProgressBody {
  targets: {
    priority: { id: string };
    target: { id: string };
    status: string;
    actuals: { ts: string; value: number; isPR: boolean }[];
    nextMilestone: {
      label: string;
      value: number;
      dueWeek: number;
      reps: number;
      load: number;
      unit: string;
      goalWeek: number;
    };
  }[];
}

interface GoalsBody {
  priorities: {
    priority: { id: string };
    targets: { id: string }[];
    rollup: { status: string } | null;
  }[];
  mesocycle: { programName: string; blockName: string; state: string } | null;
  review: { unreviewedDays: number; unreviewedDayList: string[] };
}

/** The Monday of the current local week: a block dated from it is in progress today. */
function mondayThisWeek(): string {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

describe('GET /api/goal-progress', () => {
  it('returns a progress view per target under the priority', async () => {
    const pri = priority({ id: 'pri-1' });
    const tgt = target({ id: 'tgt-1', priorityId: 'pri-1' });
    const store = new FakeStore([pri], [tgt], weeklyHistory('bench-press'));

    const port = await start(makeState(store));
    const res = await call(port, '/api/goal-progress?priorityId=pri-1');
    expect(res.status).toBe(200);

    const body = res.body as GoalProgressBody;
    expect(body.targets).toHaveLength(1);
    expect(body.targets[0]).toMatchObject({
      priority: { id: 'pri-1' },
      target: { id: 'tgt-1' },
    });
    expect(typeof body.targets[0]?.status).toBe('string');
    const milestone = body.targets[0]?.nextMilestone;
    expect(milestone).toMatchObject({
      label: expect.any(String),
      value: expect.any(Number),
      dueWeek: expect.any(Number),
      reps: expect.any(Number),
      load: expect.any(Number),
      unit: 'lb',
      goalWeek: expect.any(Number),
    });
    expect(milestone?.goalWeek).toBe(milestone?.dueWeek);
  });

  it('marks the reading that passed every earlier one in the window, and only that one', async () => {
    const pri = priority({ id: 'pri-1' });
    const tgt = target({ id: 'tgt-1', priorityId: 'pri-1' });
    const store = new FakeStore(
      [pri],
      [tgt],
      historyAt('bench-press', [
        { daysBack: 21, weightLbs: 180 },
        { daysBack: 14, weightLbs: 175 },
        { daysBack: 7, weightLbs: 185 },
      ]),
    );

    const port = await start(makeState(store));
    const body = (await call(port, '/api/goal-progress?priorityId=pri-1')).body as GoalProgressBody;

    expect(body.targets[0]?.actuals.map((a) => [a.value, a.isPR])).toEqual([
      [180, false],
      [175, false],
      [185, true],
    ]);
  });

  it('does not call a repeated load a record', async () => {
    const pri = priority({ id: 'pri-1' });
    const tgt = target({ id: 'tgt-1', priorityId: 'pri-1' });
    const store = new FakeStore(
      [pri],
      [tgt],
      historyAt('bench-press', [
        { daysBack: 14, weightLbs: 180 },
        { daysBack: 7, weightLbs: 180 },
      ]),
    );

    const port = await start(makeState(store));
    const body = (await call(port, '/api/goal-progress?priorityId=pri-1')).body as GoalProgressBody;

    expect(body.targets[0]?.actuals.map((a) => a.isPR)).toEqual([false, false]);
  });

  it('does not treat a load from before the lookback window as an earlier reading', async () => {
    const pri = priority({ id: 'pri-1' });
    const tgt = target({ id: 'tgt-1', priorityId: 'pri-1' });
    const store = new FakeStore(
      [pri],
      [tgt],
      historyAt('bench-press', [
        { daysBack: 140, weightLbs: 400 },
        { daysBack: 14, weightLbs: 180 },
        { daysBack: 7, weightLbs: 185 },
      ]),
    );

    const port = await start(makeState(store));
    const body = (await call(port, '/api/goal-progress?priorityId=pri-1')).body as GoalProgressBody;

    expect(body.targets[0]?.actuals.map((a) => [a.value, a.isPR])).toEqual([
      [180, false],
      [185, true],
    ]);
  });

  it('never marks a rolling session count as a record', async () => {
    const pri = priority({ id: 'pri-1', kind: 'muscle', ref: 'chest' });
    const tgt = target({
      id: 'tgt-1',
      priorityId: 'pri-1',
      metric: 'sessions_28d',
      exerciseId: undefined,
      anchorReps: undefined,
    });
    const store = new FakeStore([pri], [tgt], weeklyHistory('bench-press'));

    const port = await start(makeState(store));
    const body = (await call(port, '/api/goal-progress?priorityId=pri-1')).body as GoalProgressBody;

    expect(body.targets[0]?.actuals.every((a) => a.isPR === false)).toBe(true);
  });

  it('404s the plan-tree shape for an unknown priorityId', async () => {
    const store = new FakeStore([], [], []);
    const port = await start(makeState(store));

    const res = await call(port, '/api/goal-progress?priorityId=nope');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('400s when priorityId is missing', async () => {
    const store = new FakeStore([], [], []);
    const port = await start(makeState(store));

    const res = await call(port, '/api/goal-progress');

    expect(res.status).toBe(400);
  });

  it('names the dated block the page is in (VW-480)', async () => {
    const store = new FakeStore([priority({ id: 'pri-1' })], [], weeklyHistory('bench-press'));
    store.dateBlock(mondayThisWeek(), 2);

    const port = await start(makeState(store));
    const body = (await call(port, '/api/goals')).body as GoalsBody;

    expect(body.mesocycle).toMatchObject({
      programName: 'Voltra Return — 2026',
      blockName: 'Block 2',
      state: 'current',
      week: { n: 1, of: 2 },
    });
  });

  it('501s when the wired store carries no goal-read methods', async () => {
    const port = await start({ slots: new Map(), store: { listSessions: async () => [] } });
    const res = await call(port, '/api/goal-progress?priorityId=pri-1');
    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: 'goal_store_unavailable' });
  });
});

describe('GET /api/goals', () => {
  it('lists declared priorities with their accepted targets and a rollup', async () => {
    const pri = priority({ id: 'pri-1' });
    const tgt = target({ id: 'tgt-1', priorityId: 'pri-1', acceptedBy: 'user' });
    const store = new FakeStore([pri], [tgt], weeklyHistory('bench-press'));

    const port = await start(makeState(store));
    const res = await call(port, '/api/goals');
    expect(res.status).toBe(200);

    const body = res.body as GoalsBody;
    expect(body.priorities).toHaveLength(1);
    expect(body.priorities[0]?.priority.id).toBe('pri-1');
    expect(body.priorities[0]?.targets.map((t) => t.id)).toEqual(['tgt-1']);
    expect(typeof body.priorities[0]?.rollup?.status).toBe('string');
  });

  // VW-489: every count on the page excludes unreviewed history, so the payload
  // carries the number of days waiting. Server field only — the page reads it in
  // its own change.
  it('carries the unreviewed-day count for the page to explain a zero with', async () => {
    const store = new FakeStore([priority({ id: 'pri-1' })], [], weeklyHistory('bench-press'));

    const port = await start(makeState(store));
    const body = (await call(port, '/api/goals')).body as GoalsBody;

    expect(body.review).toEqual({ unreviewedDays: 0, unreviewedDayList: [] });
  });

  it('carries a null mesocycle while no block has dates (VW-480)', async () => {
    const store = new FakeStore([priority({ id: 'pri-1' })], [], weeklyHistory('bench-press'));

    const port = await start(makeState(store));
    const body = (await call(port, '/api/goals')).body as GoalsBody;

    expect(body.mesocycle).toBeNull();
  });

  it('reports a null rollup when no target under a priority is accepted', async () => {
    const pri = priority({ id: 'pri-1' });
    const tgt = target({ id: 'tgt-1', priorityId: 'pri-1', acceptedBy: undefined });
    const store = new FakeStore([pri], [tgt], weeklyHistory('bench-press'));

    const port = await start(makeState(store));
    const body = (await call(port, '/api/goals')).body as GoalsBody;

    expect(body.priorities[0]?.targets).toEqual([]);
    expect(body.priorities[0]?.rollup).toBeNull();
  });

  it('names the dated block the page is in (VW-480)', async () => {
    const store = new FakeStore([priority({ id: 'pri-1' })], [], weeklyHistory('bench-press'));
    store.dateBlock(mondayThisWeek(), 2);

    const port = await start(makeState(store));
    const body = (await call(port, '/api/goals')).body as GoalsBody;

    expect(body.mesocycle).toMatchObject({
      programName: 'Voltra Return — 2026',
      blockName: 'Block 2',
      state: 'current',
      week: { n: 1, of: 2 },
    });
  });

  it('501s when the wired store carries no goal-read methods', async () => {
    const port = await start({ slots: new Map(), store: { listSessions: async () => [] } });
    const res = await call(port, '/api/goals');
    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: 'goal_store_unavailable' });
  });
});
