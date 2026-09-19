// `block_schedules` (VW-473): the append-only history of each block's calendar. Invariants
// I1 (append-only), I4 (a skip appends one row and leaves the rest byte-identical) and I11
// (seq is gap-free per block) are pinned here; I5 lives in the local-time test file.

import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import { SqliteSessionStore } from '../sqlite-store.js';
import type { AppendBlockScheduleInput, SessionStore } from '../types.js';

const MONDAY = '2026-09-21';
const AT = '2026-09-19T12:00:00.000Z';

let store: SqliteSessionStore;

beforeEach(async () => {
  store = SqliteSessionStore.open(':memory:');
  await store.putTrainingProgram({ id: 'prog', name: 'Return', createdAt: AT });
  await store.putTrainingBlock({
    id: 'blk',
    programId: 'prog',
    orderIndex: 0,
    name: 'Orientation',
    weeksCount: 6,
  });
});
afterEach(async () => {
  await store.close();
});

function planned(over: Partial<AppendBlockScheduleInput> = {}): AppendBlockScheduleInput {
  return {
    blockId: 'blk',
    startsOn: MONDAY,
    weeksCount: 6,
    skips: [],
    kind: 'planned',
    changedBy: 'user',
    declaredAt: AT,
    ...over,
  };
}

function dbOf(): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

/** Every column of every row, in seq order, exactly as stored. */
function rawRows(): unknown[] {
  return dbOf().prepare(`SELECT * FROM block_schedules WHERE block_id = 'blk' ORDER BY seq`).all();
}

function codeOf(run: () => unknown): Promise<string | undefined> {
  return failureOf(run, (err) => err.code);
}

function messageOf(run: () => unknown): Promise<string | undefined> {
  return failureOf(run, (err) => err.message);
}

function failureOf(
  run: () => unknown,
  pick: (err: Error & { code?: string }) => string | undefined,
): Promise<string | undefined> {
  return Promise.resolve()
    .then(run)
    .then(
      () => undefined,
      (err: unknown) => pick(err as Error & { code?: string }),
    );
}

describe('appending schedule rows', () => {
  it('numbers each block’s rows 1, 2, 3 with no gap (I11)', async () => {
    await store.appendBlockSchedule(planned());
    await store.appendBlockSchedule(planned({ kind: 'moved', startsOn: '2026-09-28' }));
    await store.appendBlockSchedule(planned({ kind: 'resized', weeksCount: 5 }));

    const history = await store.listBlockScheduleHistory('blk');

    expect(history.map((row) => row.seq)).toEqual([1, 2, 3]);
  });

  it('refuses a second row with a seq the block already has, so racing writers conflict (I11)', async () => {
    await store.appendBlockSchedule(planned());

    const message = await messageOf(() =>
      dbOf()
        .prepare(
          `INSERT INTO block_schedules (id, block_id, seq, starts_on, weeks_count, kind, changed_by, declared_at)
           VALUES ('dup', 'blk', 1, '${MONDAY}', 6, 'planned', 'user', '${AT}')`,
        )
        .run(),
    );

    expect(message).toMatch(/UNIQUE/);
  });

  it('reads the highest seq as the live row, and the history oldest first', async () => {
    await store.appendBlockSchedule(planned());
    await store.appendBlockSchedule(
      planned({ kind: 'moved', startsOn: '2026-09-28', reason: 'travel' }),
    );

    const live = await store.getLiveBlockSchedule('blk');
    const listed = await store.listLiveBlockSchedules();

    expect(live).toMatchObject({ seq: 2, startsOn: '2026-09-28', kind: 'moved', reason: 'travel' });
    expect(listed).toEqual([live]);
  });

  it('keeps a cleared row as the live row, so the block reads undated with its history intact', async () => {
    await store.appendBlockSchedule(planned());
    await store.appendBlockSchedule(planned({ kind: 'cleared', startsOn: undefined }));

    const live = await store.getLiveBlockSchedule('blk');

    expect(live?.kind).toBe('cleared');
    expect(live?.startsOn).toBeUndefined();
    expect(await store.listBlockScheduleHistory('blk')).toHaveLength(2);
  });

  it('reads an undated block as having no live row', async () => {
    expect(await store.getLiveBlockSchedule('blk')).toBeUndefined();
  });
});

describe('append-only (I1)', () => {
  it('aborts any UPDATE with the trigger’s message', async () => {
    await store.appendBlockSchedule(planned());

    const message = await messageOf(() =>
      dbOf().prepare(`UPDATE block_schedules SET weeks_count = 7`).run(),
    );

    expect(message).toMatch(/append-only/);
  });

  it('exposes no store method that could edit or delete a row', () => {
    type ScheduleMethods = Extract<keyof SessionStore, `${string}BlockSchedule${string}`>;
    expectTypeOf<ScheduleMethods>().toEqualTypeOf<
      | 'appendBlockSchedule'
      | 'getLiveBlockSchedule'
      | 'listLiveBlockSchedules'
      | 'listBlockScheduleHistory'
    >();
  });

  it('refuses to delete a block that has schedule history, and foreign keys are on', async () => {
    await store.appendBlockSchedule(planned());

    const foreignKeys = dbOf().prepare('PRAGMA foreign_keys').get() as {
      foreign_keys: number;
    };
    const message = await messageOf(() =>
      dbOf().prepare(`DELETE FROM training_blocks WHERE id = 'blk'`).run(),
    );

    expect(foreignKeys.foreign_keys).toBe(1);
    expect(message).toMatch(/FOREIGN KEY/);
    expect(await store.listBlockScheduleHistory('blk')).toHaveLength(1);
  });
});

describe('a week skip (I4)', () => {
  it('appends exactly one row and leaves every earlier row byte-identical', async () => {
    await store.appendBlockSchedule(planned());
    await store.appendBlockSchedule(planned({ kind: 'moved', startsOn: '2026-09-28' }));
    const before = rawRows();

    await store.appendBlockSchedule(
      planned({
        kind: 'week_skipped',
        startsOn: '2026-09-28',
        skips: [{ weekOf: '2026-10-12', mode: 'hold', reason: 'travel' }],
        changedBy: 'coach-default',
      }),
    );
    const after = rawRows();

    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(0, before.length)).toEqual(before);
    expect((await store.getLiveBlockSchedule('blk'))?.skips).toEqual([
      { weekOf: '2026-10-12', mode: 'hold', reason: 'travel' },
    ]);
  });
});

describe('what the store refuses', () => {
  it.each([
    ['a start that is not a Monday', planned({ startsOn: '2026-09-22' })],
    ['a start that is not a date', planned({ startsOn: '2026-02-30' })],
    ['no weeks', planned({ weeksCount: 0 })],
    ['a skip not on a Monday', planned({ skips: [{ weekOf: '2026-09-23', mode: 'hold' }] })],
    [
      'two skips on one week',
      planned({
        skips: [
          { weekOf: '2026-09-28', mode: 'hold' },
          { weekOf: '2026-09-28', mode: 'extend' },
        ],
      }),
    ],
    ['a skip before the block', planned({ skips: [{ weekOf: '2026-09-14', mode: 'hold' }] })],
    ['a skip after the block', planned({ skips: [{ weekOf: '2026-11-02', mode: 'extend' }] })],
  ])('refuses %s', async (_name, input) => {
    expect(await codeOf(() => store.appendBlockSchedule(input))).toBe('BLOCK_SCHEDULE_INVALID');
    expect(await store.listBlockScheduleHistory('blk')).toEqual([]);
  });

  it('accepts a skip in the week an earlier extend opened past the planned end', async () => {
    const row = await store.appendBlockSchedule(
      planned({
        kind: 'week_skipped',
        skips: [
          { weekOf: '2026-09-28', mode: 'extend' },
          { weekOf: '2026-11-02', mode: 'hold' },
        ],
      }),
    );

    expect(row.seq).toBe(1);
  });

  it('refuses a dated row of a kind other than cleared with no start, at the table', async () => {
    const message = await messageOf(() =>
      dbOf()
        .prepare(
          `INSERT INTO block_schedules (id, block_id, seq, weeks_count, kind, changed_by, declared_at)
           VALUES ('x', 'blk', 1, 6, 'planned', 'user', '${AT}')`,
        )
        .run(),
    );

    expect(message).toMatch(/CHECK/);
  });
});

describe('goal_targets.block_id', () => {
  it('round-trips the block a target was set for', async () => {
    await store.putPriority({
      id: 'pri',
      userId: 'local',
      horizonWeeks: 6,
      kind: 'muscle',
      ref: 'bodyweight',
      level: 'maintain',
      declaredAt: AT,
      mesosHeld: 0,
    });
    await store.putGoalTarget({
      id: 'tgt',
      priorityId: 'pri',
      metric: 'bodyweight',
      blockId: 'blk',
      startValue: 190,
      startMeasuredAt: AT,
      bandLowPctPerWeek: 0,
      bandHighPctPerWeek: -0.5,
      committedValue: 190,
      stretchValue: 184.3,
      basis: 'rp_ramp',
      infoLevel: 'ramp',
      tierUsed: 'intermediate',
      tierProvisional: false,
      dietPhaseAtDerivation: 'recomposition',
      acknowledgedStretch: false,
      derivedAt: AT,
      endsAt: '2026-11-02T00:00:00.000Z',
    });

    const [target] = await store.listGoalTargets({ priorityId: 'pri' });

    expect(target?.blockId).toBe('blk');
  });
});
