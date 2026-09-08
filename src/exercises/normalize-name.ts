// Comparison key for exercise-name matching: case- and
// punctuation-insensitive, so "Cable Chest Press" and "cable-chest-press"
// collapse to the same key.
//
// `session-tools.ts` carries a private copy of this rule under the same name.
// The two must not diverge; collapsing that copy onto this module is a
// separate change, deliberately not made here because session-tools.ts is
// under concurrent edit.

/** The normalised comparison key for `label`. */
export function normalizeExerciseName(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '');
}
