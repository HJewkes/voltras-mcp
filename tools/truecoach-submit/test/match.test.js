// Name matching. Position never decides anything: supersets reorder, so the
// only safe key is the name, and any ambiguity has to abort rather than guess.

import { describe, it, expect } from 'vitest';

import { matchExercises, normalise } from '../src/match.js';

function slot(index, title, plan = '') {
  return { index, title, plan, hasResultsBox: true };
}

describe('normalise', () => {
  it('flattens case, punctuation and diacritics', () => {
    expect(normalise('Bicep  Curl (Bayesian)')).toBe('bicep curl bayesian');
  });
});

describe('matchExercises', () => {
  it('matches a superset pair by name when the page reorders E1 and E2', () => {
    // Arrange: the entry lists E1 then E2; the page renders E2 first.
    const exercises = [
      { exerciseId: 'row', exerciseName: 'Seated Row', result: 'a' },
      { exerciseId: 'push', exerciseName: 'Tricep Pushdown', result: 'b' },
    ];
    const slots = [slot(0, 'Tricep Pushdown', 'E2'), slot(1, 'Seated Row', 'E1')];

    // Act
    const { matches, unmatched } = matchExercises(exercises, slots);

    // Assert
    expect(unmatched).toBeUndefined();
    expect(matches.map((match) => [match.exerciseId, match.slot.index])).toEqual([
      ['row', 1],
      ['push', 0],
    ]);
  });

  it('matches a short plan title contained in the recorded name', () => {
    // Arrange
    const exercises = [{ exerciseId: 'bench', exerciseName: 'Barbell Bench Press', result: 'a' }];

    // Act
    const { matches } = matchExercises(exercises, [slot(0, 'Bench Press')]);

    // Assert
    expect(matches?.[0]?.slot.index).toBe(0);
  });

  it('aborts when two recorded exercises share a name', () => {
    // Arrange
    const exercises = [
      { exerciseId: 'row-a', exerciseName: 'Seated Row', result: 'a' },
      { exerciseId: 'row-b', exerciseName: 'Seated row', result: 'b' },
    ];

    // Act
    const { matches, unmatched } = matchExercises(exercises, [slot(0, 'Seated Row')]);

    // Assert
    expect(matches).toBeUndefined();
    expect(unmatched).toHaveLength(2);
    expect(unmatched[0]?.reason).toBe('duplicate name');
  });

  it('aborts when an exercise matches more than one card', () => {
    // Arrange
    const exercises = [{ exerciseId: 'row', exerciseName: 'Row', result: 'a' }];
    const slots = [slot(0, 'Seated Row'), slot(1, 'Cable Row')];

    // Act
    const { unmatched } = matchExercises(exercises, slots);

    // Assert
    expect(unmatched?.[0]?.reason).toBe('matches more than one');
  });

  it('aborts when an exercise matches no card', () => {
    // Arrange + Act
    const { unmatched } = matchExercises(
      [{ exerciseId: 'row', exerciseName: 'Seated Row', result: 'a' }],
      [slot(0, 'Leg Press')],
    );

    // Assert
    expect(unmatched?.[0]?.reason).toBe('no matching exercise on the workout');
  });

  it('aborts when two exercises land on the same card', () => {
    // Arrange: distinct names, both contained in one card's title.
    const exercises = [
      { exerciseId: 'a', exerciseName: 'Incline Press', result: 'a' },
      { exerciseId: 'b', exerciseName: 'Dumbbell Incline', result: 'b' },
    ];

    // Act
    const { unmatched } = matchExercises(exercises, [slot(0, 'Dumbbell Incline Press')]);

    // Assert
    expect(unmatched).toHaveLength(2);
    expect(unmatched[0]?.reason).toContain('both resolve to');
  });
});
