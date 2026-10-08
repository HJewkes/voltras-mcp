// `session.mark_kind` through the action layer (VW-847 S1).
//
// Each case runs `executeAction` with the boot-captured handlers on a throwaway in-memory
// store, then reads the `ui_actions` rows and the sessions back. The range guard lives in the
// handler, so what is proved here is that it holds when the wall is the caller.
//
// Mock adapter, synthetic rows.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { captureActionHandlers, type CapturedTools } from '../capture-handlers.js';
import { executeAction, type ActionOutcome } from '../execute.js';
import { loadConfig } from '../../config.js';
import { bootstrapState, type ServerState } from '../../state/server-state.js';
import type { SessionKind } from '../../store/session-kind.js';

const savedEnv = { ...process.env };

let state: ServerState;
let tools: CapturedTools;
let actionSeq = 0;

beforeEach(async () => {
  process.env.VOLTRA_ADAPTER = 'mock';
  process.env.VMCP_DB_PATH = ':memory:';
  process.env.VMCP_DASHBOARD_PORT = 'off';
  state = await bootstrapState(loadConfig());
  tools = captureActionHandlers(state);
});

afterEach(async () => {
  await state.store.close();
  process.env = { ...savedEnv };
});

async function seed(id: string, day: string, kind?: SessionKind): Promise<void> {
  const at = `${day}T12:00:00.000Z`;
  await state.store.putSession({
    id,
    startedAt: at,
    endedAt: at,
    ...(kind === undefined ? {} : { kind }),
  });
}

/** Two unmarked sessions, one already test and one already training, over two days. */
async function seedRange(): Promise<void> {
  await seed('sess-a', '2026-09-10');
  await seed('sess-b', '2026-09-10');
  await seed('sess-c', '2026-09-11', 'test');
  await seed('sess-d', '2026-09-11', 'training');
}

async function kinds(ids: string[]): Promise<(SessionKind | undefined)[]> {
  return Promise.all(ids.map(async (id) => (await state.store.getSession(id))?.kind));
}

function run(input: unknown, actionId = `act-${String((actionSeq += 1))}`): Promise<ActionOutcome> {
  return executeAction(
    { name: 'session.mark_kind', actionId, actor: 'user', surface: 'wall', input },
    { store: state.store, tools, now: () => new Date('2026-09-16T12:00:00.000Z') },
  );
}

const rows = () => state.store.listUiActions();

describe('session.mark_kind through the action layer', () => {
  it('writes a day mark and leaves one ok row', async () => {
    await seed('sess-a', '2026-09-10');
    await seed('sess-b', '2026-09-10');

    const outcome = await run({ kind: 'training', day: '2026-09-10' });

    expect(outcome.body).toMatchObject({ ok: true });
    expect(await kinds(['sess-a', 'sess-b'])).toEqual(['training', 'training']);
    const trail = await rows();
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ actionName: 'session.mark_kind', resultStatus: 'ok' });
  });

  it('leaves one ok row and no change on a dry run', async () => {
    await seed('sess-a', '2026-09-10');

    const outcome = await run({ kind: 'training', day: '2026-09-10', dryRun: true });

    expect(outcome.body).toMatchObject({
      ok: true,
      result: { dryRun: true, newlyClassified: ['sess-a'] },
    });
    expect(await kinds(['sess-a'])).toEqual([undefined]);
    const trail = await rows();
    expect(trail).toHaveLength(1);
    expect(trail[0].resultStatus).toBe('ok');
  });

  it('refuses a range without expectSessions, leaving one error row and no change', async () => {
    await seedRange();

    const outcome = await run({ kind: 'training', from: '2026-09-10', to: '2026-09-11' });

    expect(outcome.body.ok).toBe(false);
    expect(await kinds(['sess-a', 'sess-b', 'sess-c', 'sess-d'])).toEqual([
      undefined,
      undefined,
      'test',
      'training',
    ]);
    const trail = await rows();
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      resultStatus: 'error',
      resultCode: 'EXPECTED_SESSIONS_MISMATCH',
    });
  });

  it('refuses newlyClassified alone when a session in the range is pre-marked', async () => {
    await seedRange();
    const dry = await run({
      kind: 'training',
      from: '2026-09-10',
      to: '2026-09-11',
      dryRun: true,
    });
    const newly = (dry.body.result as { newlyClassified: string[] }).newlyClassified.length;

    const outcome = await run({
      kind: 'training',
      from: '2026-09-10',
      to: '2026-09-11',
      expectSessions: newly,
    });

    expect(outcome.body.ok).toBe(false);
    expect(await kinds(['sess-a', 'sess-b', 'sess-c', 'sess-d'])).toEqual([
      undefined,
      undefined,
      'test',
      'training',
    ]);
    const failed = (await rows()).filter((row) => row.resultStatus === 'error');
    expect(failed).toHaveLength(1);
    expect(failed[0].resultCode).toBe('EXPECTED_SESSIONS_MISMATCH');
  });

  it('writes a range when expectSessions is the sum of the four lists', async () => {
    await seedRange();
    const dry = await run({
      kind: 'training',
      from: '2026-09-10',
      to: '2026-09-11',
      dryRun: true,
    });
    const lists = dry.body.result as Record<string, string[]>;
    const expected = ['newlyClassified', 'reclassified', 'skippedAlreadyMarked', 'alreadyThisKind']
      .map((key) => lists[key].length)
      .reduce((total, count) => total + count, 0);
    expect(expected).toBe(4);

    const outcome = await run({
      kind: 'training',
      from: '2026-09-10',
      to: '2026-09-11',
      expectSessions: expected,
    });

    expect(outcome.body).toMatchObject({ ok: true });
    expect(await kinds(['sess-a', 'sess-b', 'sess-c', 'sess-d'])).toEqual([
      'training',
      'training',
      'test',
      'training',
    ]);
    expect((await rows()).filter((row) => row.resultStatus === 'ok')).toHaveLength(2);
  });

  it('adds no row when an id is replayed', async () => {
    await seed('sess-a', '2026-09-10');
    await run({ kind: 'training', day: '2026-09-10' }, 'act-replay');

    const again = await run({ kind: 'training', day: '2026-09-10' }, 'act-replay');

    expect(again.body).toMatchObject({ ok: true, replayed: true });
    expect(await rows()).toHaveLength(1);
  });
});
