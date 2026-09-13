// Two separately named fatigue axes (VW-306).
//
// The fatigue reads this server already ships blend two physiologically
// distinct things into one number. VW-278's literature review, which found no
// dietary proxy in this telemetry at all, separates them:
//
//   - ENTRY DEPRESSION — how far the session's opening working set at a given
//     load sits below what this lifter usually produces at that load. This is
//     the under-recovery axis, and it is the one with support: the heavy (L0)
//     end of the load-velocity profile fell 8.3 kg under moderate and 32.6 kg
//     under high fatigue, which is the signal VW-269 moved `session.readiness`
//     onto (Senturk, Kumak & Janicijevic, 2026, doi:10.1186/s13102-026-01615-x).
//   - LATE-SESSION DECAY — how fast output falls ACROSS sets at matched load
//     inside one session. This is accumulated work, not recovery state, and
//     set-to-set steepening is the normal case after two sets with no
//     manipulation at all (Chung, 2026, doi:10.3390/app16094513).
//
// A depressed entry with flat decay and a normal entry with steep decay are
// opposite situations that today's single decay number cannot tell apart.
//
// NEITHER AXIS IS A NUTRITION READ, and nothing here may be named or described
// as one. Where the glycogen contrast is large enough to matter it changes how
// LONG work is sustained, not how fast each contraction decays: time to task
// failure ran 65% longer on the loaded leg while MVC, twitch force and RFD
// were unaffected (Thomassen et al., 2025, doi:10.3389/fphys.2025.1564523),
// and the one study to measure squat velocity loss under sustained dietary
// restriction found no change (p = 0.591, Vargas-Molina et al., 2024,
// doi:10.1080/15502783.2024.2306308). `fatigue-axes.test.ts` pins that this
// module's text and the matching `coaching.explain` topic never attribute
// either axis to intake.
//
// PURE. Every input is an already-fetched, already-normalised reading; the
// caller owns unit normalisation, rep eligibility and which sets belong to
// which comparison.

/** A confounder an axis either held fixed between the two things it compared, or did not. */
export type FatigueConfounder = 'rest' | 'load' | 'eccentricSetting' | 'warmupState';

const ALL_CONFOUNDERS: readonly FatigueConfounder[] = [
  'rest',
  'load',
  'eccentricSetting',
  'warmupState',
];

/**
 * Loads within this fraction of each other count as the same load. Matched
 * load is what makes either axis a comparison rather than a restatement of the
 * weight on the cable: work completed at a fixed velocity-loss threshold falls
 * about 2.1 reps between 70% and 80% 1RM, so an unmatched pair reports the
 * load change as fatigue.
 */
const LOAD_MATCH_TOLERANCE = 0.05;

/**
 * Rest intervals within this fraction of each other count as controlled. Rest
 * length is the dominant term in how much output one set preserves into the
 * next, so a pair whose rests differ by more than this had it varying, not
 * held.
 */
const REST_MATCH_TOLERANCE = 0.2;

/** Comparisons beyond this add no further confidence. */
const EVIDENCE_SATURATION_SETS = 4;

const CONFIDENCE_FLOOR = 0.2;
const CONFIDENCE_PER_CONTROLLED_CONFOUNDER = 0.15;
const CONFIDENCE_EVIDENCE_WEIGHT = 0.2;

/** One set, reduced to what an axis comparison reads. */
export interface FatigueSetReading {
  setId: string;
  /**
   * Mean concentric velocity over the set's ELIGIBLE reps, on whatever scale
   * the caller normalised to. Both axes are ratios, so the unit cancels — but
   * only if every reading in one comparison came off the same scale.
   */
  meanVelocity?: number;
  loadLbs?: number;
  /** Achieved rest before this set, in seconds. Absent means unrecorded. */
  restBeforeSec?: number;
  /** Eccentric overload setting. Absent means unrecorded, never "none". */
  eccentricPct?: number;
  isWarmup: boolean;
}

export interface FatigueAxis {
  /** Percent. `null` means "not measurable from what was recorded". */
  value: number | null;
  /** Coarse 0-1, for ordering and gating — not for arithmetic. */
  confidence: number;
  controlledConfounders: FatigueConfounder[];
  uncontrolled: FatigueConfounder[];
  /** How many sets fed the comparison. */
  setsCompared: number;
  /** What was compared against what, in prose. */
  basis: string;
}

export interface FatigueAxes {
  entryDepression: FatigueAxis;
  lateSessionDecay: FatigueAxis;
  note: string;
}

export interface FatigueAxesInput {
  /** This session's sets for one exercise, in session order, warm-ups included. */
  sessionSets: readonly FatigueSetReading[];
  /** Prior-session sets for the same exercise, the entry comparison's reference. */
  referenceSets: readonly FatigueSetReading[];
}

export const FATIGUE_AXES_NOTE =
  'Two axes, reported separately because they are different things: entry depression is a ' +
  'recovery-state read on the session opener at matched load, late-session decay is the cost of ' +
  'work already done inside this session. A high value on one says nothing about the other. ' +
  'Neither is a verdict on training quality, and neither supports an inference about what the ' +
  'lifter ate: the mechanism that would make it one changes how long work is sustained, not how ' +
  'fast each contraction decays, and this server stops sets at a velocity-loss threshold before ' +
  'that ever shows.';

const ENTRY_BASIS_MEASURED =
  "this session's opening working set against the lifter's own prior sets at the same load — " +
  'the heavy-end (L0) reading that discriminates fatigue states';
const ENTRY_BASIS_UNAVAILABLE =
  'no prior set at this load to compare the session opener against, so recovery state is ' +
  'unreadable rather than normal';
const DECAY_BASIS_MEASURED =
  "the slope of mean concentric velocity across this session's matched-load working sets, " +
  'as a percentage of the opening set lost per additional set';
const DECAY_BASIS_UNAVAILABLE =
  'fewer than two working sets at one load in this session, so there is no across-set slope to ' +
  'fit rather than a flat one';

/**
 * Both axes for one exercise's work in one session.
 *
 * The entry comparison is CROSS-session and the decay comparison is
 * WITHIN-session on purpose: that is the whole separation. Both are anchored
 * to the opening working set's load so they answer about the same work.
 */
export function computeFatigueAxes(input: FatigueAxesInput): FatigueAxes {
  const sessionWorking = input.sessionSets.filter(isComparable);
  const entrySet = sessionWorking[0];
  return {
    entryDepression: entryDepressionAxis(entrySet, input),
    lateSessionDecay: lateSessionDecayAxis(entrySet, sessionWorking),
    note: FATIGUE_AXES_NOTE,
  };
}

/** How far the session opener sits below the lifter's own prior output at that load. */
function entryDepressionAxis(
  entrySet: FatigueSetReading | undefined,
  input: FatigueAxesInput,
): FatigueAxis {
  const matched = input.referenceSets.filter((set) => isComparable(set) && sameLoad(set, entrySet));
  if (entrySet === undefined || matched.length === 0) return unmeasurable(ENTRY_BASIS_UNAVAILABLE);

  const referenceVelocity = mean(matched.map(velocityOf));
  if (referenceVelocity <= 0) return unmeasurable(ENTRY_BASIS_UNAVAILABLE);

  const compared = [entrySet, ...matched];
  return axis({
    value: ((referenceVelocity - velocityOf(entrySet)) / referenceVelocity) * 100,
    controlled: [
      // A matched reference exists only when both ends recorded the same load.
      'load',
      ...(sameRest(compared) ? (['rest'] as const) : []),
      ...(sameEccentric(compared) ? (['eccentricSetting'] as const) : []),
      ...(comparableWarmupState(input) ? (['warmupState'] as const) : []),
    ],
    setsCompared: compared.length,
    basis: ENTRY_BASIS_MEASURED,
  });
}

/** How fast output falls across this session's matched-load working sets. */
function lateSessionDecayAxis(
  entrySet: FatigueSetReading | undefined,
  sessionWorking: readonly FatigueSetReading[],
): FatigueAxis {
  const matched = sessionWorking.filter((set) => sameLoad(set, entrySet));
  const opening = matched[0];
  if (opening === undefined || matched.length < 2) return unmeasurable(DECAY_BASIS_UNAVAILABLE);

  const openingVelocity = velocityOf(opening);
  if (openingVelocity <= 0) return unmeasurable(DECAY_BASIS_UNAVAILABLE);

  return axis({
    value: (-slopePerSet(matched.map(velocityOf)) / openingVelocity) * 100,
    controlled: [
      'load',
      // Every set here sits after the same warm-up, in the same session.
      'warmupState',
      ...(sameRest(matched) ? (['rest'] as const) : []),
      ...(sameEccentric(matched) ? (['eccentricSetting'] as const) : []),
    ],
    setsCompared: matched.length,
    basis: DECAY_BASIS_MEASURED,
  });
}

function axis(spec: {
  value: number;
  controlled: readonly FatigueConfounder[];
  setsCompared: number;
  basis: string;
}): FatigueAxis {
  const controlled = ALL_CONFOUNDERS.filter((name) => spec.controlled.includes(name));
  return {
    value: round2(spec.value),
    confidence: confidenceOf(controlled.length, spec.setsCompared),
    controlledConfounders: controlled,
    uncontrolled: ALL_CONFOUNDERS.filter((name) => !controlled.includes(name)),
    setsCompared: spec.setsCompared,
    basis: spec.basis,
  };
}

/**
 * An axis with nothing to compare. Confidence 0 and value `null` rather than
 * 0: a flat number would read as "no fatigue" where the truth is "we could not
 * look", and those two lead a lifter to opposite decisions.
 */
function unmeasurable(basis: string): FatigueAxis {
  return {
    value: null,
    confidence: 0,
    controlledConfounders: [],
    uncontrolled: [...ALL_CONFOUNDERS],
    setsCompared: 0,
    basis,
  };
}

/**
 * A floor, plus how many of the four confounders the comparison actually held
 * fixed, plus how much evidence it had. Coarse by design — an axis whose rest
 * and eccentric setting both drifted is worth less than one that held them,
 * and this says so without pretending the difference is calibrated.
 */
function confidenceOf(controlledCount: number, setsCompared: number): number {
  const evidence = Math.min(setsCompared, EVIDENCE_SATURATION_SETS) / EVIDENCE_SATURATION_SETS;
  return round2(
    Math.min(
      1,
      CONFIDENCE_FLOOR +
        CONFIDENCE_PER_CONTROLLED_CONFOUNDER * controlledCount +
        CONFIDENCE_EVIDENCE_WEIGHT * evidence,
    ),
  );
}

/** Least-squares slope of `values` against their own 0-based ordinal. */
function slopePerSet(values: readonly number[]): number {
  const n = values.length;
  const meanIndex = (n - 1) / 2;
  const meanValue = mean(values);
  let covariance = 0;
  let variance = 0;
  values.forEach((value, index) => {
    covariance += (index - meanIndex) * (value - meanValue);
    variance += (index - meanIndex) ** 2;
  });
  return variance === 0 ? 0 : covariance / variance;
}

function isComparable(set: FatigueSetReading): boolean {
  return !set.isWarmup && set.meanVelocity !== undefined && set.meanVelocity > 0;
}

function velocityOf(set: FatigueSetReading): number {
  return set.meanVelocity ?? 0;
}

function sameLoad(set: FatigueSetReading, reference: FatigueSetReading | undefined): boolean {
  const target = reference?.loadLbs;
  if (target === undefined || target <= 0 || set.loadLbs === undefined) return false;
  return Math.abs(set.loadLbs - target) / target <= LOAD_MATCH_TOLERANCE;
}

/**
 * Rest counts as controlled only when every compared set RECORDED it and the
 * recorded values agree. An unrecorded rest is unknown, never "the same".
 */
function sameRest(sets: readonly FatigueSetReading[]): boolean {
  const rests = sets.map((set) => set.restBeforeSec);
  if (rests.some((rest) => rest === undefined || rest <= 0)) return false;
  const values = rests as number[];
  const reference = values[0]!;
  return values.every((rest) => Math.abs(rest - reference) / reference <= REST_MATCH_TOLERANCE);
}

/** Same rule as {@link sameRest}: unrecorded is unknown, not "no overload". */
function sameEccentric(sets: readonly FatigueSetReading[]): boolean {
  const settings = sets.map((set) => set.eccentricPct);
  if (settings.some((pct) => pct === undefined)) return false;
  return settings.every((pct) => pct === settings[0]);
}

/**
 * Warm-up state is controlled for the entry comparison only when both the
 * session and its reference recorded warm-up work — a session opener taken
 * cold is slower for reasons that are not recovery state.
 */
function comparableWarmupState(input: FatigueAxesInput): boolean {
  const warmedUp = (sets: readonly FatigueSetReading[]): boolean =>
    sets.some((set) => set.isWarmup);
  return warmedUp(input.sessionSets) && warmedUp(input.referenceSets);
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
