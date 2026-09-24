// Tests for the `priorities` and `goal_targets` writers and readers (VW-349).
//
// A priority is the human's declaration; a target is the coach's derived band
// over it. Coverage shape:
//   * Round-trips both shapes, including every optional column.
//   * putPriority upserts on id and PRESERVES CHILD TARGETS — the mutation
//     control for this is the `INSERT OR REPLACE` swap noted below.
//   * listPriorities / listGoalTargets exclude retired rows by default.
//   * retirePriority cascades as a MARK, not a delete: live targets end with
//     outcome 'abandoned', already-retired ones keep their own outcome.
//   * putGoalTarget refuses to move committed/stretch once accepted.
//   * A genuine DELETE of a priority still cascades its targets away, so an
//     orphan band cannot exist.
//
// MUTATION CONTROL. Changing `PUT_PRIORITY_SQL` from `INSERT ... ON CONFLICT(id)
// DO UPDATE` to `INSERT OR REPLACE INTO priorities` fails
// "keeps child targets across a priority upsert" — the REPLACE deletes the
// parent row, the FK cascade takes its targets with it, and the surviving
// target count reads 0 instead of 1.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { LOCAL_USER_ID, type SqliteSessionStore } from '../sqlite-store.js';
import type { StoredGoalTarget, StoredPriority } from '../types.js';
import { openSqliteTestStore } from './open-test-store.js';

function open(): SqliteSessionStore {
  return openSqliteTestStore();
}

function priority(overrides: Partial<StoredPriority> = {}): StoredPriority {
  return {
    id: 'pri-bench',
    userId: LOCAL_USER_ID,
    horizonWeeks: 12,
    kind: 'lift',
    ref: 'ex-bench-press',
    level: 'specialize',
    declaredAt: '2026-09-13T18:00:00.000Z',
    mesosHeld: 0,
    ...overrides,
  };
}

function target(overrides: Partial<StoredGoalTarget> = {}): StoredGoalTarget {
  return {
    id: 'tgt-bench-top-load',
    priorityId: 'pri-bench',
    metric: 'top_load_at_reps',
    startValue: 185,
    startMeasuredAt: '2026-09-10T17:00:00.000Z',
    bandLowPctPerWeek: 0.5,
    bandHighPctPerWeek: 1.5,
    committedValue: 195,
    stretchValue: 205,
    basis: 'rp_ramp',
    infoLevel: 'ramp',
    tierUsed: 'intermediate',
    tierProvisional: false,
    dietPhaseAtDerivation: 'maintenance',
    acknowledgedStretch: false,
    derivedAt: '2026-09-13T18:05:00.000Z',
    endsAt: '2026-12-06T18:05:00.000Z',
    ...overrides,
  };
}

describe('putPriority / listPriorities', () => {
  it('round-trips a declaration with every optional column absent', async () => {
    const store = open();
    const written = await store.putPriority(priority());

    expect(written).toEqual(priority());
    expect(await store.listPriorities(LOCAL_USER_ID)).toEqual([priority()]);
  });

  it('round-trips blockId, retiredAt and mesosHeld', async () => {
    const store = open();
    const full = priority({
      blockId: undefined,
      retiredAt: '2026-11-01T00:00:00.000Z',
      mesosHeld: 3,
    });
    await store.putPriority(full);

    const rows = await store.listPriorities(LOCAL_USER_ID, { includeRetired: true });
    expect(rows).toEqual([full]);
  });

  it('upserts on id: a level change edits the row rather than adding one', async () => {
    const store = open();
    await store.putPriority(priority());
    const edited = await store.putPriority(priority({ level: 'maintain', mesosHeld: 1 }));

    expect(edited.level).toBe('maintain');
    expect(edited.mesosHeld).toBe(1);
    expect(await store.listPriorities(LOCAL_USER_ID)).toEqual([edited]);
  });

  it('keeps child targets across a priority upsert', async () => {
    const store = open();
    await store.putPriority(priority());
    await store.putGoalTarget(target());

    await store.putPriority(priority({ level: 'maintain' }));

    expect(await store.listGoalTargets({ priorityId: 'pri-bench' })).toHaveLength(1);
  });

  it('excludes retired declarations unless asked for them', async () => {
    const store = open();
    await store.putPriority(priority());
    await store.putPriority(priority({ id: 'pri-arms', kind: 'muscle', ref: 'biceps' }));
    await store.retirePriority('pri-arms', '2026-10-01T00:00:00.000Z');

    expect((await store.listPriorities(LOCAL_USER_ID)).map((p) => p.id)).toEqual(['pri-bench']);
    expect(
      (await store.listPriorities(LOCAL_USER_ID, { includeRetired: true })).map((p) => p.id),
    ).toEqual(['pri-arms', 'pri-bench']);
  });

  it('returns newest declaration first', async () => {
    const store = open();
    await store.putPriority(priority({ id: 'pri-old', declaredAt: '2026-01-01T00:00:00.000Z' }));
    await store.putPriority(priority({ id: 'pri-new', declaredAt: '2026-06-01T00:00:00.000Z' }));

    expect((await store.listPriorities(LOCAL_USER_ID)).map((p) => p.id)).toEqual([
      'pri-new',
      'pri-old',
    ]);
  });
});

describe('putGoalTarget / listGoalTargets', () => {
  it('round-trips a derived band with every optional column absent', async () => {
    const store = open();
    await store.putPriority(priority());
    const written = await store.putGoalTarget(target());

    expect(written).toEqual(target());
    expect(await store.listGoalTargets({ priorityId: 'pri-bench' })).toEqual([target()]);
  });

  it('round-trips exerciseId, anchorReps, acceptedBy, the two flags and newChapterAt', async () => {
    const store = open();
    await store.putPriority(priority());
    const full = target({
      exerciseId: 'ex-bench-press',
      anchorReps: 8,
      tierProvisional: true,
      acceptedBy: 'user',
      acknowledgedStretch: true,
      newChapterAt: '2026-10-15T00:00:00.000Z',
    });
    await store.putGoalTarget(full);

    expect(await store.listGoalTargets({ priorityId: 'pri-bench' })).toEqual([full]);
  });

  it('lists every target under a user across priorities', async () => {
    const store = open();
    await store.putPriority(priority());
    await store.putPriority(priority({ id: 'pri-arms', kind: 'muscle', ref: 'biceps' }));
    await store.putGoalTarget(target());
    await store.putGoalTarget(
      target({
        id: 'tgt-curl',
        priorityId: 'pri-arms',
        derivedAt: '2026-09-13T18:06:00.000Z',
      }),
    );

    expect((await store.listGoalTargets({ userId: LOCAL_USER_ID })).map((t) => t.id)).toEqual([
      'tgt-curl',
      'tgt-bench-top-load',
    ]);
  });

  it('re-derives a proposed target freely, numbers included', async () => {
    const store = open();
    await store.putPriority(priority());
    await store.putGoalTarget(target());

    const redone = await store.putGoalTarget(
      target({ committedValue: 190, stretchValue: 200, basis: 'own_slope', infoLevel: 'own' }),
    );

    expect(redone.committedValue).toBe(190);
    expect(redone.basis).toBe('own_slope');
    expect(await store.listGoalTargets({ priorityId: 'pri-bench' })).toHaveLength(1);
  });

  it('refuses to move committedValue once the target is accepted', async () => {
    const store = open();
    await store.putPriority(priority());
    await store.putGoalTarget(target({ acceptedBy: 'user' }));

    await expect(
      store.putGoalTarget(target({ acceptedBy: 'user', committedValue: 190 })),
    ).rejects.toMatchObject({ code: 'GOAL_TARGET_FIXED' });

    const stored = await store.listGoalTargets({ priorityId: 'pri-bench' });
    expect(stored[0]?.committedValue).toBe(195);
  });

  it('refuses to move stretchValue once the target is accepted', async () => {
    const store = open();
    await store.putPriority(priority());
    await store.putGoalTarget(target({ acceptedBy: 'coach-default' }));

    await expect(
      store.putGoalTarget(target({ acceptedBy: 'coach-default', stretchValue: 260 })),
    ).rejects.toMatchObject({ code: 'GOAL_TARGET_FIXED' });
  });

  it('still allows an accepted target to record progress that is not its numbers', async () => {
    const store = open();
    await store.putPriority(priority());
    await store.putGoalTarget(target({ acceptedBy: 'coach-default' }));

    const updated = await store.putGoalTarget(
      target({ acceptedBy: 'user', acknowledgedStretch: true }),
    );

    expect(updated.acceptedBy).toBe('user');
    expect(updated.acknowledgedStretch).toBe(true);
  });
});

describe('retireGoalTarget / setGoalTargetNewChapter', () => {
  it('retires one target with its outcome and hides it from the default read', async () => {
    const store = open();
    await store.putPriority(priority());
    await store.putGoalTarget(target());

    const retired = await store.retireGoalTarget(
      'tgt-bench-top-load',
      'met',
      '2026-12-06T18:00:00.000Z',
    );

    expect(retired?.outcome).toBe('met');
    expect(retired?.retiredAt).toBe('2026-12-06T18:00:00.000Z');
    expect(await store.listGoalTargets({ priorityId: 'pri-bench' })).toEqual([]);
    expect(
      await store.listGoalTargets({ priorityId: 'pri-bench' }, { includeRetired: true }),
    ).toEqual([retired]);
  });

  it('keeps the first outcome when retired twice', async () => {
    const store = open();
    await store.putPriority(priority());
    await store.putGoalTarget(target());
    await store.retireGoalTarget('tgt-bench-top-load', 'met', '2026-12-06T18:00:00.000Z');

    const second = await store.retireGoalTarget(
      'tgt-bench-top-load',
      'missed',
      '2026-12-20T18:00:00.000Z',
    );

    expect(second?.outcome).toBe('met');
    expect(second?.retiredAt).toBe('2026-12-06T18:00:00.000Z');
  });

  it('returns undefined for an unknown target', async () => {
    const store = open();
    expect(await store.retireGoalTarget('nope', 'met', '2026-12-06T18:00:00.000Z')).toBeUndefined();
    expect(await store.setGoalTargetNewChapter('nope', '2026-12-06T18:00:00.000Z')).toBeUndefined();
  });

  it('stamps a new chapter without retiring the target or moving its numbers', async () => {
    const store = open();
    await store.putPriority(priority());
    await store.putGoalTarget(target({ acceptedBy: 'user' }));

    const stamped = await store.setGoalTargetNewChapter(
      'tgt-bench-top-load',
      '2026-10-15T00:00:00.000Z',
    );

    expect(stamped?.newChapterAt).toBe('2026-10-15T00:00:00.000Z');
    expect(stamped?.retiredAt).toBeUndefined();
    expect(stamped?.committedValue).toBe(195);
  });
});

describe('retirePriority cascade', () => {
  it('marks every live target abandoned rather than deleting it', async () => {
    const store = open();
    await store.putPriority(priority());
    await store.putGoalTarget(target());
    await store.putGoalTarget(target({ id: 'tgt-bench-e1rm', metric: 'e1rm_trend' }));

    const retired = await store.retirePriority('pri-bench', '2026-10-01T00:00:00.000Z');

    expect(retired?.retiredAt).toBe('2026-10-01T00:00:00.000Z');
    expect(await store.listGoalTargets({ priorityId: 'pri-bench' })).toEqual([]);
    const kept = await store.listGoalTargets({ priorityId: 'pri-bench' }, { includeRetired: true });
    expect(kept).toHaveLength(2);
    expect(kept.map((t) => t.outcome)).toEqual(['abandoned', 'abandoned']);
    expect(kept.every((t) => t.retiredAt === '2026-10-01T00:00:00.000Z')).toBe(true);
  });

  it('leaves an already-retired target with the outcome it earned', async () => {
    const store = open();
    await store.putPriority(priority());
    await store.putGoalTarget(target());
    await store.retireGoalTarget('tgt-bench-top-load', 'met', '2026-09-20T00:00:00.000Z');

    await store.retirePriority('pri-bench', '2026-10-01T00:00:00.000Z');

    const kept = await store.listGoalTargets({ priorityId: 'pri-bench' }, { includeRetired: true });
    expect(kept[0]?.outcome).toBe('met');
    expect(kept[0]?.retiredAt).toBe('2026-09-20T00:00:00.000Z');
  });

  it('keeps the first retiredAt when retired twice', async () => {
    const store = open();
    await store.putPriority(priority());
    await store.retirePriority('pri-bench', '2026-10-01T00:00:00.000Z');

    const second = await store.retirePriority('pri-bench', '2026-11-01T00:00:00.000Z');

    expect(second?.retiredAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('returns undefined for an unknown priority', async () => {
    const store = open();
    expect(await store.retirePriority('nope', '2026-10-01T00:00:00.000Z')).toBeUndefined();
  });
});

describe('goal_targets foreign key', () => {
  it('refuses a target whose priority does not exist', async () => {
    const store = open();
    await expect(store.putGoalTarget(target())).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it('cascades a genuine priority DELETE so no orphan band survives', async () => {
    // Exercises the DDL's ON DELETE CASCADE directly. The store has no delete
    // path — retirement MARKS — so this runs the DELETE on a second connection
    // against the same file. The cascade is what stops a hand-edited or
    // future-deleting caller leaving a band with nothing explaining it.
    const dir = mkdtempSync(join(tmpdir(), 'vmcp-goal-fk-'));
    const path = join(dir, 'goals.sqlite');
    try {
      const store = openSqliteTestStore({ path });
      await store.putPriority(priority());
      await store.putGoalTarget(target());
      await store.close();

      const db = new DatabaseSync(path);
      try {
        db.exec('PRAGMA foreign_keys = ON');
        db.prepare(`DELETE FROM priorities WHERE id = ?`).run('pri-bench');
        const row = db.prepare(`SELECT COUNT(*) AS n FROM goal_targets`).get() as { n: number };
        expect(row.n).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
