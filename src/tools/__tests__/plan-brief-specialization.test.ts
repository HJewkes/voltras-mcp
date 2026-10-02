// The planning brief's specialization frequency bump (VW-624): offered only for a fatigue-limited
// specialized muscle in the last block before an active rest, never for hamstrings, never in a
// fat-loss phase, and with the 2-mesocycle hold named when the priority is younger than that.

import { describe, expect, it } from 'vitest';

import type { StoredPriority, StoredTrainingBlock } from '../../store/types.js';
import { GOAL_GUARDRAIL_THRESHOLDS } from '../goal-guardrails.js';
import { readBriefAdvisories, type AdvisoryReaders } from '../plan-brief-advisories.js';
import type { WeekShape } from '../plan-brief-cadence.js';
import {
  FATIGUE_LIMITED_MUSCLES,
  frequencyBumpAdvisories,
  isFinalBeforeActiveRest,
  SYSTEMICALLY_FATIGUING_MUSCLES,
  type FrequencyBumpInput,
} from '../plan-brief-specialization.js';

const MIN = GOAL_GUARDRAIL_THRESHOLDS.minMesosBeforeSwitch;

function specialize(ref: string, mesosHeld = MIN): StoredPriority {
  return {
    id: `pri-${ref}`,
    userId: 'local',
    horizonWeeks: 6,
    kind: 'muscle',
    ref,
    level: 'specialize',
    declaredAt: '2026-09-01T00:00:00.000Z',
    mesosHeld,
  };
}

function input(overrides: Partial<FrequencyBumpInput> = {}): FrequencyBumpInput {
  return {
    blockName: 'Arms B',
    priorities: [specialize('biceps')],
    tier: 'intermediate',
    dietPhase: 'maintenance',
    finalBeforeActiveRest: true,
    ...overrides,
  };
}

const train: WeekShape = { isDeload: false, templates: 4 };
const deload: WeekShape = { isDeload: true, templates: 3 };
const off: WeekShape = { isDeload: false, templates: 0 };

describe('specialization frequency bump', () => {
  it('offers one more weekly session for a fatigue-limited specialized muscle', () => {
    const advisories = frequencyBumpAdvisories(input());

    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toMatchObject({
      kind: 'specialization_frequency_bump',
      rpIds: ['rp:rp-s6-frequency-bump-final-specialization-mesocycle'],
    });
    expect(advisories[0]?.text).toContain('biceps');
    expect(advisories[0]?.text).toContain('one more session a week');
  });

  it('gives no offer when the block is not the last one before an active rest', () => {
    expect(frequencyBumpAdvisories(input({ finalBeforeActiveRest: false }))).toEqual([]);
  });

  it('never offers a bump for hamstrings', () => {
    expect(frequencyBumpAdvisories(input({ priorities: [specialize('hamstrings')] }))).toEqual([]);
  });

  it('keeps hamstrings out even when a list names it fatigue-limited', () => {
    const lists = {
      fatigueLimited: new Set([...FATIGUE_LIMITED_MUSCLES, 'hamstrings' as const]),
      systemic: SYSTEMICALLY_FATIGUING_MUSCLES,
    };

    const advisories = frequencyBumpAdvisories(
      input({ priorities: [specialize('hamstrings')] }),
      lists,
    );

    expect(advisories).toEqual([]);
  });

  it('gives no offer for a specialized muscle that is not fatigue-limited', () => {
    expect(frequencyBumpAdvisories(input({ priorities: [specialize('quads')] }))).toEqual([]);
  });

  it('keeps specialization disabled in a fat-loss phase', () => {
    expect(frequencyBumpAdvisories(input({ dietPhase: 'fat-loss' }))).toEqual([]);
  });

  it('gives a beginner no offer', () => {
    expect(frequencyBumpAdvisories(input({ tier: 'beginner' }))).toEqual([]);
  });

  it('ignores a muscle held at maintain', () => {
    const maintain = { ...specialize('biceps'), level: 'maintain' as const };

    expect(frequencyBumpAdvisories(input({ priorities: [maintain] }))).toEqual([]);
  });

  it(`names the ${MIN}-mesocycle hold when the specialization is younger than that`, () => {
    const [advisory] = frequencyBumpAdvisories(
      input({ priorities: [specialize('biceps', MIN - 1)] }),
    );

    expect(advisory?.text).toContain(`fewer than ${MIN}`);
    expect(advisory?.rpIds).toContain('rp:rp-s5-goal-persistence-multi-meso');
  });

  it(`says nothing about the hold once the specialization reached ${MIN} mesocycles`, () => {
    const [advisory] = frequencyBumpAdvisories(input({ priorities: [specialize('biceps', MIN)] }));

    expect(advisory?.text).not.toContain('fewer than');
  });

  it('keeps the two muscle lists apart', () => {
    const overlap = [...FATIGUE_LIMITED_MUSCLES].filter((m) =>
      SYSTEMICALLY_FATIGUING_MUSCLES.has(m),
    );

    expect(overlap).toEqual([]);
    expect(SYSTEMICALLY_FATIGUING_MUSCLES.has('hamstrings')).toBe(true);
  });
});

describe('final block before an active rest', () => {
  it('holds when the block ends on a deload week and the next block opens with a week off', () => {
    expect(isFinalBeforeActiveRest([train, train, deload], [off, train])).toBe(true);
  });

  it('holds when the deload and the week off both sit inside the block', () => {
    expect(isFinalBeforeActiveRest([train, train, deload, off], [])).toBe(true);
  });

  it('does not hold when training follows the deload', () => {
    expect(isFinalBeforeActiveRest([train, deload], [train])).toBe(false);
  });

  it('does not hold for a plain deload with nothing after it', () => {
    expect(isFinalBeforeActiveRest([train, deload], [])).toBe(false);
  });

  it('does not hold for a block with no training week', () => {
    expect(isFinalBeforeActiveRest([deload, off], [])).toBe(false);
  });
});

describe('the bump on the planning brief', () => {
  /** Two blocks of one program: weeks are deload flags and template counts. */
  function stateOf(priorities: StoredPriority[], weeks: Record<string, WeekShape[]>) {
    const blocks: StoredTrainingBlock[] = Object.keys(weeks).map((id, i) => ({
      id,
      programId: 'p',
      orderIndex: i,
      name: id,
      weeksCount: weeks[id]!.length,
    }));
    const store = {
      listPriorities: async () => priorities,
      getTrainingBlocksForProgram: async () => blocks,
      getTrainingWeeksForBlock: async (id: string) =>
        (weeks[id] ?? []).map((w, orderIndex) => ({ id: `${id}:${orderIndex}`, ...w })),
      getWorkoutTemplatesForWeek: async (weekId: string) => {
        const [id, index] = weekId.split(':');
        return Array.from({ length: weeks[id!]![Number(index)]!.templates }, () => ({}));
      },
    };
    return { state: { store } as unknown as Parameters<typeof readBriefAdvisories>[0], blocks };
  }

  const readers: Partial<AdvisoryReaders> = {
    readFlatline: async () => null,
    readTier: async () => ({ tier: 'beginner', declared: null }),
    readDatedBlocks: async () => [],
    readBlockDays: async () => [],
    readDietPhase: async () => 'maintenance',
    today: '2026-10-01',
  };

  it('offers the bump on the block being planned when an active rest follows it', async () => {
    const { state, blocks } = stateOf([specialize('shoulders')], {
      next: [train, train, deload],
      rest: [off],
    });

    const advisories = await readBriefAdvisories(
      state,
      null,
      { ...readers, readTier: async () => ({ tier: 'intermediate', declared: 'intermediate' }) },
      blocks[0]!,
    );

    expect(advisories.map((a) => a.kind)).toEqual([
      'specialization_frequency_bump',
      'specialization_frequency_bump',
      'specialization_frequency_bump',
    ]);
  });

  it('reads the diet phase and drops the bump in a fat-loss phase', async () => {
    const { state, blocks } = stateOf([specialize('biceps')], { next: [train, deload, off] });

    const advisories = await readBriefAdvisories(
      state,
      null,
      {
        ...readers,
        readTier: async () => ({ tier: 'intermediate', declared: 'intermediate' }),
        readDietPhase: async () => 'fat-loss',
      },
      blocks[0]!,
    );

    expect(advisories).toEqual([]);
  });
});
