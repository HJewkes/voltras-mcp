// Table tests for the like-vs-like predicate (VW-94 / B16 v1).
//
// The table covers one clause per row: each case changes exactly ONE field
// away from a comparable pair, so a clause that stops being evaluated fails
// its own row and nothing else.

import { describe, expect, it } from 'vitest';

import {
  chooseComparisonPartner,
  CORROBORATING_EXERCISES,
  EXERCISE_SWAP_REFRAME,
  EXERCISE_SWAP_SETTLING_SESSIONS,
  isComparable,
  LOAD_TOLERANCE_PCT,
  type ComparabilitySubject,
} from '../comparability.js';
import { setupRowId } from '../../store/exercise-setups.js';

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

  // The ids come from the real writer (`setupRowId`, VW-119) rather than
  // hand-written strings, so a change to that format fails here instead of
  // leaving the clause passing against ids nothing produces.
  const SETUP_A = setupRowId({ userId: 'local', exerciseId: 'bench-press', side: 'right' }, 0);
  const SETUP_B = setupRowId({ userId: 'local', exerciseId: 'bench-press', side: 'right' }, 1);

  it('compares two sets stamped with the same inferred setup', () => {
    const verdict = isComparable(
      makeSubject({ setupId: SETUP_A }),
      makeSubject({ id: 'set-b', setupId: SETUP_A }),
    );
    expect(verdict.comparable).toBe(true);
    expect(verdict.reasons.some((r) => r.startsWith('setup'))).toBe(false);
  });

  it('blocks two sets clustered into different physical setups', () => {
    const verdict = isComparable(
      makeSubject({ setupId: SETUP_A }),
      makeSubject({ id: 'set-b', setupId: SETUP_B }),
    );
    expect(verdict.comparable).toBe(false);
    expect(verdict.reasons).toContain(`setup: different physical setup (${SETUP_A} vs ${SETUP_B})`);
  });

  it('blocks when only one side has been clustered — absent is not a match', () => {
    const verdict = isComparable(makeSubject({ setupId: SETUP_A }), makeSubject({ id: 'set-b' }));
    expect(verdict.comparable).toBe(false);
    expect(verdict.reasons).toContain(
      `setup: physical setup recorded on only one side (${SETUP_A} vs unrecorded)`,
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

  // B16 (b): the across-set profile clause never blocks, so each row asserts
  // the note it emits and that the pair stays comparable.
  it.each([
    [
      'neither side records a profile position',
      {},
      {},
      'profile (note): neither set records its position in the exercise set profile, so the ' +
        'top-set-only risk B16 (b) names is unchecked on this pair',
    ],
    [
      'only one side records a profile position',
      { setIndexInExercise: 2 },
      {},
      'profile (note): set profile position recorded on only one side (2 vs unrecorded), so ' +
        'this pair cannot be placed in the across-set profile',
    ],
    [
      'the two sides sit at different profile positions',
      { setIndexInExercise: 1 },
      { setIndexInExercise: 4 },
      'profile (note): set 1 compared against set 4 of their exercise, so a growth claim on ' +
        'this pair alone is a position-mismatched top-set comparison, not an across-set profile',
    ],
    [
      'the two sides sit at the same profile position',
      { setIndexInExercise: 2 },
      { setIndexInExercise: 2 },
      'profile (note): both sides are set 2 of their exercise, so this pair is one position of ' +
        'the across-set profile; a confident growth claim still needs the remaining positions',
    ],
  ])('qualifies but never blocks the growth claim when %s', (_case, left, right, note) => {
    const verdict = isComparable(makeSubject(left), makeSubject({ id: 'set-b', ...right }));
    expect(verdict.comparable).toBe(true);
    expect(verdict.reasons).toContain(note);
  });

  // B16 (d): the gate is the low end of the source's own 2-3 range, quoted
  // from the constant so a change to it fails here rather than drifting.
  it.each([
    [
      'neither side records a corroborating count',
      {},
      {},
      'corroboration (note): neither set records how many exercises for the same muscle back ' +
        "it, so B16 (d)'s 2-3 exercise corroboration is unchecked and a per-muscle growth claim " +
        'on this pair is uncorroborated',
    ],
    [
      'the weakest side is below the gate',
      { corroboratingExerciseCount: 1 },
      { corroboratingExerciseCount: 3 },
      "corroboration (note): 1 corroborating exercise for this muscle (1 vs 3), below B16 (d)'s " +
        '2-3, so a confident per-muscle growth claim is withheld until another exercise agrees',
    ],
    [
      'only one side records a count and it clears the gate',
      { corroboratingExerciseCount: 2 },
      {},
      'corroboration (note): 2 corroborating exercises for this muscle (2 vs unrecorded) meets ' +
        "B16 (d)'s 2-3 gate",
    ],
    [
      'both sides clear the gate',
      { corroboratingExerciseCount: 3 },
      { corroboratingExerciseCount: 2 },
      'corroboration (note): 2 corroborating exercises for this muscle (3 vs 2) meets B16 (d)' +
        "'s 2-3 gate",
    ],
  ])('qualifies the per-muscle claim when %s', (_case, left, right, note) => {
    const verdict = isComparable(makeSubject(left), makeSubject({ id: 'set-b', ...right }));
    expect(verdict.comparable).toBe(true);
    expect(verdict.reasons).toContain(note);
  });

  it("quotes B16 (d)'s own range rather than a chosen number", () => {
    expect(CORROBORATING_EXERCISES).toEqual({ min: 2, max: 3 });
  });

  // B16 (e): the swap boundary IS a context change, so unlike the claim
  // clauses this one blocks — and carries the reframe while it does.
  const INTRODUCED_FIRST = '2026-01-05T00:00:00.000Z';
  const INTRODUCED_AGAIN = '2026-06-01T00:00:00.000Z';
  const SWAP_TAIL =
    ` — ${EXERCISE_SWAP_REFRAME}, and no settling window is sourced, so the clause names the ` +
    'boundary rather than timing it';

  it.each([
    [
      'neither side records a programme entry date',
      {},
      {},
      true,
      'swap (note): neither set records a programme entry date for this exercise, so this clause ' +
        'passes unchecked',
    ],
    [
      'the pair straddles a re-introduction of the movement',
      { exerciseIntroducedAt: INTRODUCED_FIRST },
      { exerciseIntroducedAt: INTRODUCED_AGAIN },
      false,
      'swap: different programme entry date for this exercise ' +
        `(${INTRODUCED_FIRST} vs ${INTRODUCED_AGAIN})${SWAP_TAIL}`,
    ],
    [
      'only one side records a programme entry date',
      { exerciseIntroducedAt: INTRODUCED_FIRST },
      {},
      false,
      'swap: programme entry date for this exercise recorded on only one side ' +
        `(${INTRODUCED_FIRST} vs unrecorded)${SWAP_TAIL}`,
    ],
    [
      'both sides entered the programme at the same time',
      { exerciseIntroducedAt: INTRODUCED_FIRST },
      { exerciseIntroducedAt: INTRODUCED_FIRST },
      true,
      undefined,
    ],
  ])('handles the exercise swap when %s', (_case, left, right, comparable, reason) => {
    const verdict = isComparable(makeSubject(left), makeSubject({ id: 'set-b', ...right }));
    expect(verdict.comparable).toBe(comparable);
    if (reason === undefined) {
      expect(verdict.reasons.some((r) => r.startsWith('swap'))).toBe(false);
    } else {
      expect(verdict.reasons).toContain(reason);
    }
  });

  it('states that no post-swap settling window is sourced', () => {
    expect(EXERCISE_SWAP_SETTLING_SESSIONS).toBeNull();
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
