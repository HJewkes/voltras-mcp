// VW-536: the live-schedule derive, under two writers. Each schedule tool reads a block's live
// row, derives the next row from it and appends; with the read outside the append's
// transaction, the second writer's row is derived from a live row the first has already
// replaced. Every case runs twice, as in `store-concurrency.test.ts`: both calls on one store
// instance, and one call on each of two instances on one temp file.
//
// Clock pinned to Saturday 2026-09-19. Every value is synthetic.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerState } from '../../state/server-state.js';
import { SqliteSessionStore } from '../../store/sqlite-store.js';
import type { SessionStore } from '../../store/types.js';

vi.mock('@voltras/node-sdk', () => ({ VoltraSDKError: class extends Error {} }));

const { registerPlanTools } = await import('../plan-tools.js');
const { registerPlanScheduleTools } = await import('../plan-schedule-tools.js');
const { CORE_TOOL_NAMES } = await import('../../tool-registry.js');

const TODAY = '2026-09-19T12:00:00.000Z';
const TWO_MONDAYS_AGO = '2026-09-07';
const NEXT_MONDAY = '2026-09-21';

type Result = { isError: boolean; body: Record<string, unknown> };
type Call = (name: string, args: unknown) => Promise<Result>;
type Callback = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

/** The plan tools registered against one store instance. */
function planToolsOn(store: SessionStore): Call {
  const callbacks = new Map<string, Callback>();
  const placeholders = new Map(
    CORE_TOOL_NAMES.filter((name) => name.startsWith('plan.')).map((name) => [
      name,
      { update: (u: { callback: Callback }) => callbacks.set(name, u.callback) },
    ]),
  );
  const state = { store, exercises: { getById: () => undefined } } as unknown as ServerState;
  registerPlanTools({} as never, state, placeholders as never);
  registerPlanScheduleTools({} as never, state, placeholders as never);
  return async (name, args) => {
    const result = await callbacks.get(name)!(args);
    return { isError: result.isError === true, body: JSON.parse(result.content[0].text) as never };
  };
}

let dir: string;
const opened: SessionStore[] = [];

function openStore(): SessionStore {
  const store = SqliteSessionStore.open(join(dir, 'store.sqlite'));
  opened.push(store);
  return store;
}

/** Two stores on one database: the same instance twice, or two instances. */
function storePair(connections: 1 | 2): [SessionStore, SessionStore] {
  const a = openStore();
  return [a, connections === 1 ? a : openStore()];
}

/** `connections` callers on one database, and a reader on the second. */
function callers(connections: 1 | 2): [Call, Call, SessionStore] {
  const [a, b] = storePair(connections);
  return [planToolsOn(a), planToolsOn(b), b];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(TODAY));
  dir = mkdtempSync(join(tmpdir(), 'vmcp-schedule-derive-'));
});

afterEach(async () => {
  vi.useRealTimers();
  for (const store of opened.splice(0)) await store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function datedBlock(call: Call, id: string, programId: string, startsOn?: string) {
  await call('plan.program.create', { id: programId, name: `Program ${programId}` });
  const created = await call('plan.block.create', {
    id,
    programId,
    orderIndex: 0,
    name: `Block ${id}`,
    weeksCount: 4,
    ...(startsOn !== undefined ? { startsOn } : {}),
  });
  expect(created.isError, JSON.stringify(created.body)).toBe(false);
}

async function liveSkips(reader: SessionStore, blockId: string): Promise<string[]> {
  const live = await reader.getLiveBlockSchedule(blockId);
  return (live?.skips ?? []).map((skip) => skip.weekOf).sort();
}

describe.each([1, 2] as const)('schedule derive with %i connection(s) (VW-536)', (connections) => {
  it('keeps both skips when two weeks are skipped at once', async () => {
    const [a, b, reader] = callers(connections);
    await datedBlock(a, 'b1', 'p1', TWO_MONDAYS_AGO);

    await Promise.all([
      a('plan.week.skip', { blockId: 'b1', week: 1, mode: 'hold' }),
      b('plan.week.skip', { blockId: 'b1', week: 2, mode: 'hold' }),
    ]);

    expect(await liveSkips(reader, 'b1')).toEqual(['2026-09-07', '2026-09-14']);
  });

  it('keeps a skip declared while the block is being resized', async () => {
    const [a, b, reader] = callers(connections);
    await datedBlock(a, 'b1', 'p1', TWO_MONDAYS_AGO);

    await Promise.all([
      a('plan.block.update', { blockId: 'b1', weeksCount: 5 }),
      b('plan.week.skip', { blockId: 'b1', week: 1, mode: 'hold' }),
    ]);

    const live = await reader.getLiveBlockSchedule('b1');
    expect(live?.weeksCount).toBe(5);
    expect(await liveSkips(reader, 'b1')).toEqual(['2026-09-07']);
  });

  it('refuses the second of two blocks dated onto the same weeks', async () => {
    const [a, b, reader] = callers(connections);
    await datedBlock(a, 'b1', 'p1');
    await datedBlock(a, 'b2', 'p2');

    const results = await Promise.all([
      a('plan.block.schedule', { blockId: 'b1', startsOn: NEXT_MONDAY }),
      b('plan.block.schedule', { blockId: 'b2', startsOn: NEXT_MONDAY }),
    ]);

    expect(results.map((r) => r.body.code ?? 'ok').sort()).toEqual(['SCHEDULE_OVERLAP', 'ok']);
    const dated = (await reader.listLiveBlockSchedules()).filter((row) => row.startsOn);
    expect(dated).toHaveLength(1);
  });
});

// --- truecoach.import_week: a skip lands between the import's read and its append ---------

const { importWeek } = await import('../truecoach-tools.js');
const { loadConfig } = await import('../../config.js');
const { ExerciseService } = await import('../../exercises/exercise-service.js');
const { SEED_CABLE_EXERCISES } = await import('../../exercises/seed-catalog.js');
const analytics = await import('@voltras/workout-analytics');

function coachWeek(id: number, due: string) {
  return {
    workouts: [{ id, title: `Upper ${String(id)}`, due }],
    workout_items: [
      { id: id + 10, workout_id: id, name: 'Cable Row', info: '3 x 10', position: 1 },
    ],
  };
}

const WIDE = { from: '2026-08-31', to: '2026-09-27' };
const THREE_WEEKS = [coachWeek(1, '2026-08-31'), coachWeek(2, '2026-09-14')];
const FOUR_WEEKS = [...THREE_WEEKS, coachWeek(3, '2026-09-21')];

function importInto(store: SessionStore, docs: unknown[]): Promise<unknown> {
  const state = {
    config: loadConfig({ HOME: dir, VOLTRA_ADAPTER: 'mock' }),
    store,
    exercises: new ExerciseService(),
  } as unknown as ServerState;
  const fetchPages = () => Promise.resolve({ clientId: '4242', pages: docs, cacheHit: false });
  return importWeek(state, WIDE, { fetchPages: fetchPages as never });
}

describe.each([1, 2] as const)('import dating with %i connection(s) (VW-536)', (connections) => {
  it('keeps a skip declared while an import resizes the block', async () => {
    (analytics as unknown as { setCatalog: (e: unknown[]) => void }).setCatalog(
      SEED_CABLE_EXERCISES,
    );
    const [importer, reader] = storePair(connections);
    const skipper = planToolsOn(reader);
    await importer.putTrainingProgram({ id: 'prog-1', name: 'Import', createdAt: TODAY });
    await importInto(importer, THREE_WEEKS);
    const [block] = await reader.getTrainingBlocksForProgram('prog-1');
    const skip = () => skipper('plan.week.skip', { blockId: block!.id, week: 1, mode: 'hold' });
    // The import's overlap check reads every live row after it has read its own; skip there.
    let skipped: Promise<Result> | undefined;
    const readAll = importer.listLiveBlockSchedules.bind(importer);
    vi.spyOn(importer, 'listLiveBlockSchedules').mockImplementationOnce(async () => {
      skipped = skip();
      await skipped;
      return readAll();
    });

    await importInto(importer, FOUR_WEEKS);
    await (skipped ?? skip());

    expect((await reader.getLiveBlockSchedule(block!.id))?.weeksCount).toBe(4);
    expect(await liveSkips(reader, block!.id)).toEqual(['2026-08-31']);
  });
});
