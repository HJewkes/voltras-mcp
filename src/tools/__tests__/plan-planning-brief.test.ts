// The planning brief's staleness and deload-cadence advisories (VW-558 S10).

import { describe, expect, it } from 'vitest';

import type { Flatline } from '../../analytics/flatline.js';
import type { StoredPriority, StoredTrainingBlock } from '../../store/types.js';
import { readBriefAdvisories, type FlatlineReader } from '../plan-brief-advisories.js';

const FLAT: Flatline = {
  days: 28,
  points: 5,
  slopeLbsPerWeek: 0.1,
  flatBelowLbsPerWeek: 0.6,
  reasoning: 'Moved 0.1 per week over 28 days (5 points)',
};

function block(id: string, weeksCount: number): StoredTrainingBlock {
  return { id, programId: 'p', orderIndex: 0, name: id, weeksCount };
}

function liftPriority(ref: string): StoredPriority {
  return {
    id: `pri-${ref}`,
    userId: 'local',
    horizonWeeks: 6,
    kind: 'lift',
    ref,
  } as StoredPriority;
}

/** A store holding `priorities` and blocks whose weeks are the deload flags in `weeks`. */
function stateOf(priorities: StoredPriority[], weeks: Record<string, boolean[]>) {
  const blocks = Object.keys(weeks).map((id) => block(id, weeks[id]!.length));
  const store = {
    listPriorities: async () => priorities,
    getTrainingWeeksForBlock: async (id: string) =>
      (weeks[id] ?? []).map((isDeload, orderIndex) => ({
        id: `${id}-${orderIndex}`,
        blockId: id,
        orderIndex,
        isDeload,
      })),
    getTrainingBlocksForProgram: async () => blocks,
  };
  return { store } as unknown as Parameters<typeof readBriefAdvisories>[0];
}

const everyLiftFlat: FlatlineReader = async () => FLAT;
const nothingFlat: FlatlineReader = async () => null;

describe('staleness advisory', () => {
  it('names a declared main lift on an open flatline and cites the swap rule', async () => {
    const state = stateOf([liftPriority('bench-press')], {});

    const advisories = await readBriefAdvisories(state, null, everyLiftFlat);

    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toMatchObject({ kind: 'staleness', exerciseId: 'bench-press' });
    expect(advisories[0]!.rpIds).toEqual(['rp:rp-s7-sfr-staleness-exercise-swap-trigger']);
  });

  it('says nothing about a flat lift nobody declared as a priority', async () => {
    const flatAsked: string[] = [];
    const reader: FlatlineReader = async (_state, id) => (flatAsked.push(id), FLAT);
    const muscle = { ...liftPriority('glutes'), kind: 'muscle' } as StoredPriority;

    const advisories = await readBriefAdvisories(stateOf([muscle], {}), null, reader);

    expect(advisories).toEqual([]);
    expect(flatAsked).toEqual([]);
  });
});

describe('deload cadence advisory', () => {
  it('flags a 7-week finishing block with no deload and states the program record', async () => {
    const state = stateOf([], { long: Array(7).fill(false), earlier: [false, false, false, true] });

    const [advisory] = await readBriefAdvisories(state, block('long', 7), nothingFlat);

    expect(advisory?.kind).toBe('deload_cadence');
    expect(advisory?.text).toContain('has 7 weeks and no deload week');
    expect(advisory?.text).toContain("1 of this program's 2 blocks planned a deload week");
  });

  it('flags six accumulation weeks before a deload', async () => {
    const state = stateOf([], { b: [...Array(6).fill(false), true] });

    const [advisory] = await readBriefAdvisories(state, block('b', 7), nothingFlat);

    expect(advisory?.text).toContain('runs 6 accumulation weeks before its deload');
  });

  it('stays quiet for a 5:1 block', async () => {
    const state = stateOf([], { b: [...Array(5).fill(false), true] });

    expect(await readBriefAdvisories(state, block('b', 6), nothingFlat)).toEqual([]);
  });
});
