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
// NO INTERPRETATION LIVES HERE, AND NONE IN THE COMPARABILITY PATH. B34 says a
// fat-loss phase LOOKS like a plateau; it states no correction, so this module
// and every comparability reader of it still only report the phase next to a
// verdict for a reader to discount by hand.
//
// THE EQUIVALENCE TABLE IS VOCABULARY, NOT INTERPRETATION (VW-366).
// `dietPhasesComparable` says which tags name the same training context, so a
// lifter who relabels maintenance as recomposition keeps every pair they had.
// It reads the corpus's own synonymy, and no caller may read a verdict off it.
//
// RECOMPOSITION IS A FOURTH LABEL OVER MAINTENANCE'S ARITHMETIC (VW-363). The
// corpus uses the word as a synonym for the middle phase
// (rp-s12-recomposition-requires-maintenance-calories), so the lifter's own
// label is recorded as its own value while every reader of the phase treats
// it exactly as maintenance.
//
// VW-277 IS THE EXCEPTION, AND IT IS EXPLICIT. `analytics/diet-phase-tolerance.ts`
// now moves autoregulation thresholds off the phase and weeks-in-phase, for the
// three callers named in its header. The citation B34 lacked is the mined RP
// S12 corpus; the discounting a reader used to do by hand is what that table
// does. Nothing else reads the phase that way.

/**
 * The four observed phases. The first three are `ComparabilitySubject.phase`'s
 * docstring (B34); `recomposition` is VW-363's addition — a lifter's own label
 * for a maintenance-calorie strategy (rp-s12-recomposition-requires-maintenance-calories),
 * sharing maintenance's arithmetic everywhere below.
 */
export const DIET_PHASES = ['fat-loss', 'gain', 'maintenance', 'recomposition'] as const;

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

/** The distinct sets of arithmetic the vocabulary maps onto (VW-366). */
type PhaseEquivalenceClass = 'fat-loss' | 'gain' | 'maintenance';

/**
 * Which class each phase belongs to. Keyed by the union rather than `string`,
 * so a phase added to {@link DIET_PHASES} without a class chosen for it here is
 * a type error rather than a silent mismatch.
 *
 * `recomposition` shares maintenance's class: the corpus uses the word as a
 * synonym for the middle phase, so it shares maintenance's arithmetic rather
 * than naming a fourth physiology.
 */
const PHASE_EQUIVALENCE_CLASSES: Record<DietPhase, PhaseEquivalenceClass> = {
  'fat-loss': 'fat-loss',
  gain: 'gain',
  maintenance: 'maintenance',
  recomposition: 'maintenance',
};

/**
 * May two recorded phase tags be compared as the same training context?
 *
 * Absence is the CALLER's question, not this one's: `analytics/comparability.ts`
 * decides what an unrecorded phase means before either string reaches here. A
 * string this table has not been taught only ever matches itself, so a future
 * phase cannot become comparable by accident.
 */
export function dietPhasesComparable(a: string, b: string): boolean {
  const left = equivalenceClassOf(a);
  const right = equivalenceClassOf(b);
  if (left === undefined || right === undefined) return a === b;
  return left === right;
}

function equivalenceClassOf(phase: string): PhaseEquivalenceClass | undefined {
  return isClassedPhase(phase) ? PHASE_EQUIVALENCE_CLASSES[phase] : undefined;
}

function isClassedPhase(value: string): value is keyof typeof PHASE_EQUIVALENCE_CLASSES {
  return Object.hasOwn(PHASE_EQUIVALENCE_CLASSES, value);
}
