// `/api/session-plan` derived fallback (VW-642): with no attachment covering the
// active exercise, the route derives targets from the lifter's last training
// session of it, on a real scratch store so the store's own scoping is exercised.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { Phase } from '@voltras/workout-analytics';

import {
  DEFAULT_DASHBOARD_HOST,
  startDashboardServer,
  type DashboardServerState,
} from '../server.js';
import type { PrescriptionView } from '../read-models/session-plan.js';
import type { ActiveSession } from '../../state/live-state.js';
import {
  LOCAL_USER_ID,
  type SetPurpose,
  type StoredRep,
  type StoredSet,
} from '../../store/types.js';
import type { SessionKind } from '../../store/session-kind.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

const EXERCISE = 'bench';
const LIVE_ID = 'sess-live';
const LIVE_START = '2026-05-15T10:00:00.000Z';
const LAST_START = '2026-05-08T10:00:00.000Z';

interface SeedSet {
  reps: number;
  weightLbs: number;
  setPurpose?: SetPurpose;
  lifter?: string;
}

const PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 0,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  _peakVelocityTime: 0,
  _lastMovementVelocity: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

function reps(setId: string, count: number): StoredRep[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${setId}-r${String(index)}`,
    setId,
    index,
    repNumber: index + 1,
    concentric: PHASE,
    eccentric: PHASE,
  }));
}

function storedSet(sessionId: string, index: number, at: string, seed: SeedSet): StoredSet {
  const id = `${sessionId}-s${String(index)}`;
  return {
    id,
    sessionId,
    userId: LOCAL_USER_ID,
    exerciseId: EXERCISE,
    startedAt: new Date(Date.parse(at) + index * 60_000).toISOString(),
    endedAt: at,
    partial: false,
    setIndexInSession: index + 1,
    weightLbs: seed.weightLbs,
    reps: reps(id, seed.reps),
    ...(seed.setPurpose !== undefined && { setPurpose: seed.setPurpose }),
    ...(seed.lifter !== undefined && { lifter: seed.lifter }),
  };
}

async function seed(
  store: SessionStore,
  id: string,
  startedAt: string,
  sets: SeedSet[],
  options: { kind?: SessionKind; lifter?: string; open?: boolean } = {},
): Promise<void> {
  await store.putSession({
    id,
    startedAt,
    ...(options.open !== true && { endedAt: startedAt }),
    exerciseId: EXERCISE,
    kind: options.kind ?? 'training',
    ...(options.lifter !== undefined && { lifter: options.lifter }),
  });
  for (const [index, s] of sets.entries()) {
    await store.putSet(
      storedSet(id, index, startedAt, { ...s, lifter: s.lifter ?? options.lifter }),
    );
  }
}

const WORKING = [
  { reps: 10, weightLbs: 40, setPurpose: 'warmup' as const },
  { reps: 10, weightLbs: 130 },
  { reps: 9, weightLbs: 135 },
  { reps: 8, weightLbs: 135 },
];

function liveSession(id: string, startedAt: string, lifter?: string): ActiveSession {
  return {
    sessionId: id,
    startedAt,
    exerciseId: EXERCISE,
    exerciseName: 'Bench',
    setIds: [],
    status: 'active',
    ...(lifter !== undefined && { lifter }),
  };
}

function stateFor(store: SessionStore, sessions: ActiveSession[]): DashboardServerState {
  const slotNames = ['left', 'right'];
  return {
    slots: new Map(
      sessions.map((session, i) => [
        slotNames[i] ?? `slot-${String(i)}`,
        {
          live: {
            snapshotDevice: () => ({ connected: false }),
            snapshotSession: () => session,
            snapshotSet: () => undefined,
          },
        },
      ]),
    ),
    exercises: { getById: () => ({ name: 'Bench Press', muscleGroups: [] }) },
    store,
  };
}

function getJson(port: number, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: DEFAULT_DASHBOARD_HOST, port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchPlan(state: DashboardServerState): Promise<PrescriptionView | null> {
  const handle = await startDashboardServer({ port: 0, state });
  try {
    return ((await getJson(handle.port, '/api/session-plan')) as { plan: PrescriptionView | null })
      .plan;
  } finally {
    await handle.close();
  }
}

describe('/api/session-plan derived fallback (VW-642)', () => {
  let store: SessionStore;

  beforeEach(async () => {
    store = openTestStore();
    await seed(store, LIVE_ID, LIVE_START, [], { open: true });
  });

  afterEach(async () => {
    await store.close();
  });

  it("derives the owner's targets from last time's working sets, labelled and with no intent", async () => {
    await seed(store, 'sess-last', LAST_START, WORKING);

    const plan = await fetchPlan(stateFor(store, [liveSession(LIVE_ID, LIVE_START)]));

    expect(plan).toMatchObject({
      source: 'derived',
      derivedFrom: { startedAt: LAST_START, daysAgo: 7, stale: false },
      sets: 3,
      repsLow: 8,
      repsHigh: 10,
      weightLbs: 135,
    });
    expect(plan?.exercises).toHaveLength(1);
    for (const key of ['rpe', 'restSec', 'goalKind', 'velocityLossPct', 'tempo', 'title']) {
      expect(plan).not.toHaveProperty(key);
    }
  });

  it('marks last time stale when the live session starts 26 days after it', async () => {
    await seed(store, 'sess-last', LAST_START, WORKING);
    const lateStart = '2026-06-03T10:00:00.000Z';

    const plan = await fetchPlan(stateFor(store, [liveSession(LIVE_ID, lateStart)]));

    expect(plan?.derivedFrom).toEqual({ startedAt: LAST_START, daysAgo: 26, stale: true });
  });

  it("never feeds a guest's history to the owner, nor the owner's to a guest", async () => {
    await seed(store, 'sess-guest', LAST_START, WORKING, { lifter: 'Sam' });

    const owner = await fetchPlan(stateFor(store, [liveSession(LIVE_ID, LIVE_START)]));
    const guest = await fetchPlan(stateFor(store, [liveSession(LIVE_ID, LIVE_START, 'Sam')]));
    const otherGuest = await fetchPlan(stateFor(store, [liveSession(LIVE_ID, LIVE_START, 'Ana')]));

    expect(owner).toBeNull();
    expect(guest).toMatchObject({ source: 'derived', sets: 3, weightLbs: 135 });
    expect(otherGuest).toBeNull();
  });

  it("reaches past a newer guest session to the owner's own last time", async () => {
    await seed(store, 'sess-owner', '2026-05-01T10:00:00.000Z', [{ reps: 6, weightLbs: 120 }]);
    await seed(store, 'sess-guest', LAST_START, WORKING, { lifter: 'Sam' });

    const plan = await fetchPlan(stateFor(store, [liveSession(LIVE_ID, LIVE_START)]));

    expect(plan).toMatchObject({
      derivedFrom: { startedAt: '2026-05-01T10:00:00.000Z' },
      sets: 1,
      repsLow: 6,
      weightLbs: 120,
    });
  });

  it('drops a guest set inside an owner session from the derivation', async () => {
    await seed(store, 'sess-last', LAST_START, [
      { reps: 8, weightLbs: 100 },
      { reps: 3, weightLbs: 200, lifter: 'Sam' },
    ]);

    const plan = await fetchPlan(stateFor(store, [liveSession(LIVE_ID, LIVE_START)]));

    expect(plan).toMatchObject({ sets: 1, repsLow: 8, weightLbs: 100 });
  });

  it('skips test and unreviewed sessions', async () => {
    await seed(store, 'sess-old', '2026-05-01T10:00:00.000Z', [{ reps: 6, weightLbs: 120 }]);
    await seed(store, 'sess-test', '2026-05-09T10:00:00.000Z', WORKING, { kind: 'test' });
    await store.putSession({ id: 'sess-unreviewed', startedAt: '2026-05-10T10:00:00.000Z' });
    await store.putSet(
      storedSet('sess-unreviewed', 0, '2026-05-10T10:00:00.000Z', { reps: 5, weightLbs: 300 }),
    );

    const plan = await fetchPlan(stateFor(store, [liveSession(LIVE_ID, LIVE_START)]));

    expect(plan).toMatchObject({
      derivedFrom: { startedAt: '2026-05-01T10:00:00.000Z' },
      weightLbs: 120,
    });
  });

  it("excludes the open session and the other slot's open session", async () => {
    await seed(store, 'sess-last', LAST_START, WORKING);
    await seed(
      store,
      'sess-other-slot',
      '2026-05-15T09:59:00.000Z',
      [{ reps: 4, weightLbs: 250 }],
      {
        open: true,
      },
    );
    await store.putSet(storedSet(LIVE_ID, 0, LIVE_START, { reps: 3, weightLbs: 300 }));

    const plan = await fetchPlan(
      stateFor(store, [
        liveSession(LIVE_ID, LIVE_START),
        liveSession('sess-other-slot', '2026-05-15T09:59:00.000Z'),
      ]),
    );

    expect(plan).toMatchObject({ derivedFrom: { startedAt: LAST_START }, weightLbs: 135 });
  });

  it('lets an attached plan row win over history', async () => {
    await seed(store, 'sess-last', LAST_START, WORKING);
    await store.putTrainingProgram({ id: 'prog', name: 'P', createdAt: LAST_START });
    await store.putTrainingBlock({
      id: 'blk',
      programId: 'prog',
      orderIndex: 0,
      name: 'B',
      weeksCount: 1,
    });
    await store.putTrainingWeek({ id: 'wk', blockId: 'blk', orderIndex: 0, isDeload: false });
    await store.putWorkoutTemplate({ id: 'tpl', weekId: 'wk', name: 'Push', orderIndex: 0 });
    await store.putPlannedExercise({
      id: 'pe',
      workoutTemplateId: 'tpl',
      exerciseId: EXERCISE,
      orderIndex: 0,
      targetSets: 5,
      targetRepsLow: 5,
    });
    await store.putProgramAssignment({
      id: 'a',
      sessionId: LIVE_ID,
      plannedExerciseId: 'pe',
      assignedAt: LIVE_START,
    });

    const plan = await fetchPlan(stateFor(store, [liveSession(LIVE_ID, LIVE_START)]));

    expect(plan).toMatchObject({ source: 'prescribed', sets: 5, repsLow: 5 });
    expect(plan).not.toHaveProperty('derivedFrom');
  });

  it('returns null when nothing is known', async () => {
    await seed(store, 'sess-warmup-only', LAST_START, [
      { reps: 10, weightLbs: 40, setPurpose: 'warmup' },
      { reps: 0, weightLbs: 135 },
    ]);

    const plan = await fetchPlan(stateFor(store, [liveSession(LIVE_ID, LIVE_START)]));

    expect(plan).toBeNull();
  });
});
