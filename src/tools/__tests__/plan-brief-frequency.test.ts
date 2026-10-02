// The planning brief's day-added advisory (VW-623, B28; rp-s5-frequency-progression-conservative).

import { describe, expect, it } from 'vitest';

import type { StoredTrainingBlock } from '../../store/types.js';
import { readBriefAdvisories } from '../plan-brief-advisories.js';
import {
  readProgramBlockDays,
  trainingDayAddAdvisory,
  type BlockDays,
  type BlockDaysStore,
} from '../plan-brief-frequency.js';

const days = (...counts: (number | null)[]): BlockDays[] =>
  counts.map((trainingDays, i) => ({ name: `Block ${i + 1}`, trainingDays }));

describe('trainingDayAddAdvisory', () => {
  it('warns when the next block adds a day after the count held for 1 block', () => {
    const advisory = trainingDayAddAdvisory(days(3, 4));

    expect(advisory).toMatchObject({
      kind: 'frequency_progression',
      rpIds: ['rp:rp-s5-frequency-progression-conservative'],
    });
    expect(advisory?.text).toContain('"Block 2" plans 4 training days a week, up from 3');
    expect(advisory?.text).toContain('held for 1 block.');
    expect(advisory?.text).toContain('planning prior');
  });

  it('stays quiet when the count held for 2 blocks before the day was added', () => {
    expect(trainingDayAddAdvisory(days(3, 3, 4))).toBeNull();
  });

  it('counts the hold from the last change, not from the start of the program', () => {
    expect(trainingDayAddAdvisory(days(3, 3, 4, 5))?.text).toContain('held for 1 block.');
    expect(trainingDayAddAdvisory(days(3, 3, 4, 4, 5))).toBeNull();
  });

  it('skips a block with no planned days when counting the hold', () => {
    expect(trainingDayAddAdvisory(days(3, null, 3, 4))).toBeNull();
  });

  it('stays quiet when the next block keeps or drops the count, or has no days yet', () => {
    expect(trainingDayAddAdvisory(days(3, 3))).toBeNull();
    expect(trainingDayAddAdvisory(days(4, 3))).toBeNull();
    expect(trainingDayAddAdvisory(days(3, null))).toBeNull();
    expect(trainingDayAddAdvisory(days(4))).toBeNull();
  });
});

function block(id: string, orderIndex: number): StoredTrainingBlock {
  return { id, programId: 'p', orderIndex, name: id, weeksCount: 2 };
}

/** A program whose blocks each run one training week plus a 7-day deload week. */
function storeOf(dayLabelsByBlock: Record<string, string[]>): BlockDaysStore {
  const blocks = Object.keys(dayLabelsByBlock).map((id, i) => block(id, i));
  return {
    getTrainingBlocksForProgram: async () => blocks,
    getTrainingWeeksForBlock: async (blockId) => [
      { id: `${blockId}-train`, orderIndex: 0, isDeload: false },
      { id: `${blockId}-deload`, orderIndex: 1, isDeload: true },
    ],
    getWorkoutTemplatesForWeek: async (weekId) =>
      weekId.endsWith('-deload')
        ? WEEKDAY_LABELS.map((dayLabel) => ({ dayLabel }))
        : (dayLabelsByBlock[weekId.replace('-train', '')] ?? []).map((dayLabel) => ({ dayLabel })),
  };
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

describe('readProgramBlockDays through the brief', () => {
  const store = storeOf({
    a: ['Mon', 'Wed', 'Fri'],
    b: ['Mon', 'Tue', 'Thu', 'Fri'],
    c: ['Mon', 'Tue', 'Thu', 'Fri'],
  });

  it('reads blocks up to the next one and ignores deload weeks', async () => {
    expect(await readProgramBlockDays(store, block('b', 1))).toEqual([
      { name: 'a', trainingDays: 3 },
      { name: 'b', trainingDays: 4 },
    ]);
  });

  it('puts the advisory on the brief when the block to plan adds a day too soon', async () => {
    const state = {
      store: { ...store, listPriorities: async () => [] },
    } as unknown as Parameters<typeof readBriefAdvisories>[0];
    const quiet = {
      readFlatline: async () => null,
      readTier: async () => ({ tier: 'beginner' as const, declared: null }),
      readDatedBlocks: async () => [],
    };

    const addsDay = await readBriefAdvisories(state, null, quiet, block('b', 1));
    const keepsDays = await readBriefAdvisories(state, null, quiet, block('c', 2));

    expect(addsDay.map((a) => a.kind)).toEqual(['frequency_progression']);
    expect(keepsDays).toEqual([]);
  });
});
