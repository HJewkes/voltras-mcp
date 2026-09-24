// Dated blocks (VW-474): the plan tools that write and read `block_schedules`, run against a
// real in-memory store with the clock pinned to Saturday 2026-09-19. Invariants pinned here:
// I2 (no overlap), I3 (a current block's start never moves), I6 (live weeks_count equals the
// block's), I7 (program order agrees with date order) and I8 (an ended block gets no row).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BlockCalendar, CalendarWeek } from '../../plan/block-calendar.js';
import type { ServerState } from '../../state/server-state.js';
import type { StoredTrainingBlock, StoredTrainingWeek } from '../../store/types.js';
import { seedTrainingDay } from '../../__tests__/fixtures/training-day.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

vi.mock('@voltras/node-sdk', () => {
  class FakeVoltraSDKError extends Error {
    readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  return { VoltraSDKError: FakeVoltraSDKError };
});

const { registerPlanTools } = await import('../plan-tools.js');
const { registerPlanScheduleTools } = await import('../plan-schedule-tools.js');
const { CORE_TOOL_NAMES } = await import('../../tool-registry.js');

const TODAY = '2026-09-19T12:00:00.000Z';
const THIS_MONDAY = '2026-09-14';
const NEXT_MONDAY = '2026-09-21';

type Row = Record<string, unknown>;
type CalendarView = BlockCalendar & {
  weeks: (CalendarWeek & { weekId: string | null; templateCount: number; sessionDays: string[] })[];
};

/** Every field a plan tool here can return; each test reads the ones its tool sets. */
interface ToolBody {
  block: StoredTrainingBlock;
  weeks: StoredTrainingWeek[];
  week: StoredTrainingWeek;
  weekOf: string;
  calendar: CalendarView;
  scheduleRow: { seq: number; kind: string; changedBy?: string } | null;
  rows: Row[];
  code: string;
  message: string;
}

type Callback = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

let store: SessionStore;
let callbacks: Map<string, Callback>;

function register(): void {
  callbacks = new Map();
  const placeholders = new Map(
    CORE_TOOL_NAMES.filter((name) => name.startsWith('plan.')).map((name) => [
      name,
      {
        update: (updates: { callback: Callback }) => callbacks.set(name, updates.callback),
        remove: () => undefined,
      },
    ]),
  );
  const state = { store, exercises: { getById: () => undefined } } as unknown as ServerState;
  const server = {} as Parameters<typeof registerPlanTools>[0];
  registerPlanTools(server, state, placeholders as never);
  registerPlanScheduleTools(server, state, placeholders as never);
}

async function call(name: string, args: unknown): Promise<{ isError: boolean; body: ToolBody }> {
  const callback = callbacks.get(name);
  if (callback === undefined) throw new Error(`no handler for ${name}`);
  const result = await callback(args);
  return { isError: result.isError === true, body: JSON.parse(result.content[0].text) as ToolBody };
}

async function ok(name: string, args: unknown): Promise<ToolBody> {
  const result = await call(name, args);
  expect(result.isError, JSON.stringify(result.body)).toBe(false);
  return result.body;
}

async function refused(name: string, args: unknown): Promise<{ code: string; message: string }> {
  const result = await call(name, args);
  expect(result.isError, JSON.stringify(result.body)).toBe(true);
  return result.body;
}

async function program(id: string): Promise<void> {
  await ok('plan.program.create', { id, name: `Program ${id}` });
}

async function block(
  id: string,
  over: { programId?: string; orderIndex?: number; weeksCount?: number; startsOn?: string } = {},
): Promise<ToolBody> {
  return ok('plan.block.create', {
    id,
    programId: over.programId ?? 'p1',
    orderIndex: over.orderIndex ?? 0,
    name: `Block ${id}`,
    weeksCount: over.weeksCount ?? 4,
    ...(over.startsOn !== undefined ? { startsOn: over.startsOn } : {}),
  });
}

async function history(blockId: string): Promise<Row[]> {
  return (await ok('plan.block.schedule_history', { blockId })).rows;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(TODAY));
  store = openTestStore();
  register();
  await program('p1');
});

afterEach(async () => {
  vi.useRealTimers();
  await store.close();
});

describe('plan.block.create with dates', () => {
  it('dates a new block from a Monday and records one planned row by the user', async () => {
    const created = await block('b1', { startsOn: NEXT_MONDAY, weeksCount: 2 });

    expect(created.scheduleRow).toEqual({ seq: 1, kind: 'planned' });
    expect(created.calendar).toMatchObject({
      startsOn: NEXT_MONDAY,
      endsOn: '2026-10-04',
      state: 'upcoming',
    });
    expect((await history('b1'))[0]).toMatchObject({ kind: 'planned', changedBy: 'user' });
  });

  it('refuses a start that is not a Monday and names the Mondays either side', async () => {
    const error = await refused('plan.block.create', {
      id: 'b1',
      programId: 'p1',
      orderIndex: 0,
      name: 'Block',
      weeksCount: 2,
      startsOn: '2026-09-23',
    });

    expect(error.code).toBe('NOT_A_MONDAY');
    expect(error.message).toContain('2026-09-21 and 2026-09-28');
    expect(await store.getTrainingBlock('b1')).toBeUndefined();
  });

  it('scaffolds one week row per week and flags the named deload weeks', async () => {
    const created = await ok('plan.block.create', {
      programId: 'p1',
      orderIndex: 0,
      name: 'Block',
      weeksCount: 4,
      startsOn: NEXT_MONDAY,
      scaffoldWeeks: true,
      deloadWeeks: [4],
    });

    expect(created.weeks.map((w) => [w.name, w.isDeload])).toEqual([
      ['Week 1', false],
      ['Week 2', false],
      ['Week 3', false],
      ['Week 4', true],
    ]);
    expect(created.calendar.weeks[3]).toMatchObject({ planWeek: 4, isDeload: true });
  });

  it('refuses deload weeks without scaffolding, and scaffolding over existing week rows', async () => {
    const noScaffold = await refused('plan.block.create', {
      programId: 'p1',
      orderIndex: 0,
      name: 'Block',
      weeksCount: 4,
      deloadWeeks: [4],
    });
    await block('b1');
    await ok('plan.week.create', { blockId: 'b1', orderIndex: 0 });
    const overExisting = await refused('plan.block.create', {
      id: 'b1',
      programId: 'p1',
      orderIndex: 0,
      name: 'Block',
      weeksCount: 4,
      scaffoldWeeks: true,
    });

    expect(noScaffold.code).toBe('INVALID_INPUT');
    expect(overExisting.code).toBe('WEEKS_EXIST');
  });

  it('leaves an undated block undated and writes no schedule row', async () => {
    const created = await block('b1');

    expect(created.scheduleRow).toBeNull();
    expect(created.calendar.state).toBe('undated');
    expect(await history('b1')).toEqual([]);
  });
});

describe('I2: no two live calendars overlap', () => {
  it('refuses an overlapping new block across programs, names the other, and writes nothing', async () => {
    await program('p2');
    await block('b1', { startsOn: NEXT_MONDAY, weeksCount: 4 });

    const error = await refused('plan.block.create', {
      id: 'b2',
      programId: 'p2',
      orderIndex: 0,
      name: 'Other',
      weeksCount: 2,
      startsOn: '2026-10-12',
    });

    expect(error.code).toBe('SCHEDULE_OVERLAP');
    expect(error.message).toContain('"Block b1" (2026-09-21 to 2026-10-18)');
    expect(await store.getTrainingBlock('b2')).toBeUndefined();
  });

  it('refuses an overlapping move without cascade and leaves the live row unchanged', async () => {
    await block('b1', { startsOn: NEXT_MONDAY, weeksCount: 2 });
    await block('b2', { orderIndex: 1, startsOn: '2026-10-05', weeksCount: 2 });

    const error = await refused('plan.block.schedule', { blockId: 'b1', startsOn: '2026-09-28' });

    expect(error.code).toBe('SCHEDULE_OVERLAP');
    expect(error.message).toContain('Block b2');
    expect(await history('b1')).toHaveLength(1);
  });

  it('moves every later dated block by the same weeks with cascade, in one write', async () => {
    await block('b1', { startsOn: NEXT_MONDAY, weeksCount: 2 });
    await block('b2', { orderIndex: 1, startsOn: '2026-10-05', weeksCount: 2 });

    const moved = await ok('plan.block.schedule', {
      blockId: 'b1',
      startsOn: '2026-09-28',
      cascade: 'later_blocks',
      reason: 'travel',
    });

    expect(moved.rows).toEqual([
      {
        blockId: 'b1',
        seq: 2,
        kind: 'moved',
        from: { startsOn: NEXT_MONDAY, endsOn: '2026-10-04' },
        to: { startsOn: '2026-09-28', endsOn: '2026-10-11' },
      },
      {
        blockId: 'b2',
        seq: 2,
        kind: 'moved',
        from: { startsOn: '2026-10-05', endsOn: '2026-10-18' },
        to: { startsOn: '2026-10-12', endsOn: '2026-10-25' },
      },
    ]);
  });

  it('ignores blocks of an archived program', async () => {
    await program('p2');
    await ok('plan.block.create', {
      id: 'old',
      programId: 'p2',
      orderIndex: 0,
      name: 'Old',
      weeksCount: 4,
      startsOn: NEXT_MONDAY,
    });
    await ok('plan.program.archive', { id: 'p2' });

    const created = await block('b1', { startsOn: NEXT_MONDAY });

    expect(created.scheduleRow).toEqual({ seq: 1, kind: 'planned' });
  });

  it('refuses a week-skip extend that would run into the next dated block', async () => {
    await block('b1', { startsOn: THIS_MONDAY, weeksCount: 1 });
    await block('b2', { orderIndex: 1, startsOn: NEXT_MONDAY });

    const error = await refused('plan.week.skip', { blockId: 'b1', week: 1, mode: 'extend' });

    expect(error.code).toBe('SCHEDULE_OVERLAP');
    expect(await history('b1')).toHaveLength(1);
  });

  it('holds across a seeded random sequence of schedule writes', async () => {
    await program('p2');
    const ids = ['a0', 'a1', 'c0', 'c1'];
    for (const [index, id] of ids.entries()) {
      await block(id, { programId: index < 2 ? 'p1' : 'p2', orderIndex: index % 2, weeksCount: 2 });
    }
    let seed = 7;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.floor(seed / 65536) % n;
    };
    for (let step = 0; step < 100; step++) {
      await randomWrite(ids[next(4)], next);
      await expectNoOverlapAndLengthsAgree(ids);
    }
    const written = await Promise.all(ids.map((id) => store.listBlockScheduleHistory(id)));
    expect(written.flat().length).toBeGreaterThan(25);
  }, 120_000);
});

async function randomWrite(blockId: string, next: (n: number) => number): Promise<void> {
  const monday = new Date(Date.UTC(2026, 8, 14 + 7 * next(30))).toISOString().slice(0, 10);
  const op = next(6);
  if (op <= 2) {
    const cascade = next(2) === 0 ? 'none' : 'later_blocks';
    await call('plan.block.schedule', { blockId, startsOn: monday, cascade });
  } else if (op === 1) await call('plan.block.update', { blockId, weeksCount: 1 + next(4) });
  else if (op === 4) await call('plan.week.skip', { blockId, week: 1, mode: 'extend' });
  else await call('plan.block.schedule', { blockId, startsOn: null });
}

async function expectNoOverlapAndLengthsAgree(ids: readonly string[]): Promise<void> {
  const ranges: { startsOn: string; endsOn: string }[] = [];
  for (const id of ids) {
    const { calendar } = await ok('plan.block.calendar', { blockId: id });
    const live = await store.getLiveBlockSchedule(id);
    if (calendar.startsOn === null) continue;
    expect(live?.weeksCount).toBe((await store.getTrainingBlock(id))?.weeksCount);
    for (const other of ranges) {
      expect(calendar.startsOn > other.endsOn || other.startsOn > calendar.endsOn).toBe(true);
    }
    ranges.push({ startsOn: calendar.startsOn, endsOn: calendar.endsOn });
  }
}

describe('I3: a current block never moves', () => {
  it('refuses a new start for a current block and leaves its live row unchanged', async () => {
    await block('b1', { startsOn: THIS_MONDAY });

    const moved = await refused('plan.block.schedule', { blockId: 'b1', startsOn: NEXT_MONDAY });
    const cleared = await refused('plan.block.schedule', { blockId: 'b1', startsOn: null });

    expect(moved.code).toBe('BLOCK_STARTED');
    expect(cleared.code).toBe('BLOCK_STARTED');
    expect(moved.message).toContain('plan.week.skip');
    expect(await history('b1')).toHaveLength(1);
  });
});

describe('I6: a dated block and its live row agree on length', () => {
  it('records a resized row when a dated block changes length', async () => {
    await block('b1', { startsOn: NEXT_MONDAY, weeksCount: 4 });

    const updated = await ok('plan.block.update', { blockId: 'b1', weeksCount: 6 });

    expect(updated.scheduleRow).toEqual({ seq: 2, kind: 'resized', changedBy: 'user' });
    expect((await store.getLiveBlockSchedule('b1'))?.weeksCount).toBe(6);
    expect((await store.getTrainingBlock('b1'))?.weeksCount).toBe(6);
    expect(updated.calendar.endsOn).toBe('2026-11-01');
  });

  it('refuses a length change on a dated block through plan.block.create', async () => {
    await block('b1', { startsOn: NEXT_MONDAY, weeksCount: 4 });

    const error = await refused('plan.block.create', {
      id: 'b1',
      programId: 'p1',
      orderIndex: 0,
      name: 'Block b1',
      weeksCount: 6,
    });

    expect(error.code).toBe('USE_BLOCK_UPDATE');
    expect((await store.getTrainingBlock('b1'))?.weeksCount).toBe(4);
  });

  it('refuses shortening a current block below the week it is in', async () => {
    await block('b1', { startsOn: '2026-09-07', weeksCount: 4 });

    const error = await refused('plan.block.update', { blockId: 'b1', weeksCount: 1 });

    expect(error.code).toBe('SHORTER_THAN_TRAINED');
    expect((await store.getTrainingBlock('b1'))?.weeksCount).toBe(4);
  });

  it('writes no row for an undated block and still renames a dated one without a row', async () => {
    await block('u1');
    await block('b1', { orderIndex: 1, startsOn: NEXT_MONDAY });

    const undated = await ok('plan.block.update', { blockId: 'u1', weeksCount: 6 });
    const renamed = await ok('plan.block.update', { blockId: 'b1', name: 'Orientation' });

    expect(undated.scheduleRow).toBeNull();
    expect(renamed.scheduleRow).toBeNull();
    expect(await history('b1')).toHaveLength(1);
  });
});

describe('I7: program order agrees with date order', () => {
  it('refuses dating a later block before an earlier one', async () => {
    await block('b0', { startsOn: '2026-10-05' });

    const error = await refused('plan.block.create', {
      id: 'b1',
      programId: 'p1',
      orderIndex: 1,
      name: 'Second',
      weeksCount: 1,
      startsOn: NEXT_MONDAY,
    });

    expect(error.code).toBe('SCHEDULE_ORDER');
    expect(error.message).toContain('"Block b0"');
  });

  it('refuses moving an earlier block past a later one', async () => {
    await block('b0', { startsOn: NEXT_MONDAY, weeksCount: 1 });
    await block('b1', { orderIndex: 1, startsOn: '2026-09-28', weeksCount: 1 });

    const error = await refused('plan.block.schedule', { blockId: 'b0', startsOn: '2026-10-12' });

    expect(error.code).toBe('SCHEDULE_ORDER');
    expect(await history('b0')).toHaveLength(1);
  });

  it('refuses reordering a dated block through plan.block.create', async () => {
    await block('b0', { startsOn: NEXT_MONDAY });

    const error = await refused('plan.block.create', {
      id: 'b0',
      programId: 'p1',
      orderIndex: 3,
      name: 'Block b0',
      weeksCount: 4,
    });

    expect(error.code).toBe('USE_BLOCK_UPDATE');
  });
});

describe('I8: an ended block gets no new row', () => {
  beforeEach(async () => {
    vi.setSystemTime(new Date('2026-08-01T12:00:00.000Z'));
    await block('b1', { startsOn: '2026-08-03', weeksCount: 2 });
    vi.setSystemTime(new Date(TODAY));
  });

  it.each([
    ['plan.block.schedule', { blockId: 'b1', startsOn: NEXT_MONDAY }, 'BLOCK_ENDED'],
    ['plan.block.schedule', { blockId: 'b1', startsOn: null }, 'BLOCK_ENDED'],
    ['plan.block.update', { blockId: 'b1', weeksCount: 3 }, 'BLOCK_ENDED'],
    ['plan.week.skip', { blockId: 'b1', week: 1 }, 'BLOCK_ENDED'],
    [
      'plan.block.create',
      { id: 'b1', programId: 'p1', orderIndex: 0, name: 'Block b1', weeksCount: 3 },
      'USE_BLOCK_UPDATE',
    ],
    [
      'plan.block.create',
      {
        id: 'b1',
        programId: 'p1',
        orderIndex: 0,
        name: 'Block b1',
        weeksCount: 2,
        startsOn: NEXT_MONDAY,
      },
      'USE_BLOCK_SCHEDULE',
    ],
  ])('%s %j is refused with %s', async (tool, args, code) => {
    const error = await refused(tool, args);

    expect(error.code).toBe(code);
    expect(await history('b1')).toHaveLength(1);
  });

  it('refuses a first date that would leave the block already over', async () => {
    const error = await refused('plan.block.create', {
      programId: 'p1',
      orderIndex: 1,
      name: 'Late',
      weeksCount: 1,
      startsOn: '2026-09-07',
    });

    expect(error.code).toBe('BLOCK_WOULD_BE_ENDED');
  });
});

describe('plan.block.schedule', () => {
  it('writes nothing when the block already starts on that date', async () => {
    await block('b1', { startsOn: NEXT_MONDAY });

    const same = await ok('plan.block.schedule', { blockId: 'b1', startsOn: NEXT_MONDAY });

    expect(same.rows).toEqual([]);
    expect(await history('b1')).toHaveLength(1);
  });

  it('un-dates an upcoming block with a cleared row carrying the previous length', async () => {
    await block('b1', { startsOn: NEXT_MONDAY, weeksCount: 5 });

    const cleared = await ok('plan.block.schedule', {
      blockId: 'b1',
      startsOn: null,
      reason: 'unsure',
    });

    expect(cleared.rows[0]).toMatchObject({ kind: 'cleared', to: null });
    expect(cleared.calendar.state).toBe('undated');
    expect((await history('b1'))[1]).toMatchObject({
      kind: 'cleared',
      startsOn: null,
      weeksCount: 5,
      reason: 'unsure',
    });
  });

  it('re-dates a cleared block with a planned row', async () => {
    await block('b1', { startsOn: NEXT_MONDAY });
    await ok('plan.block.schedule', { blockId: 'b1', startsOn: null });

    const dated = await ok('plan.block.schedule', { blockId: 'b1', startsOn: '2026-09-28' });

    expect(dated.rows[0]).toMatchObject({ seq: 3, kind: 'planned', from: null });
  });
});

describe('plan.week.skip', () => {
  beforeEach(async () => {
    await block('b1', { startsOn: THIS_MONDAY, weeksCount: 3 });
  });

  it('records a hold as the coach default when the lifter did not choose', async () => {
    const skipped = await ok('plan.week.skip', { blockId: 'b1', week: 1, reason: 'travel' });

    expect(skipped.scheduleRow).toEqual({
      seq: 2,
      kind: 'week_skipped',
      changedBy: 'coach-default',
    });
    expect(skipped.weekOf).toBe(THIS_MONDAY);
    expect((await store.getLiveBlockSchedule('b1'))?.skips).toEqual([
      { weekOf: THIS_MONDAY, mode: 'hold', reason: 'travel' },
    ]);
    expect(skipped.calendar.endsOn).toBe('2026-10-04');
    expect(skipped.calendar.weeks[0].skipped).toBe('hold');
  });

  it("records the lifter's own choice as the user's", async () => {
    const skipped = await ok('plan.week.skip', { blockId: 'b1', week: 1, mode: 'hold' });

    expect(skipped.scheduleRow.changedBy).toBe('user');
  });

  it('moves the end a week later on extend and keeps the plan length', async () => {
    const skipped = await ok('plan.week.skip', { blockId: 'b1', week: 1, mode: 'extend' });

    expect(skipped.calendar.endsOn).toBe('2026-10-11');
    expect(skipped.calendar.weeks[1].planWeek).toBe(1);
    expect((await store.getLiveBlockSchedule('b1'))?.weeksCount).toBe(3);
  });

  it('refuses a week that has not started and a week already skipped', async () => {
    const future = await refused('plan.week.skip', { blockId: 'b1', week: 2 });
    await ok('plan.week.skip', { blockId: 'b1', week: 1 });
    const again = await refused('plan.week.skip', { blockId: 'b1', week: 1, mode: 'extend' });

    expect(future.code).toBe('WEEK_NOT_STARTED');
    expect(again.code).toBe('WEEK_ALREADY_SKIPPED');
    expect(await history('b1')).toHaveLength(2);
  });

  it('refuses an upcoming block', async () => {
    await block('b2', { orderIndex: 1, startsOn: '2026-10-05' });

    const error = await refused('plan.week.skip', { blockId: 'b2', week: 1 });

    expect(error.code).toBe('BLOCK_NOT_STARTED');
  });
});

describe('plan.block.calendar', () => {
  it('reports each week with its row, template count and local training days', async () => {
    const created = await ok('plan.block.create', {
      id: 'b1',
      programId: 'p1',
      orderIndex: 0,
      name: 'Block',
      weeksCount: 2,
      startsOn: THIS_MONDAY,
      scaffoldWeeks: true,
    });
    await ok('plan.template.create', { weekId: created.weeks[0].id, name: 'Day A', orderIndex: 0 });
    await seedTrainingDay(store, {
      kind: 'training',
      id: 's1',
      startedAt: '2026-09-16T17:00:00.000Z',
      endedAt: '2026-09-16T18:00:00.000Z',
    });

    const { calendar } = await ok('plan.block.calendar', { blockId: 'b1' });

    expect(calendar.state).toBe('current');
    expect(calendar.weeks[0]).toMatchObject({
      calendarWeek: 1,
      weekId: created.weeks[0].id,
      templateCount: 1,
      sessionDays: ['2026-09-16'],
    });
    expect(calendar.weeks[1]).toMatchObject({ templateCount: 0, sessionDays: [] });
  });
});

describe('plan.block.schedule_history', () => {
  it('lists every row oldest first with the end in force under it', async () => {
    await block('b1', { startsOn: NEXT_MONDAY, weeksCount: 2 });
    await ok('plan.block.schedule', { blockId: 'b1', startsOn: '2026-09-28', reason: 'travel' });

    const rows = await history('b1');

    expect(rows.map((row) => [row.seq, row.kind, row.startsOn, row.endsOn, row.reason])).toEqual([
      [1, 'planned', NEXT_MONDAY, '2026-10-04', null],
      [2, 'moved', '2026-09-28', '2026-10-11', 'travel'],
    ]);
  });
});

describe('plan.week.update', () => {
  it('flags a week as a deload and keeps its place', async () => {
    await block('b0');
    const { week } = await ok('plan.week.create', { blockId: 'b0', orderIndex: 2 });

    const updated = await ok('plan.week.update', { weekId: week.id, isDeload: true });

    expect(updated.week).toMatchObject({ id: week.id, orderIndex: 2, isDeload: true });
  });

  it('refuses an update that changes nothing', async () => {
    const error = await refused('plan.week.update', { weekId: 'w1' });

    expect(error.code).toBe('INVALID_INPUT');
  });
});
