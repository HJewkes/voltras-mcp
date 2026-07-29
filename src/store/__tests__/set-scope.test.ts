// Unit tests for the set-level exercise scoping helpers (VMCP-01.72a).
//
// Two behaviours are load-bearing and easy to "simplify" away:
//
//   * a set carrying NO exercise of its own is KEPT — dropping it would blank
//     out every pre-v7 name-only session's history, which is a behaviour change
//     where this migration is meant to be none;
//   * an `undefined` target scopes nothing, so a caller with no exercise in
//     hand gets the list back rather than an empty one.

import { describe, expect, it } from 'vitest';

import { scopeSetsToExercise, scopeSetsToExerciseId } from '../set-scope.js';

interface Row {
  id: string;
  exerciseId?: string;
}

const ROWS: Row[] = [
  { id: 'bench-1', exerciseId: 'bench-press' },
  { id: 'squat-1', exerciseId: 'back-squat' },
  { id: 'unattributed-1' },
  { id: 'bench-2', exerciseId: 'bench-press' },
];

describe('scopeSetsToExerciseId', () => {
  it('keeps only the named exercise, in the original order', () => {
    expect(scopeSetsToExerciseId(ROWS, 'bench-press').map((r) => r.id)).toEqual([
      'bench-1',
      'unattributed-1',
      'bench-2',
    ]);
  });

  it('keeps a set that recorded no exercise of its own', () => {
    expect(scopeSetsToExerciseId(ROWS, 'back-squat').map((r) => r.id)).toEqual([
      'squat-1',
      'unattributed-1',
    ]);
  });

  it('scopes nothing when the caller has no exercise to scope to', () => {
    expect(scopeSetsToExerciseId(ROWS, undefined).map((r) => r.id)).toEqual(ROWS.map((r) => r.id));
  });

  it('returns an empty list for an exercise nothing was recorded against, bar the unattributed', () => {
    expect(scopeSetsToExerciseId([ROWS[0]!, ROWS[1]!], 'overhead-press')).toEqual([]);
  });

  it('does not mutate its input', () => {
    const before = [...ROWS];
    scopeSetsToExerciseId(ROWS, 'bench-press');
    expect(ROWS).toEqual(before);
  });
});

describe('scopeSetsToExercise', () => {
  it('delegates the match to the caller, so a label-keyed reader can share the policy', () => {
    const rows: Row[] = [
      { id: 'a', exerciseId: 'cable-chest-press' },
      { id: 'b', exerciseId: 'back-squat' },
      { id: 'c' },
    ];
    const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const kept = scopeSetsToExercise(
      rows,
      (id) => normalize(id) === normalize('Cable Chest Press'),
    );
    expect(kept.map((r) => r.id)).toEqual(['a', 'c']);
  });
});
