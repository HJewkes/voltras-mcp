// The goal horizon walks past its named block onto the program's later dated blocks (VW-510).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteSessionStore } from '../../store/sqlite-store.js';
import type { StoredPriority } from '../../store/types.js';
import { readDerivationContext, UNDATED_MESO_WEEKS } from '../goal-derivation.js';

let store: SqliteSessionStore;

beforeEach(async () => {
  store = SqliteSessionStore.open(':memory:');
  await store.putTrainingProgram({ id: 'p', name: 'Program', createdAt: '2026-09-01T00:00:00Z' });
});

afterEach(async () => {
  await store.close();
});

/** A block of `weeks` weeks at `orderIndex`, the 1-based weeks in `deloads` flagged, dated when `startsOn` is set. */
async function block(
  id: string,
  orderIndex: number,
  weeks: number,
  deloads: readonly number[],
  startsOn?: string,
): Promise<void> {
  await store.putTrainingBlock({ id, programId: 'p', orderIndex, name: id, weeksCount: weeks });
  for (let i = 0; i < weeks; i++) {
    const isDeload = deloads.includes(i + 1);
    await store.putTrainingWeek({ id: `${id}-w${i}`, blockId: id, orderIndex: i, isDeload });
  }
  if (startsOn === undefined) return;
  await store.appendBlockSchedule({
    blockId: id,
    startsOn,
    weeksCount: weeks,
    skips: [],
    kind: 'planned',
    changedBy: 'user',
    declaredAt: '2026-09-01T00:00:00Z',
  });
}

function priority(overrides: Partial<StoredPriority> = {}): StoredPriority {
  return {
    id: 'pri',
    userId: 'local',
    horizonWeeks: 12,
    kind: 'lift',
    ref: 'bench-press',
    level: 'specialize',
    declaredAt: '2026-09-01T00:00:00Z',
    mesosHeld: 0,
    ...overrides,
  } as StoredPriority;
}

const flags = (weeks: { isDeload: boolean; blockOrdinal?: number }[]) =>
  weeks.map((week) => `${week.blockOrdinal}${week.isDeload ? 'D' : ''}`);

describe('readHorizonWeeks across blocks', () => {
  it('reads a 12-week priority on a 4-week block through the next two dated blocks', async () => {
    await block('a', 0, 4, [4], '2026-09-07');
    await block('b', 1, 4, [4], '2026-10-05');
    await block('c', 2, 4, [4], '2026-11-02');

    const context = await readDerivationContext({ store }, priority({ blockId: 'a' }));

    expect(context.horizonWeeks).toBe(12);
    expect(flags(context.weeks)).toEqual([
      '0',
      '0',
      '0',
      '0D',
      '1',
      '1',
      '1',
      '1D',
      '2',
      '2',
      '2',
      '2D',
    ]);
  });

  it('stops at the first undated block and splits the rest into default-length blocks', async () => {
    await block('a', 0, 4, [], '2026-09-07');
    await block('b', 1, 4, [4]);
    await block('c', 2, 4, [], '2026-11-02');

    const context = await readDerivationContext({ store }, priority({ blockId: 'a' }));

    expect(context.weeks.slice(4).every((week) => !week.isDeload)).toBe(true);
    expect(context.weeks.map((week) => week.blockOrdinal)).toEqual([
      0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2,
    ]);
    expect(context.notes.join(' ')).toContain('Weeks 5 to 12');
  });

  it('splits a horizon with no plan tree into default-length blocks from week 1', async () => {
    const context = await readDerivationContext({ store }, priority());

    expect(context.weeks).toHaveLength(12);
    expect(context.weeks.filter((week) => week.blockOrdinal === 0)).toHaveLength(
      UNDATED_MESO_WEEKS,
    );
    expect(context.notes.join(' ')).toContain('ENGINEERING DEFAULT');
  });

  it('still truncates at the horizon when the named block is longer', async () => {
    await block('a', 0, 6, [6], '2026-09-07');

    const context = await readDerivationContext(
      { store },
      priority({ blockId: 'a', horizonWeeks: 4 }),
    );

    expect(flags(context.weeks)).toEqual(['0', '0', '0', '0']);
  });
});
