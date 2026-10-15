// The planning brief's staleness and cadence advisories (VW-558 S10, VW-619).

import { describe, expect, it } from 'vitest';

import type { Flatline } from '../../analytics/stall-step.js';
import type { StoredPriority, StoredTrainingBlock } from '../../store/types.js';
import {
  readBriefAdvisories,
  type AdvisoryReaders,
  type FlatlineReader,
} from '../plan-brief-advisories.js';
import type { DatedBlockWeeks } from '../plan-brief-cadence.js';
import type { Tier } from '../tier-signal.js';

const FLAT: Flatline = {
  days: 28,
  points: 5,
  slopeLbsPerWeek: 0.1,
  flatBelowLbsPerWeek: 0.6,
  reasoning: 'Moved 0.1 per week over 28 days (5 points)',
};

const TODAY = '2026-10-01';

function block(id: string, weeksCount: number, orderIndex = 0): StoredTrainingBlock {
  return { id, programId: 'p', orderIndex, name: id, weeksCount };
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

/** A store holding `priorities` and blocks, in key order, whose weeks are the deload flags. */
function stateOf(priorities: StoredPriority[], weeks: Record<string, boolean[]>) {
  const blocks = Object.keys(weeks).map((id, i) => block(id, weeks[id]!.length, i));
  const store = {
    listPriorities: async () => priorities,
    getTrainingWeeksForBlock: async (id: string) =>
      (weeks[id] ?? []).map((isDeload, orderIndex) => ({
        id: `${id}-${orderIndex}`,
        blockId: id,
        orderIndex,
        isDeload,
      })),
    getWorkoutTemplatesForWeek: async () => [{ id: 't' }],
    getTrainingBlocksForProgram: async () => blocks,
  };
  return { store } as unknown as Parameters<typeof readBriefAdvisories>[0];
}

function readers(
  tier: Tier,
  declared: Tier | null = tier,
  dated: DatedBlockWeeks[] = [],
): Partial<AdvisoryReaders> {
  return {
    readFlatline: async () => null,
    readTier: async () => ({ tier, declared }),
    readDatedBlocks: async () => dated,
    today: TODAY,
  };
}

const intermediate = readers('intermediate');
/** A declared advanced lifter: the clamp never derives advanced, so the signal reads intermediate. */
const advanced = readers('intermediate', 'advanced');
const everyLiftFlat: FlatlineReader = async () => FLAT;

const accumulation = (weeks: number): boolean[] => Array<boolean>(weeks).fill(false);
const ratio = (weeks: number): boolean[] => [...accumulation(weeks), true];

describe('staleness advisory', () => {
  it('names a declared main lift on an open flatline and cites the swap rule', async () => {
    const state = stateOf([liftPriority('bench-press')], {});

    const advisories = await readBriefAdvisories(state, null, {
      ...intermediate,
      readFlatline: everyLiftFlat,
    });

    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toMatchObject({ kind: 'staleness', exerciseId: 'bench-press' });
    expect(advisories[0]!.rpIds).toEqual(['rp:rp-s7-sfr-staleness-exercise-swap-trigger']);
  });

  it('says nothing about a flat lift nobody declared as a priority', async () => {
    const flatAsked: string[] = [];
    const reader: FlatlineReader = async (_state, id) => (flatAsked.push(id), FLAT);
    const muscle = { ...liftPriority('glutes'), kind: 'muscle' } as StoredPriority;

    const advisories = await readBriefAdvisories(stateOf([muscle], {}), null, {
      ...intermediate,
      readFlatline: reader,
    });

    expect(advisories).toEqual([]);
    expect(flatAsked).toEqual([]);
  });
});

describe('deload cadence advisory', () => {
  it('says nothing to a declared advanced lifter the clamp holds at beginner', async () => {
    const state = stateOf([], { long: accumulation(8) });

    const advisories = await readBriefAdvisories(
      state,
      block('long', 8),
      readers('beginner', 'advanced'),
    );

    expect(advisories).toEqual([]);
  });

  it('says nothing to a beginner, even after 8 weeks with no deload', async () => {
    const state = stateOf([], { long: accumulation(8) });

    const advisories = await readBriefAdvisories(state, block('long', 8), readers('beginner'));

    expect(advisories).toEqual([]);
  });

  it('gives an intermediate the 4:1 or 5:1 prior and the program record', async () => {
    const state = stateOf([], { earlier: ratio(4), long: accumulation(7) });

    const [advisory] = await readBriefAdvisories(state, block('long', 7, 1), intermediate);

    expect(advisory?.kind).toBe('deload_cadence');
    expect(advisory?.text).toContain('has 7 weeks and no deload week');
    expect(advisory?.text).toContain('4:1 or 5:1');
    expect(advisory?.text).toContain("1 of this program's 2 blocks planned a deload week");
    expect(advisory?.text).not.toContain('tolerance is unknown');
    expect(advisory?.rpIds).toEqual([
      'rp:rp-s2-fatigue-reduction-ladder',
      'rp:rp-s4-beginner-no-deload-for-months',
    ]);
  });

  it('stays quiet for an intermediate 5:1 block once a deload is on record', async () => {
    const state = stateOf([], { earlier: ratio(4), b: ratio(5) });

    expect(await readBriefAdvisories(state, block('b', 6, 1), intermediate)).toEqual([]);
  });

  it('tells an intermediate with no deload on record to commit to 3 weeks and extend', async () => {
    const state = stateOf([], { b: ratio(4) });

    const [advisory] = await readBriefAdvisories(state, block('b', 5), intermediate);

    expect(advisory?.text).toContain('runs 4 accumulation weeks before its deload');
    expect(advisory?.text).toContain('tolerance is unknown');
    expect(advisory?.text).toContain('commit to 3 accumulation weeks, then extend week by week');
  });

  it('gives a declared advanced lifter 3:1 or 4:1 and names the week-4 exception', async () => {
    const state = stateOf([], { earlier: ratio(3), b: ratio(5) });

    const [advisory] = await readBriefAdvisories(state, block('b', 6, 1), advanced);

    expect(advisory?.text).toContain('runs 5 accumulation weeks before its deload');
    expect(advisory?.text).toContain('3:1 or 4:1');
    expect(advisory?.text).toContain('still gaining at the end of week 4, add one more');
  });

  it('stays quiet for a declared advanced 4:1 block', async () => {
    const state = stateOf([], { b: ratio(4) });

    expect(await readBriefAdvisories(state, block('b', 5), advanced)).toEqual([]);
  });

  it('says on every cadence line that the ratio is a prior and the trigger is performance', async () => {
    const state = stateOf([], { b: accumulation(7) });

    const advisories = await readBriefAdvisories(state, block('b', 7), advanced);

    expect(advisories.length).toBeGreaterThan(0);
    for (const advisory of advisories) {
      expect(advisory.text).toContain('planning prior');
      expect(advisory.text).toContain('the trigger stays performance-based');
    }
  });
});

describe('tier evidence advisory', () => {
  it('notes 6 weeks without a deload as evidence against a declared advanced tier', async () => {
    const state = stateOf([], { a: [false, false, false, true, false, false], b: ratio(4) });

    const advisories = await readBriefAdvisories(state, block('b', 5, 1), advanced);

    const note = advisories.find((advisory) => advisory.kind === 'tier_evidence');
    expect(note?.text).toContain('6 weeks in a row with no deload week');
    expect(note?.text).toContain('evidence against the declared tier');
    expect(note?.text).toContain('the tier stays as declared');
  });

  it('says nothing about the tier when the lifter only declared intermediate', async () => {
    const state = stateOf([], { b: accumulation(8) });

    const advisories = await readBriefAdvisories(state, block('b', 8), intermediate);

    expect(advisories.map((advisory) => advisory.kind)).toEqual(['deload_cadence']);
  });
});

describe('active rest advisory', () => {
  type Kind = 'train' | 'deload' | 'off';
  const DAY_MS = 86_400_000;
  const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

  /** A dated 4-week block starting at `startMs`, its weeks shaped by `kinds`. */
  function datedBlock(startMs: number, kinds: Kind[]): DatedBlockWeeks {
    return {
      startsOn: isoDate(startMs),
      endsOn: isoDate(startMs + (7 * kinds.length - 1) * DAY_MS),
      weeks: kinds.map((kind, k) => ({
        isDeload: kind === 'deload',
        off: kind === 'off',
        endsOn: isoDate(startMs + (7 * k + 6) * DAY_MS),
      })),
    };
  }

  /** Back-to-back 3:1 blocks from 2026-01-05; the tenth runs 2026-09-14 to 2026-10-11. */
  function datedYear(blockCount: number, offWeekAfter: number | null = null): DatedBlockWeeks[] {
    const out: DatedBlockWeeks[] = [];
    let startMs = Date.parse('2026-01-05');
    for (let i = 0; i < blockCount; i++) {
      out.push(datedBlock(startMs, ['train', 'train', 'train', 'deload']));
      startMs += (28 + (i === offWeekAfter ? 7 : 0)) * DAY_MS;
    }
    return out;
  }

  async function activeRest(blocks: DatedBlockWeeks[]) {
    const advisories = await readBriefAdvisories(
      stateOf([], {}),
      null,
      readers('intermediate', 'intermediate', blocks),
    );
    return advisories.filter((advisory) => advisory.kind === 'active_rest');
  }

  it('names a missing active rest once when a year of blocks never took a week off', async () => {
    const found = await activeRest(datedYear(10));

    expect(found).toHaveLength(1);
    expect(found[0]?.text).toContain('since 2025-10-01');
    expect(found[0]?.rpIds).toEqual(['rp:rp-s2-fatigue-reduction-ladder']);
  });

  it('stays quiet when a deload week ran straight into a week between blocks', async () => {
    expect(await activeRest(datedYear(10, 4))).toEqual([]);
  });

  it('stays quiet when the off week is a planned week with no workouts', async () => {
    const blocks = datedYear(10);
    blocks[2] = datedBlock(Date.parse(blocks[2]!.startsOn), ['train', 'deload', 'off', 'train']);

    expect(await activeRest(blocks)).toEqual([]);
  });

  it('does not count a deload and off week of the current block that have not ended', async () => {
    const blocks = datedYear(10);
    blocks[9] = datedBlock(Date.parse(blocks[9]!.startsOn), ['train', 'train', 'deload', 'off']);

    expect(await activeRest(blocks)).toHaveLength(1);
  });

  it('stays quiet with under half a year of dated blocks to judge', async () => {
    expect(await activeRest(datedYear(10).slice(-4))).toEqual([]);
  });

  it('keeps tier evidence and active rest silent for an advanced claim held at beginner', async () => {
    const advisories = await readBriefAdvisories(
      stateOf([], { b: accumulation(8) }),
      block('b', 8),
      readers('beginner', 'advanced', datedYear(10)),
    );

    expect(advisories).toEqual([]);
  });
});
