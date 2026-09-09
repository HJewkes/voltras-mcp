// VW-93 / B09 — within-set ROM decay and rep-to-rep variance.
//
// Reps are synthesised directly from a (rom, peakVelocity) pair: ROM is
// `|endPosition - startPosition|`, so a rep's ROM is set by its end position
// alone and every case below reads as the ratio it is named for. Velocity is
// carried only because `selectEligibleReps` judges on it too — the tests that
// do not care about eligibility hold it constant.

import { describe, expect, it } from 'vitest';
import { MovementPhase } from '@voltras/workout-analytics';
import type { Phase, Rep, WorkoutSample } from '@voltras/workout-analytics';
import {
  medianEligibleRom,
  readRomIntegrity,
  ROM_INTEGRITY_MARGINS,
  type RomIntegrityMargins,
} from '../rom-integrity.js';

/** Two movement samples is the floor `selectEligibleReps` calls measurable. */
function makePhase(rom: number, peakVelocity: number, kind: MovementPhase): Phase {
  const samples: WorkoutSample[] = [0, rom].map((position, i) => ({
    sequence: i,
    timestamp: i * 25,
    phase: kind,
    position,
    velocity: peakVelocity,
    force: 50,
  }));
  return {
    samples,
    startTime: 0,
    endTime: 25,
    startPosition: 0,
    endPosition: rom,
    _totalVelocity: peakVelocity * 2,
    _totalForce: 100,
    _totalLoad: 0,
    _movementSampleCount: 2,
    _totalHoldDuration: 0,
    _peakVelocityTime: 0,
    _lastMovementVelocity: peakVelocity,
    peakVelocity,
    peakForce: 50,
    peakLoad: 0,
  };
}

function makeRep(repNumber: number, rom: number, peakVelocity = 0.8): Rep {
  return {
    repNumber,
    concentric: makePhase(rom, peakVelocity, MovementPhase.CONCENTRIC),
    eccentric: makePhase(rom, peakVelocity * 0.6, MovementPhase.ECCENTRIC),
  };
}

/** A set built from ROMs alone, numbered 1..n, all at the same velocity. */
function setOf(roms: number[]): Rep[] {
  return roms.map((rom, i) => makeRep(i + 1, rom));
}

const NO_MARGINS: RomIntegrityMargins = { decay: null, variance: null };

describe('readRomIntegrity — within-set decay', () => {
  it('reads ratios near 1 and a stable verdict for a set that holds its ROM', () => {
    const reading = readRomIntegrity(setOf([0.5, 0.5, 0.5, 0.5]));

    expect(reading.eligibleRepCount).toBe(4);
    for (const rep of reading.perRep) {
      expect(rep.romFractionOfSetMedian).toBeCloseTo(1, 10);
      expect(rep.eligible).toBe(true);
    }
    expect(reading.decay.lastOverFirstEligible).toBeCloseTo(1, 10);
    expect(reading.decay.verdict).toBe('stable');
  });

  it('reads 0.7 and a shrinking verdict when the last rep is 70% of the first', () => {
    const reading = readRomIntegrity(setOf([0.5, 0.46, 0.42, 0.35]));

    expect(reading.decay.lastOverFirstEligible).toBeCloseTo(0.7, 10);
    expect(reading.decay.verdict).toBe('shrinking');
    expect(reading.decay.citation).toBe(ROM_INTEGRITY_MARGINS.decay?.citation);
  });

  it('stays stable at a shrink the cited cut does not call a partial rep', () => {
    const reading = readRomIntegrity(setOf([0.5, 0.48, 0.46, 0.45]));

    expect(reading.decay.lastOverFirstEligible).toBeCloseTo(0.9, 10);
    expect(reading.decay.verdict).toBe('stable');
  });

  it('reports a null ratio and a null verdict for a one-rep set', () => {
    const reading = readRomIntegrity(setOf([0.5]));

    expect(reading.decay).toEqual({
      lastOverFirstEligible: null,
      verdict: null,
      citation: null,
    });
    expect(reading.perRep[0]?.romFractionOfSetMedian).toBeCloseTo(1, 10);
  });

  it('reports a null ratio when no rep carries a measurable ROM', () => {
    const reading = readRomIntegrity(setOf([0, 0, 0]));

    expect(reading.decay.lastOverFirstEligible).toBeNull();
    expect(reading.variance.cv).toBeNull();
    expect(reading.perRep.every((r) => r.romFractionOfSetMedian === null)).toBe(true);
  });
});

describe('readRomIntegrity — rep-to-rep variance', () => {
  const cases: { name: string; roms: number[]; verdict: string }[] = [
    { name: 'identical reps are stable', roms: [0.5, 0.5, 0.5, 0.5], verdict: 'stable' },
    { name: 'a few percent of spread is stable', roms: [0.5, 0.51, 0.49, 0.5], verdict: 'stable' },
    {
      name: 'mid-teens percent of spread is variable',
      roms: [0.5, 0.42, 0.58, 0.5],
      verdict: 'variable',
    },
    { name: 'a set that wanders is erratic', roms: [0.5, 0.3, 0.62, 0.38], verdict: 'erratic' },
  ];

  for (const { name, roms, verdict } of cases) {
    it(name, () => {
      const reading = readRomIntegrity(setOf(roms));

      // Every spread here sits inside `selectEligibleReps`'s 1.8x band, so the
      // CV is taken over the whole set and grades the spread, not the filter.
      expect(reading.eligibleRepCount).toBe(roms.length);
      expect(reading.variance.verdict).toBe(verdict);
      expect(reading.variance.cv).toBeGreaterThanOrEqual(0);
    });
  }

  it('reports a null CV for a one-rep set', () => {
    expect(readRomIntegrity(setOf([0.5])).variance).toEqual({
      cv: null,
      verdict: null,
      citation: null,
    });
  });
});

describe('readRomIntegrity — rep eligibility', () => {
  it('excludes an opening positioning pull from every statistic', () => {
    // Rep 1 is the 2026-09-07 dogfood's rope-positioning pull: ~2x the ROM and
    // ~2x the velocity of the working reps that follow it.
    const reps = [
      makeRep(1, 1.0, 1.6),
      makeRep(2, 0.5, 0.8),
      makeRep(3, 0.5, 0.8),
      makeRep(4, 0.35, 0.8),
    ];

    const reading = readRomIntegrity(reps);

    expect(reading.eligibleRepCount).toBe(3);
    expect(reading.perRep.map((r) => r.eligible)).toEqual([false, true, true, true]);
    // The pull is still reported, at its raw 2x fraction of the eligible median.
    expect(reading.perRep[0]?.romFractionOfSetMedian).toBeCloseTo(2, 10);
    // Decay runs rep 2 -> rep 4, so it reads 0.7 and not the pull's 0.35.
    expect(reading.decay.lastOverFirstEligible).toBeCloseTo(0.7, 10);
    expect(reading.decay.verdict).toBe('shrinking');
  });

  it('keeps every rep when eligibility would empty the set', () => {
    const reading = readRomIntegrity(setOf([0.5, 0.5]));

    expect(reading.eligibleRepCount).toBe(2);
    expect(reading.perRep.every((r) => r.eligible)).toBe(true);
  });
});

describe('readRomIntegrity — margins', () => {
  it('withholds both verdicts, and both citations, when no margin is supplied', () => {
    const reading = readRomIntegrity(setOf([0.5, 0.46, 0.42, 0.35]), NO_MARGINS);

    expect(reading.decay.verdict).toBeNull();
    expect(reading.decay.citation).toBeNull();
    expect(reading.variance.verdict).toBeNull();
    expect(reading.variance.citation).toBeNull();
  });

  it('still returns the raw numbers when no margin is supplied', () => {
    const reading = readRomIntegrity(setOf([0.5, 0.46, 0.42, 0.35]), NO_MARGINS);

    expect(reading.decay.lastOverFirstEligible).toBeCloseTo(0.7, 10);
    expect(reading.variance.cv).toBeGreaterThan(0);
    expect(reading.perRep).toHaveLength(4);
  });

  it('carries a citation on every margin it ships', () => {
    expect(ROM_INTEGRITY_MARGINS.decay?.citation).toContain('DEFAULT_PARTIAL_REP_SCHEME');
    expect(ROM_INTEGRITY_MARGINS.variance?.citation).toContain('DEFAULT_CONSISTENCY_SCHEME');
  });
});

describe('medianEligibleRom', () => {
  it('takes the median over eligible reps only', () => {
    const reps = [makeRep(1, 1.0, 1.6), makeRep(2, 0.5), makeRep(3, 0.5), makeRep(4, 0.5)];

    expect(medianEligibleRom(reps)).toBeCloseTo(0.5, 10);
  });

  it('is null when no rep carries a measurable ROM', () => {
    expect(medianEligibleRom(setOf([0, 0]))).toBeNull();
  });
});
