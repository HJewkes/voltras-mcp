// Concurrency conformance for the store PORT (VW-533): cases T1 to T6 of
// `sources/design/2026-09-20-postgres-port-sizing.md` section 3.
//
// Every case speaks the port only — no SQL, no raw handle — so this file can be
// pointed at a second engine by replacing `openEngine` and nothing else. SQLite
// is expected to pass all six by construction; that is what makes them a fair
// conformance suite rather than a bug hunt.
//
// TWO VARIANTS, AND WHAT EACH PROVES. The store is async at its edge and
// synchronous inside, so `Promise.all` against ONE instance proves the port
// never yields mid-method on this engine: the callers interleave, the method
// bodies do not. The TWO-INSTANCE variant opens a second connection on the same
// file, so each call computes its next value from its own connection's view and
// the invariant has to survive two independent handles. Neither variant proves
// OS-level parallelism: `node:sqlite` is synchronous and this is one thread.
// A second engine with a real connection pool will interleave for real here,
// which is the point of writing them against the port now.
//
// T7 is Postgres-era and has nothing to run against here. T8 is not repeated:
// all five trigger refusals are already pinned by message, in
// `sqlite-store-block-schedules.test.ts:136`, `sqlite-store-ui-actions.test.ts:154`
// and `:204`, and `sqlite-store-commitments.test.ts:194` and `:202`.
//
// Every value is synthetic.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Phase } from '@voltras/workout-analytics';

import {
  LOCAL_USER_ID,
  type AppendBlockScheduleInput,
  type ClaimUiActionOutcome,
  type DeclareCommitmentInput,
  type SessionStore,
  type StoredRep,
  type StoredSet,
  type StoredUiAction,
} from '../types.js';
import { openTestStore, type SessionStore } from './open-test-store.js';

const AT = '2026-09-20T18:00:00.000Z';
const WEEK_ONE = '2026-09-21';
const WEEK_TWO = '2026-09-28';

/**
 * The one engine-specific seam. `connect` hands back a store on the SAME backing
 * database, so calling it twice gives two independent connections. A second
 * engine replaces this function; nothing below it names SQLite.
 */
interface Engine {
  connect(): Promise<SessionStore>;
  dispose(): Promise<void>;
}

function openEngine(name: string): Engine {
  const dir = mkdtempSync(join(tmpdir(), `vmcp-concurrency-${name}-`));
  const path = join(dir, 'store.sqlite');
  const opened: SessionStore[] = [];
  return {
    connect() {
      const store = openTestStore({ path });
      opened.push(store);
      return Promise.resolve(store);
    },
    async dispose() {
      for (const store of opened) await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let engine: Engine | undefined;

/** One engine per test, disposed whatever the test did. */
async function engineFor(name: string): Promise<Engine> {
  engine = openEngine(name);
  return Promise.resolve(engine);
}

afterEach(async () => {
  await engine?.dispose();
  engine = undefined;
});

// --- T1: twenty concurrent appendBlockSchedules on one block (H1) ---------

async function seedBlock(store: SessionStore, blockId: string): Promise<void> {
  await store.putTrainingProgram({ id: `prog-${blockId}`, name: 'Return', createdAt: AT });
  await store.putTrainingBlock({
    id: blockId,
    programId: `prog-${blockId}`,
    orderIndex: 0,
    name: 'Orientation',
    weeksCount: 6,
  });
}

function schedule(blockId: string, startsOn: string): AppendBlockScheduleInput {
  return {
    blockId,
    startsOn,
    weeksCount: 6,
    skips: [],
    kind: 'planned',
    changedBy: 'user',
    declaredAt: AT,
  };
}

/** Twenty appends, spread over `writers` connections round-robin. */
function appendAll(writers: SessionStore[], blockId: string): Promise<unknown[]> {
  const calls = Array.from({ length: 20 }, (_unused, i) =>
    writers[i % writers.length].appendBlockSchedule(schedule(blockId, WEEK_ONE)),
  );
  return Promise.all(calls);
}

async function expectGapFreeSeq(reader: SessionStore, blockId: string): Promise<void> {
  const history = await reader.listBlockScheduleHistory(blockId);
  expect(history.map((row) => row.seq)).toEqual(Array.from({ length: 20 }, (_u, i) => i + 1));
  expect(new Set(history.map((row) => row.id)).size).toBe(20);
}

describe('T1: concurrent appendBlockSchedules give seq 1 to 20 (H1)', () => {
  it('holds when twenty callers interleave on one connection', async () => {
    const store = await (await engineFor('t1-one')).connect();
    await seedBlock(store, 'blk');

    await appendAll([store], 'blk');

    await expectGapFreeSeq(store, 'blk');
  });

  it('holds when two connections on one database each take ten', async () => {
    const eng = await engineFor('t1-two');
    const [a, b] = [await eng.connect(), await eng.connect()];
    await seedBlock(a, 'blk');

    await appendAll([a, b], 'blk');

    await expectGapFreeSeq(b, 'blk');
  });
});

// --- T2: concurrent declareCommitment revisions (H2) ----------------------

function declaration(overrides: Partial<DeclareCommitmentInput> = {}): DeclareCommitmentInput {
  return {
    userId: LOCAL_USER_ID,
    effectiveFrom: WEEK_ONE,
    days: [
      { day: 'Monday', fallbackDay: 'Tuesday' },
      { day: 'Wednesday', fallbackDay: 'Thursday' },
    ],
    ifThen: 'If the meeting runs long, then Wednesday moves to Thursday.',
    wording: 'Two lifts a week.',
    declaredAt: AT,
    ...overrides,
  };
}

describe('T2: concurrent declareCommitment for one week (H2)', () => {
  it('reports nine of ten identical declarations unchanged, on one connection', async () => {
    const store = await (await engineFor('t2-one')).connect();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.declareCommitment(declaration())),
    );

    expect(results.filter((r) => !r.unchanged)).toHaveLength(1);
    expect(results.every((r) => r.commitment.revision === 1)).toBe(true);
  });

  it('gives ten differing declarations revisions 1 to 10 across two connections', async () => {
    const eng = await engineFor('t2-two');
    const [a, b] = [await eng.connect(), await eng.connect()];

    const results = await Promise.all(
      Array.from({ length: 10 }, (_u, i) =>
        [a, b][i % 2].declareCommitment(declaration({ wording: `Week plan ${String(i)}.` })),
      ),
    );

    const revisions = results.map((r) => r.commitment.revision).sort((x, y) => x - y);
    expect(revisions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('leaves every effective_to consistent after two weeks race', async () => {
    const eng = await engineFor('t2-range');
    const [a, b] = [await eng.connect(), await eng.connect()];

    await Promise.all([
      a.declareCommitment(declaration({ effectiveFrom: WEEK_ONE })),
      b.declareCommitment(declaration({ effectiveFrom: WEEK_TWO, wording: 'Next week.' })),
    ]);

    const first = await a.getCommitmentForWeek(LOCAL_USER_ID, WEEK_ONE);
    const second = await b.getCommitmentForWeek(LOCAL_USER_ID, WEEK_TWO);
    expect(first?.effectiveTo).toBe(WEEK_TWO);
    expect(second?.effectiveTo).toBeNull();
  });
});

// --- T3 / T4: the action layer's idempotency and its completion guard -----

function claim(store: SessionStore, actionId: string): Promise<ClaimUiActionOutcome> {
  return store.claimUiAction({
    actionId,
    actionName: 'profile.log_bodyweight',
    actor: 'user',
    surface: 'wall',
    inputHash: 'hash-1',
    createdAt: AT,
  });
}

function complete(store: SessionStore, actionId: string): Promise<StoredUiAction> {
  return store.completeUiAction({
    actionId,
    resultStatus: 'ok',
    result: { recorded: true },
    completedAt: '2026-09-20T18:00:01.000Z',
  });
}

function kinds(outcomes: ClaimUiActionOutcome[]): string[] {
  return outcomes.map((outcome) => outcome.kind).sort();
}

describe('T3: two concurrent claimUiAction calls with one id', () => {
  it('claims once and reports the other taken, on one connection', async () => {
    const store = await (await engineFor('t3-one')).connect();

    const outcomes = await Promise.all([claim(store, 'act-1'), claim(store, 'act-1')]);

    expect(kinds(outcomes)).toEqual(['claimed', 'taken']);
  });

  it('claims once across two connections on one database', async () => {
    const eng = await engineFor('t3-two');
    const [a, b] = [await eng.connect(), await eng.connect()];

    const outcomes = await Promise.all([claim(a, 'act-1'), claim(b, 'act-1')]);

    expect(kinds(outcomes)).toEqual(['claimed', 'taken']);
  });
});

/** The rejection text both callers depend on; it must survive any engine change. */
const NO_PENDING = 'ui_actions: no pending action to complete for act-1';

describe('T4: two concurrent completeUiAction calls', () => {
  it('lets exactly one succeed and refuses the other by name, on one connection', async () => {
    const store = await (await engineFor('t4-one')).connect();
    await claim(store, 'act-1');

    const settled = await Promise.allSettled([complete(store, 'act-1'), complete(store, 'act-1')]);

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((r) => r.status === 'rejected');
    expect((rejected?.reason as Error).message).toBe(NO_PENDING);
  });

  it('refuses the loser identically across two connections', async () => {
    const eng = await engineFor('t4-two');
    const [a, b] = [await eng.connect(), await eng.connect()];
    await claim(a, 'act-1');

    const settled = await Promise.allSettled([complete(a, 'act-1'), complete(b, 'act-1')]);

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((r) => r.status === 'rejected');
    expect((rejected?.reason as Error).message).toBe(NO_PENDING);
    expect((await b.getUiAction('act-1'))?.resultStatus).toBe('ok');
  });
});

// --- T5: a reader never sees the diet timeline half-declared (H4) ---------

/** Ranges must tile the timeline: no overlap, no gap, and one open end at most. */
function timelineProblem(
  phases: readonly { startedAt: string; endedAt?: string }[],
): string | null {
  const open = phases.filter((p) => p.endedAt === undefined);
  if (open.length > 1) return `two open ranges: ${String(open.length)}`;
  for (let i = 0; i < phases.length - 1; i += 1) {
    if (phases[i].endedAt !== phases[i + 1].startedAt) {
      return `hole or overlap at ${phases[i].startedAt}`;
    }
  }
  return null;
}

function declarePhase(store: SessionStore, phase: string, startedAt: string): Promise<unknown> {
  return store.declareDietPhase({ userId: LOCAL_USER_ID, phase, startedAt, declaredAt: AT });
}

/** Poll until `stop` flips, recording the first invariant breach seen. */
async function pollTimeline(reader: SessionStore, stop: { done: boolean }): Promise<string | null> {
  let breach: string | null = null;
  while (!stop.done) {
    breach ??= timelineProblem(await reader.listDietPhases(LOCAL_USER_ID));
  }
  return breach ?? timelineProblem(await reader.listDietPhases(LOCAL_USER_ID));
}

const PHASE_STARTS = ['2026-01-01', '2026-03-01', '2026-05-01', '2026-07-01'];

describe('T5: a reader polling during declareDietPhase (H4)', () => {
  it('never observes two open ranges or a hole, on one connection', async () => {
    const store = await (await engineFor('t5-one')).connect();
    const stop = { done: false };

    const reading = pollTimeline(store, stop);
    try {
      for (const startedAt of PHASE_STARTS) await declarePhase(store, 'cut', startedAt);
    } finally {
      stop.done = true;
    }

    expect(await reading).toBeNull();
  });

  it('never observes them from a second connection on the same database', async () => {
    const eng = await engineFor('t5-two');
    const [writer, reader] = [await eng.connect(), await eng.connect()];
    const stop = { done: false };

    const reading = pollTimeline(reader, stop);
    try {
      for (const startedAt of PHASE_STARTS) await declarePhase(writer, 'cut', startedAt);
    } finally {
      stop.done = true;
    }

    expect(await reading).toBeNull();
  });
});

// --- T6: putSet for one id from two connections (H5) ----------------------

const EMPTY_PHASE: Phase = {
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

function rep(setId: string, index: number): StoredRep {
  return {
    id: `${setId}-rep-${String(index)}`,
    setId,
    index,
    repNumber: index + 1,
    concentric: EMPTY_PHASE,
    eccentric: EMPTY_PHASE,
  };
}

/** Each writer's rep count and header weight agree, so a torn row is visible. */
function setOf(repCount: number): StoredSet {
  return {
    id: 'set-1',
    sessionId: 'sess-1',
    userId: LOCAL_USER_ID,
    startedAt: AT,
    endedAt: AT,
    partial: false,
    weightLbs: repCount,
    reps: Array.from({ length: repCount }, (_u, i) => rep('set-1', i)),
  };
}

const WRITER_A_REPS = 3;
const WRITER_B_REPS = 7;

/** A row that hangs off the set through `ON DELETE SET NULL`: the #79 shape. */
async function seedSetWithDependant(store: SessionStore): Promise<void> {
  await store.putSession({ id: 'sess-1', startedAt: AT });
  await store.putSet(setOf(WRITER_A_REPS));
  await store.putAdvisoryDecision({
    id: 'adv-1',
    userId: LOCAL_USER_ID,
    setId: 'set-1',
    code: 'concurrency_probe',
    issuedAt: AT,
    inputs: {},
    thresholds: {},
    algorithmVersion: '1',
    verdict: 'noted',
  });
}

async function expectWholeSet(reader: SessionStore): Promise<void> {
  const stored = await reader.getSet('set-1');
  expect(stored).toBeDefined();
  // Reps belong to ONE writer: the count matches the header weight that writer wrote.
  expect(stored?.reps).toHaveLength(stored?.weightLbs ?? -1);
  expect([WRITER_A_REPS, WRITER_B_REPS]).toContain(stored?.reps.length);
  const [advisory] = await reader.listAdvisoryDecisions(LOCAL_USER_ID);
  expect(advisory?.setId).toBe('set-1');
}

describe('T6: putSet for one id from two writers (H5)', () => {
  it('keeps the row whole on one connection', async () => {
    const store = await (await engineFor('t6-one')).connect();
    await seedSetWithDependant(store);

    await Promise.all([store.putSet(setOf(WRITER_A_REPS)), store.putSet(setOf(WRITER_B_REPS))]);

    await expectWholeSet(store);
  });

  it('keeps the row whole and the dependant attached across two connections', async () => {
    const eng = await engineFor('t6-two');
    const [a, b] = [await eng.connect(), await eng.connect()];
    await seedSetWithDependant(a);

    await Promise.all([a.putSet(setOf(WRITER_A_REPS)), b.putSet(setOf(WRITER_B_REPS))]);

    await expectWholeSet(b);
  });
});

// --- T6b: a set re-put keeps the label and group another writer patched (VW-583)

async function patchLabelAndGroup(writer: SessionStore): Promise<void> {
  await writer.patchSetLifter('set-1', 'Jordan');
  await writer.patchSetBilateralGroup('set-1', 'group-1', 'live');
}

async function expectPatchesKept(reader: SessionStore): Promise<void> {
  const stored = await reader.getSet('set-1');
  expect(stored?.reps).toHaveLength(WRITER_B_REPS);
  expect(stored?.lifter).toBe('Jordan');
  expect(stored?.bilateralGroupId).toBe('group-1');
  expect(stored?.groupSource).toBe('live');
}

describe('T6b: a set re-put after a relabel and a group stamp (VW-583)', () => {
  it('keeps both on one connection', async () => {
    const store = await (await engineFor('t6b-one')).connect();
    await seedSetWithDependant(store);
    await patchLabelAndGroup(store);

    await store.putSet(setOf(WRITER_B_REPS));

    await expectPatchesKept(store);
  });

  it('keeps both when a second connection patched them', async () => {
    const eng = await engineFor('t6b-two');
    const [a, b] = [await eng.connect(), await eng.connect()];
    await seedSetWithDependant(a);
    await patchLabelAndGroup(b);

    await a.putSet(setOf(WRITER_B_REPS));

    await expectPatchesKept(b);
  });

  it('still writes a group the re-put carries', async () => {
    const store = await (await engineFor('t6b-regroup')).connect();
    await seedSetWithDependant(store);
    await patchLabelAndGroup(store);

    await store.putSet({
      ...setOf(WRITER_B_REPS),
      bilateralGroupId: 'group-2',
      groupSource: 'live',
    });

    expect((await store.getSet('set-1'))?.bilateralGroupId).toBe('group-2');
  });
});

const CARBS = { level: 'high' as const, hoursSinceLastMeal: 2 };

/** The owner in a declared phase, and a session of theirs to re-put. */
async function seedOwnerSession(store: SessionStore): Promise<void> {
  await store.declareDietPhase({
    userId: LOCAL_USER_ID,
    phase: 'fat-loss',
    startedAt: '2026-09-01T00:00:00.000Z',
    declaredAt: '2026-09-01T00:00:00.000Z',
  });
  await store.putSession({ id: 'sess-1', startedAt: AT, kind: 'training' });
}

describe('T6c: a session re-put after a relabel and a carb check-in (VW-584)', () => {
  it.each([1, 2] as const)('keeps both with %i connection(s)', async (n) => {
    const eng = await engineFor(`t6c-${n}`);
    const a = await eng.connect();
    const b = n === 1 ? a : await eng.connect();
    await seedOwnerSession(a);
    await b.patchSession('sess-1', { lifter: 'Jordan', preSessionCarbs: CARBS });

    await a.putSession({ id: 'sess-1', startedAt: AT, endedAt: AT });

    const stored = await b.getSession('sess-1');
    expect(stored?.endedAt).toBe(AT);
    expect(stored?.lifter).toBe('Jordan');
    expect(stored?.preSessionCarbs).toEqual(CARBS);
  });

  it('stamps no owner phase when the stored label is a guest, though the re-put carries none', async () => {
    const store = await (await engineFor('t6c-guest')).connect();
    await seedOwnerSession(store);
    await store.patchSession('sess-1', { lifter: 'Jordan' });

    await store.putSession({ id: 'sess-1', startedAt: AT, endedAt: AT });

    expect((await store.getSession('sess-1'))?.dietPhase).toBeUndefined();
  });

  it('stamps the owner phase when the stored row is the owner’s, though the re-put carries a label', async () => {
    const store = await (await engineFor('t6c-owner')).connect();
    await seedOwnerSession(store);

    await store.putSession({ id: 'sess-1', startedAt: AT, endedAt: AT, lifter: 'Jordan' });

    const stored = await store.getSession('sess-1');
    expect(stored).not.toHaveProperty('lifter');
    expect(stored?.dietPhase).toBe('fat-loss');
  });
});

// --- T9: two answers to one advisory (VW-587) -----------------------------

const DECISION_ID = 'decision-1';
const TARGET_ID = 'target-1';

async function seedOpenAdvisoryAndTarget(store: SessionStore): Promise<void> {
  await store.putAdvisoryDecision({
    id: DECISION_ID,
    userId: LOCAL_USER_ID,
    code: 'synthetic_offer',
    issuedAt: AT,
    inputs: { note: 'as issued' },
    thresholds: {},
    algorithmVersion: 'test@1',
    verdict: 'offered',
  });
  await store.putPriority({
    id: 'priority-1',
    userId: LOCAL_USER_ID,
    horizonWeeks: 6,
    kind: 'lift',
    ref: 'bench-press',
    level: 'specialize',
    declaredAt: AT,
    mesosHeld: 0,
  });
  await store.putGoalTarget({
    id: TARGET_ID,
    priorityId: 'priority-1',
    metric: 'e1rm_trend',
    startValue: 100,
    startMeasuredAt: AT,
    bandLowPctPerWeek: 0.5,
    bandHighPctPerWeek: 1,
    committedValue: 103,
    stretchValue: 106,
    basis: 'rp_ramp',
    infoLevel: 'ramp',
    tierUsed: 'beginner',
    tierProvisional: false,
    dietPhaseAtDerivation: 'maintenance',
    acceptedBy: 'coach-default',
    acknowledgedStretch: false,
    derivedAt: AT,
    endsAt: '2026-11-01T00:00:00.000Z',
  });
}

const ACCEPT = { userResponse: 'accepted', respondedAt: AT, inputs: { note: 'accepted' } } as const;
const DECLINE = { userResponse: 'declined', respondedAt: AT } as const;
const RETIRE = { goalTargetId: TARGET_ID, outcome: 'abandoned' } as const;

async function expectAcceptanceStands(reader: SessionStore): Promise<void> {
  const [stored] = await reader.listAdvisoryDecisions(LOCAL_USER_ID);
  expect(stored.userResponse).toBe('accepted');
  expect(stored.inputs).toEqual({ note: 'accepted' });
}

describe('T9: two answers to one advisory (VW-587)', () => {
  it('records exactly one of two concurrent answers, on one connection', async () => {
    const store = await (await engineFor('t9-one')).connect();
    await seedOpenAdvisoryAndTarget(store);

    const [first, second] = await Promise.all([
      store.answerAdvisoryIfOpen(DECISION_ID, ACCEPT),
      store.answerAdvisoryIfOpen(DECISION_ID, DECLINE),
    ]);

    expect(first?.userResponse).toBe('accepted');
    expect(second).toBeUndefined();
    await expectAcceptanceStands(store);
  });

  it('records exactly one across two connections on one database', async () => {
    const eng = await engineFor('t9-two');
    const [a, b] = [await eng.connect(), await eng.connect()];
    await seedOpenAdvisoryAndTarget(a);

    const [first, second] = await Promise.all([
      a.answerAdvisoryIfOpen(DECISION_ID, ACCEPT),
      b.answerAdvisoryIfOpen(DECISION_ID, DECLINE),
    ]);

    expect([first, second].filter((row) => row !== undefined)).toHaveLength(1);
    await expectAcceptanceStands(b);
  });

  it('retires the target with a winning answer', async () => {
    const store = await (await engineFor('t9-retire-win')).connect();
    await seedOpenAdvisoryAndTarget(store);

    await store.answerAdvisoryIfOpen(DECISION_ID, DECLINE, RETIRE);

    const [target] = await store.listGoalTargets(
      { userId: LOCAL_USER_ID },
      { includeRetired: true },
    );
    expect(target).toMatchObject({ retiredAt: AT, outcome: 'abandoned' });
  });

  it('leaves the target live when the answer carrying the retire lost', async () => {
    const eng = await engineFor('t9-retire-lose');
    const [a, b] = [await eng.connect(), await eng.connect()];
    await seedOpenAdvisoryAndTarget(a);
    await a.answerAdvisoryIfOpen(DECISION_ID, ACCEPT);

    const lost = await b.answerAdvisoryIfOpen(DECISION_ID, DECLINE, RETIRE);

    expect(lost).toBeUndefined();
    expect((await a.listGoalTargets({ userId: LOCAL_USER_ID }))[0].retiredAt).toBeUndefined();
    await expectAcceptanceStands(a);
  });
});
