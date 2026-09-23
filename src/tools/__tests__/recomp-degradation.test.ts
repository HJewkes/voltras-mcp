// VW-369: the store side of the recomposition re-ask — boundary counting off
// the plan tree, the two leanness readings, and the decline round-trip through
// `advisory_decisions`.
//
// The pure gates are pinned in `analytics/__tests__/recomp-degradation.test.ts`;
// what is exercised here is the assembly and the persistence.

import { beforeEach, describe, expect, it } from 'vitest';

import { RECOMP_DEGRADATION_CODE } from '../../analytics/recomp-degradation.js';
import { SqliteSessionStore } from '../../store/sqlite-store.js';
import { LOCAL_USER_ID, type StoredTrainingBlock } from '../../store/types.js';
import type { ServerState } from '../../state/server-state.js';
import { buildRecompDegradation, recordRecompResponse } from '../recomp-degradation.js';

const PROGRAM_ID = 'program-1';
const PHASE_STARTED_AT = '2026-01-01T00:00:00.000Z';
const NOW = '2026-05-01T00:00:00.000Z';

let store: SqliteSessionStore;
let state: ServerState;

/** One block with one week and one template, finished at `finishedAt` when given. */
async function addBlock(orderIndex: number, finishedAt: string | null): Promise<void> {
  const id = `block-${orderIndex}`;
  await store.putTrainingBlock({ id, programId: PROGRAM_ID, orderIndex, name: id, weeksCount: 1 });
  await store.putTrainingWeek({ id: `${id}-w`, blockId: id, orderIndex: 0, isDeload: false });
  await store.putWorkoutTemplate({
    id: `${id}-t`,
    weekId: `${id}-w`,
    name: `${id} day`,
    orderIndex: 0,
  });
  if (finishedAt === null) return;
  await store.putSession({
    kind: 'training',
    id: `${id}-s`,
    startedAt: finishedAt,
    lifter: 'primary',
  });
  await store.putProgramAssignment({
    id: `${id}-a`,
    sessionId: `${id}-s`,
    workoutTemplateId: `${id}-t`,
    assignedAt: finishedAt,
  });
}

async function blocks(): Promise<StoredTrainingBlock[]> {
  return store.getTrainingBlocksForProgram(PROGRAM_ID);
}

async function declareRecomposition(): Promise<void> {
  await store.declareDietPhase({
    userId: LOCAL_USER_ID,
    phase: 'recomposition',
    startedAt: PHASE_STARTED_AT,
    declaredAt: PHASE_STARTED_AT,
    recompMode: 'hold',
  });
}

beforeEach(async () => {
  store = SqliteSessionStore.open(':memory:');
  state = { store } as unknown as ServerState;
  await store.putTrainingProgram({ id: PROGRAM_ID, name: 'p', createdAt: PHASE_STARTED_AT });
});

describe('buildRecompDegradation — boundary counting', () => {
  it('counts the boundary being reported before its own assignment is written', async () => {
    await declareRecomposition();
    await addBlock(0, '2026-02-01T00:00:00.000Z');
    await addBlock(1, null);
    const result = await buildRecompDegradation(state, await blocks(), true, NOW);
    expect(result.proposal?.inputs.boundariesSincePhaseStart).toBe(2);
  });

  it('stays silent at the first boundary of a freshly declared phase', async () => {
    await declareRecomposition();
    await addBlock(0, null);
    const result = await buildRecompDegradation(state, await blocks(), true, NOW);
    expect(result.proposal).toBeNull();
  });

  it('does not inherit blocks that finished before the phase was declared', async () => {
    await declareRecomposition();
    await addBlock(0, '2025-11-01T00:00:00.000Z');
    await addBlock(1, '2025-12-01T00:00:00.000Z');
    await addBlock(2, null);
    const result = await buildRecompDegradation(state, await blocks(), true, NOW);
    expect(result.proposal).toBeNull();
  });

  it('says so when no diet phase is declared at all', async () => {
    await addBlock(0, null);
    const result = await buildRecompDegradation(state, await blocks(), true, NOW);
    expect(result.proposal).toBeNull();
    expect(result.silentReason).toContain('unknown');
  });
});

describe('buildRecompDegradation — the measured and self-reported legs', () => {
  beforeEach(async () => {
    await declareRecomposition();
    await addBlock(0, null);
  });

  it('fires on cumulative loss read off the logged series alone', async () => {
    await store.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: PHASE_STARTED_AT,
      bodyweightLbs: 200,
    });
    for (const day of ['04-25', '04-27', '04-29']) {
      await store.putBodyMetric({
        userId: LOCAL_USER_ID,
        measuredAt: `2026-${day}T00:00:00.000Z`,
        bodyweightLbs: 178,
      });
    }
    const result = await buildRecompDegradation(state, await blocks(), true, NOW);
    expect(result.proposal?.level).toBe('significant');
  });

  it('fires on a leanness rung reported against the phase-start reading', async () => {
    await store.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: PHASE_STARTED_AT,
      bodyweightLbs: 200,
      leannessBand: 'moderate',
    });
    await store.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: '2026-04-01T00:00:00.000Z',
      bodyweightLbs: 199,
      leannessBand: 'lean',
    });
    const result = await buildRecompDegradation(state, await blocks(), true, NOW);
    expect(result.proposal?.triggers.map((t) => t.kind)).toEqual(['leanness-rung']);
  });
});

describe('recordRecompResponse', () => {
  beforeEach(async () => {
    await declareRecomposition();
    await addBlock(0, '2026-02-01T00:00:00.000Z');
    await addBlock(1, null);
  });

  it('files a decline with the inputs and thresholds it fired on', async () => {
    const result = await buildRecompDegradation(state, await blocks(), true, NOW);
    expect(await recordRecompResponse(state, result, 'declined', NOW)).toMatchObject({
      recorded: true,
    });
    const [filed] = await store.listAdvisoryDecisions(LOCAL_USER_ID, {
      code: RECOMP_DEGRADATION_CODE,
    });
    expect(filed.verdict).toBe('boundary');
    expect(filed.userResponse).toBe('declined');
    expect(filed.inputs.boundariesSincePhaseStart).toBe(2);
    expect(filed.thresholds.boundaryReAskIndex).toBe(2);
  });

  it('suppresses the same proposal on the next read, and writes no diet phase', async () => {
    const before = await store.listDietPhases(LOCAL_USER_ID);
    const issued = await buildRecompDegradation(state, await blocks(), true, NOW);
    await recordRecompResponse(state, issued, 'declined', NOW);
    const reread = await buildRecompDegradation(state, await blocks(), true, NOW);
    expect(reread.proposal).toBeNull();
    expect(reread.silentReason).toContain('already been answered');
    expect(await store.listDietPhases(LOCAL_USER_ID)).toEqual(before);
  });

  it('records an acceptance without switching the phase', async () => {
    const issued = await buildRecompDegradation(state, await blocks(), true, NOW);
    await recordRecompResponse(state, issued, 'accepted', NOW);
    const [filed] = await store.listAdvisoryDecisions(LOCAL_USER_ID, {
      code: RECOMP_DEGRADATION_CODE,
    });
    expect(filed.userResponse).toBe('accepted');
    expect((await store.listDietPhases(LOCAL_USER_ID))[0].phase).toBe('recomposition');
  });

  it('asks again at the next boundary when the last one went unanswered', async () => {
    const issued = await buildRecompDegradation(state, await blocks(), true, NOW);
    expect(issued.proposal?.inputs.boundariesSincePhaseStart).toBe(2);
    await addBlock(2, '2026-04-01T00:00:00.000Z');
    const next = await buildRecompDegradation(state, await blocks(), true, NOW);
    expect(next.proposal?.inputs.boundariesSincePhaseStart).toBe(3);
    expect(next.proposal?.triggers.map((t) => t.kind)).toEqual(['block-boundary']);
  });

  it('goes quiet at the next boundary once the ask was accepted', async () => {
    const issued = await buildRecompDegradation(state, await blocks(), true, NOW);
    await recordRecompResponse(state, issued, 'accepted', NOW);
    await addBlock(2, '2026-04-01T00:00:00.000Z');
    const next = await buildRecompDegradation(state, await blocks(), true, NOW);
    expect(next.proposal).toBeNull();
    expect(next.silentReason).toContain('already been answered');
  });

  it('records nothing when no proposal is open, and says why', async () => {
    const silent = await buildRecompDegradation(state, [], false, NOW);
    const outcome = await recordRecompResponse(state, silent, 'declined', NOW);
    expect(outcome.recorded).toBe(false);
    expect(await store.listAdvisoryDecisions(LOCAL_USER_ID)).toEqual([]);
  });
});
