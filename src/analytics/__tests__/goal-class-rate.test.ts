// The later-block rate from the lifter's own start-to-start class slope (VW-510).

import { describe, expect, it } from 'vitest';

import { rampClassOf } from '../../exercises/ramp-class.js';
import { CLASS_RATE_GATE, laterBlockRateOf, type ClassRateInput } from '../goal-class-rate.js';
import type { RampClass } from '../goal-band.js';

const BLOCKS = [
  { start: '2026-01-05', end: '2026-02-01' },
  { start: '2026-02-02', end: '2026-03-01' },
];

/** `perBlock` points `stepDays` apart in each block, climbing inside it, each block starting 1 lb higher. */
function bench(perBlock: number, blocks = BLOCKS, stepDays = 7) {
  const points = blocks.flatMap((block, b) =>
    Array.from({ length: perBlock }, (_, i) => ({
      day: addDays(block.start, stepDays * i),
      value: 100 + b + 2 * i,
    })),
  );
  return { lift: 'bench', points };
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const CLASSES: Record<string, RampClass> = {
  bench: rampClassOf({ exerciseType: 'compound', movementPattern: 'push' }),
};

function input(overrides: Partial<ClassRateInput> = {}): ClassRateInput {
  return {
    series: [bench(4)],
    blocks: BLOCKS,
    classOf: (lift) => CLASSES[lift] ?? null,
    rampClass: 'upper_compound',
    tier: 'intermediate',
    ...overrides,
  };
}

describe('laterBlockRateOf', () => {
  it('reads the start-to-start slope, not the in-block climb, once 8 sessions span 2 blocks', () => {
    const rate = laterBlockRateOf(input());

    expect(rate.source).toBe('MEASURED');
    expect(rate.n).toBe(8);
    expect(rate.value).toBeCloseTo(0.25, 6); // 1 lb over 4 weeks on a 100 lb start
  });

  it('falls back to the default with 7 sessions', () => {
    const series = [{ ...bench(4), points: bench(4).points.slice(1) }];

    const rate = laterBlockRateOf(input({ series }));

    expect(rate.source).toBe('ENGINEERING DEFAULT');
    expect(rate.n).toBe(7);
    expect(rate.value).toBe(1); // half the intermediate upper-compound 2%
  });

  it('falls back to the default when every session sits in one block', () => {
    const rate = laterBlockRateOf(input({ series: [bench(8, BLOCKS.slice(0, 1), 3)] }));

    expect(rate.source).toBe('ENGINEERING DEFAULT');
  });

  it('keys the class the way the goal ramp does, so another class never borrows the slope', () => {
    expect(CLASSES.bench).toBe('upper_compound');
    expect(laterBlockRateOf(input({ rampClass: 'lower_compound' })).source).toBe(
      'ENGINEERING DEFAULT',
    );
  });

  it('pins the gate at 8 sessions across 2 blocks', () => {
    expect(CLASS_RATE_GATE).toEqual({ minSessions: 8, minBlocks: 2 });
  });
});
