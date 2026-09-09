// Table tests for the like-vs-like predicate (VW-94 / B16 v1).
//
// The table covers one clause per row: each case changes exactly ONE field
// away from a comparable pair, so a clause that stops being evaluated fails
// its own row and nothing else.

import { describe, expect, it } from 'vitest';

import {
  chooseComparisonPartner,
  isComparable,
  LOAD_TOLERANCE_PCT,
  type ComparabilitySubject,
} from '../comparability.js';

function makeSubject(overrides: Partial<ComparabilitySubject> = {}): ComparabilitySubject {
  return {
    id: 'set-a',
    exerciseId: 'bench-press',
    trainingMode: 'WeightTraining',
    settingsHash: 'v1:aaaa',
    side: 'right',
    weightLbs: 170,
    startedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('isComparable', () => {
  it('calls two sets with identical settings comparable', () => {
    const verdict = isComparable(makeSubject(), makeSubject({ id: 'set-b' }));
    expect(verdict.comparable).toBe(true);
    expect(verdict.reasons.every((r) => r.includes(' (note): '))).toBe(true);
  });

  it('different device settings (chains changed) block the comparison', () => {
    const verdict = isComparable(
      makeSubject(),
      makeSubject({ id: 'set-b', settingsHash: 'v1:bbbb' }),
    );
    expect(verdict.comparable).toBe(false);
    expect(verdict.reasons).toContain('settings: different device settings (v1:aaaa vs v1:bbbb)');
  });

  it('does not compare a guest working in against the owner', () => {
    const verdict = isComparable(makeSubject(), makeSubject({ id: 'set-b', lifter: 'Jordan' }));
    expect(verdict.comparable).toBe(false);
    expect(verdict.reasons).toContain('lifter: different lifter (owner vs Jordan)');
  });

  it('does not compare a warm-up against a working set', () => {
    const verdict = isComparable(makeSubject(), makeSubject({ id: 'set-b', setPurpose: 'warmup' }));
    expect(verdict.comparable).toBe(false);
    expect(verdict.reasons).toContain('purpose: different intent (working vs warmup set)');
  });

  it('passes the phase clause with a note when neither side records a phase', () => {
    const verdict = isComparable(makeSubject(), makeSubject({ id: 'set-b' }));
    expect(verdict.comparable).toBe(true);
    expect(verdict.reasons).toContain(
      'phase (note): neither set records a training phase, so this clause passes unchecked',
    );
    expect(verdict.reasons).toContain(
      'setup (note): neither set records a physical setup, so this clause passes unchecked',
    );
  });

  it('blocks when a phase is recorded on only one side', () => {
    const verdict = isComparable(makeSubject({ phase: 'fat-loss' }), makeSubject({ id: 'set-b' }));
    expect(verdict.comparable).toBe(false);
    expect(verdict.reasons).toContain(
      'phase: training phase recorded on only one side (fat-loss vs unrecorded)',
    );
  });

  it.each([
    [
      'exercise',
      { exerciseId: 'cable-row' },
      'exercise: different exercise (bench-press vs cable-row)',
    ],
    [
      'training mode',
      { trainingMode: 'Isokinetic' },
      'mode: different training mode (WeightTraining vs Isokinetic)',
    ],
    ['side', { side: 'left' }, 'side: different side (right vs left)'],
  ])('blocks on a different %s', (_clause, override, reason) => {
    const verdict = isComparable(makeSubject(), makeSubject({ id: 'set-b', ...override }));
    expect(verdict.comparable).toBe(false);
    expect(verdict.reasons).toContain(reason);
  });

  it('requires an exact load match while no tolerance is sourced', () => {
    expect(LOAD_TOLERANCE_PCT).toBeNull();
    const verdict = isComparable(makeSubject(), makeSubject({ id: 'set-b', weightLbs: 175 }));
    expect(verdict.comparable).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('different load (170 vs 175 lb)');
  });

  it('reports every failing clause, not just the first', () => {
    const verdict = isComparable(
      makeSubject(),
      makeSubject({ id: 'set-b', exerciseId: 'cable-row', side: 'left', weightLbs: 100 }),
    );
    expect(verdict.reasons.filter((r) => !r.includes(' (note): '))).toHaveLength(3);
  });
});

describe('chooseComparisonPartner', () => {
  it('picks the first comparable candidate in the order given', () => {
    const report = chooseComparisonPartner(makeSubject(), [
      makeSubject({ id: 'set-warmup', setPurpose: 'warmup' }),
      makeSubject({ id: 'set-match' }),
      makeSubject({ id: 'set-later' }),
    ]);
    expect(report.comparedTo?.setId).toBe('set-match');
    expect(report.noValidComparison).toBeUndefined();
  });

  it('names the nearest candidate and its reasons when no pair is valid', () => {
    const report = chooseComparisonPartner(makeSubject(), [
      makeSubject({ id: 'set-far', exerciseId: 'cable-row', side: 'left', weightLbs: 60 }),
      makeSubject({ id: 'set-near', weightLbs: 175 }),
    ]);
    expect(report.noValidComparison).toBe(true);
    expect(report.nearest?.setId).toBe('set-near');
    expect(report.nearest?.reasons.join(' ')).toContain('different load (170 vs 175 lb)');
  });

  it('reports no valid comparison without a nearest when there is no candidate', () => {
    const report = chooseComparisonPartner(makeSubject(), [makeSubject()]);
    expect(report).toEqual({ noValidComparison: true });
  });
});
