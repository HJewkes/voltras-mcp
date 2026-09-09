// The observed diet-phase vocabulary and the pure range arithmetic over it
// (VW-149 / VW-150).
//
// OBSERVED, NOT PRESCRIBED. `diet_phases` records what the lifter WAS doing;
// `training_weeks.phase_type` records what the plan SAID they would do. The
// schema comments on both keep them apart on purpose — collapsing them loses
// the ability to compare plan against reality — so nothing in this module or
// its callers reads or writes `phase_type`.
//
// THE VOCABULARY IS THE EXISTING DOCSTRING'S. `ComparabilitySubject.phase` has
// named fat-loss / gain / maintenance since B34; those three values are the
// citation and this enum is a transcription of it, not a new taxonomy.
//
// NO INTERPRETATION LIVES HERE OR DOWNSTREAM. B34 says a fat-loss phase LOOKS
// like a plateau; it states no correction, so there is none to implement. The
// phase is reported next to a verdict for a reader to discount by hand. No
// threshold moves, no comparison is weighted, no plateau is suppressed.

/** The three observed phases, per `ComparabilitySubject.phase`'s docstring (B34). */
export const DIET_PHASES = ['fat-loss', 'gain', 'maintenance'] as const;

export type DietPhase = (typeof DIET_PHASES)[number];

/**
 * One observed phase over a half-open instant range `[startedAt, endedAt)`.
 * An absent `endedAt` means the range is still open — the phase the lifter is
 * in now. At most one open range exists per user; see `declareDietPhase`.
 */
export interface DietPhaseRange {
  startedAt: string;
  endedAt?: string;
}

/**
 * Does `range` cover every instant in `[from, to]`?
 *
 * Half-open at the end so two adjacent ranges never both cover the instant
 * they meet at: the closing range ends exactly where the new one starts, and
 * the new one owns that instant. `from === to` degenerates to a point test.
 */
export function covers(range: DietPhaseRange, from: string, to: string): boolean {
  if (from > to) return false;
  if (from < range.startedAt) return false;
  return range.endedAt === undefined || to < range.endedAt;
}

/** Is `value` one of the three observed phases? */
export function isDietPhase(value: string): value is DietPhase {
  return (DIET_PHASES as readonly string[]).includes(value);
}
