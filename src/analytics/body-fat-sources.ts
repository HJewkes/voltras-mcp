// What a body-fat percentage is worth, by where it came from (VW-364).
//
// EVERY NUMBER HERE IS COPIED FROM THE VW-370 LITERATURE NOTE AND CARRIES ITS
// CITATION ID. `C1`..`C45` are that note's own citation table; a reader
// resolves one there, which is also where the DOIs live. Nothing in this file
// is recalled, averaged or rounded into existence: a cell VW-370 marks
// `unsourced` is stored as `null` and says so in its `note`. Where a row's
// sourced figure is a RANGE, the conservative (wider) edge is stored and the
// `note` names the range, so a band is never narrower than the literature.
//
// TWO DIFFERENT ERRORS, AND THE SPLIT IS THE WHOLE POINT. VW-370 §9 finds that
// how well a method measures an ABSOLUTE percentage and how well it tracks a
// CHANGE are not the same question, and that for consumer bioimpedance they
// point opposite ways: cross-sectional SEE 3.1-7.5 points, change SEE 1.7-2.6
// points (C42). So `absoluteSeePctPoints` is display metadata and
// `changeSeePctPoints` is the only figure a delta may be rendered against.
//
// ABSOLUTE VALUES ARE DISPLAY-ONLY. Mainstream clinical guidance operates on
// bodyweight and waist, not on a fat percentage: NICE NG246 says in terms not
// to substitute bioimpedance for BMI (C33), the ADA 2026 criteria are BMI plus
// waist (C34), and the Lancet Commission makes a direct fat measurement
// optional (C32). Nothing in the recomposition design reads a percentage.
//
// CROSS-SOURCE COMPARISON IS EXCLUDED, NOT DISCOURAGED. A 1.4-point mean
// absolute offset between two DXA brands (C12) and a 4.4-point tape-versus-DXA
// gap (C36) each swamp a realistic twelve-week signal, so `sameDeviceDelta`
// refuses a pair whose sources differ rather than rendering it with a wider
// band.
//
// THE MDC SHORTCUT IS NOT AVAILABLE HERE. VW-370's method note keeps
// `2.77 x precision error` valid only for a device whose reported precision is
// real measurement noise, and C42 shows consumer foot-to-foot scales report
// 0.0-0.49% precision that looks algorithmically smoothed. No code path in
// this module multiplies a test-retest figure; the change SEE is stored
// directly or it is null.
//
// THIS MODULE NEVER ASKS FOR A READING. It has no opinion on when a lifter
// should get measured, produces no prompt and no reminder, and grades only
// what it is handed. That rule is a human decision (2026-09-13/14) and
// `body-fat-no-request.test.ts` makes it executable.

/**
 * The sources VW-370 §2 tabulates, one enum value per row of that table, plus
 * `other`.
 *
 * THREE OF THAT TABLE'S ROWS ARE DELIBERATELY ABSENT, because each states a
 * comparability condition rather than naming a source a lifter could pick:
 * "DXA, different machine/brand" and "Skinfolds, rater changes" are both the
 * cross-source case `sameDeviceDelta` already refuses, and "Visual /
 * self-reported band" produces no percentage at all — that is `LeannessBand`
 * in `store/leanness-band.ts`, stored in its own column and never converted.
 *
 * Rows VW-370 splits stay split. Hydrostatic weighing with a measured residual
 * volume and with a predicted one carry different figures (C17), as do the
 * seven-site and three/four-site skinfold protocols (C18), so collapsing
 * either pair would force a choice between two published numbers.
 */
export const BODY_FAT_SOURCES = [
  'mri',
  'ct',
  'dexa',
  'bodpod',
  'hydrostatic_measured_rv',
  'hydrostatic_predicted_rv',
  'mf_bia',
  'consumer_bia',
  'skinfold_7site',
  'skinfold_3_4_site',
  'navy_tape',
  'scan_3d',
  'ultrasound',
  'other',
] as const;

export type BodyFatSource = (typeof BODY_FAT_SOURCES)[number];

/** Is `value` one of the tabulated sources? */
export function isBodyFatSource(value: string): value is BodyFatSource {
  return (BODY_FAT_SOURCES as readonly string[]).includes(value);
}

/**
 * How much a source's output is worth as a class.
 *
 * ORDINAL AND COARSE. It is a reading aid for a caller deciding how loudly to
 * caveat a displayed number, never an input to arithmetic — the arithmetic
 * uses {@link BodyFatSourceTier.changeSeePctPoints} and nothing else.
 */
export type BodyFatTier = 'reference' | 'high' | 'moderate' | 'low';

/** One row of {@link BODY_FAT_SOURCE_TIERS}. */
export interface BodyFatSourceTier {
  tier: BodyFatTier;
  /**
   * Standard error of a CHANGE between two readings from the same source,
   * in percentage points. `null` where VW-370 publishes none, which makes a
   * delta unrenderable for that source rather than renderable with a guess.
   */
  changeSeePctPoints: number | null;
  /**
   * Individual cross-sectional error against the stated criterion, in
   * percentage points. `null` where VW-370 marks it unsourced. Display
   * metadata only: no delta is ever banded on this figure.
   */
  absoluteSeePctPoints: number | null;
  /** VW-370 citation-table ids backing the row. Empty only for `other`. */
  citationIds: readonly string[];
  /** What each stored number is, and what is unsourced. */
  note: string;
}

/**
 * The per-source table, transcribed from VW-370 §2, §4 and §9.
 *
 * Only three sources carry a change SEE, and that is VW-370's finding rather
 * than an omission here: §9 names a band for bioimpedance (C42) and for DXA
 * (C11) and for nothing else. Every other row's "MDC" in §2 is either
 * `unsourced` or an arithmetic derivation from a test-retest CV, and a derived
 * MDC is not a change SEE.
 */
export const BODY_FAT_SOURCE_TIERS: Readonly<Record<BodyFatSource, BodyFatSourceTier>> = {
  mri: {
    tier: 'reference',
    changeSeePctPoints: null,
    absoluteSeePctPoints: null,
    citationIds: ['C31'],
    note: 'Highest repeatability VW-370 retrieved: adipose-volume test-retest CV 0.79%. Its %fat error against a four-compartment model and any change SEE are both unsourced.',
  },
  ct: {
    tier: 'reference',
    changeSeePctPoints: null,
    absoluteSeePctPoints: null,
    citationIds: ['C2'],
    note: 'VW-370 tabulates CT with every cell unsourced. The tier is its imaging-criterion class per the IOC position statement, not a measured figure.',
  },
  dexa: {
    tier: 'high',
    changeSeePctPoints: 5.0,
    absoluteSeePctPoints: 4.5,
    citationIds: ['C8', 'C9', 'C11', 'C14'],
    note: 'Change band 2.0-5.0 points over three months (C11), conservative edge stored; absolute ~4.5 points derived in VW-370 from C14. C8 warns the accuracy of a DXA change (95% limits -3.7 to +5.3 points) is worse than its precision, and C9 puts consecutive-day error at roughly double same-day.',
  },
  bodpod: {
    tier: 'moderate',
    changeSeePctPoints: null,
    absoluteSeePctPoints: 3.27,
    citationIds: ['C14', 'C15', 'C16'],
    note: 'SD 3.27 points against DXA in the overweight/obese band (C15), where the bias is -1.68; the bias sign flips to +6.79 in underweight subjects. No change SEE in VW-370.',
  },
  hydrostatic_measured_rv: {
    tier: 'reference',
    changeSeePctPoints: null,
    absoluteSeePctPoints: null,
    citationIds: ['C17'],
    note: "VW-370 lists this only as a criterion input to C17's four-compartment model, with no standalone %fat error and no change SEE.",
  },
  hydrostatic_predicted_rv: {
    tier: 'moderate',
    changeSeePctPoints: null,
    absoluteSeePctPoints: 2.6,
    citationIds: ['C17'],
    note: 'SEE 2.0-2.6 points with a predicted residual volume, conservative edge stored; 95% limits of agreement under 5.2 points. Test-retest and change SEE both unsourced.',
  },
  mf_bia: {
    tier: 'moderate',
    changeSeePctPoints: 2.6,
    absoluteSeePctPoints: 2.6,
    citationIds: ['C21', 'C22', 'C30', 'C42'],
    note: 'Absolute SEE 2.6 points against DXA on one eight-electrode device (C21); C22 shows the offset is device-specific, not class-wide. Change SEE 1.7-2.6 points across fifteen devices at 12-16 weeks (C42), conservative edge stored. C30 found it misses regional lean changes DXA sees.',
  },
  consumer_bia: {
    tier: 'low',
    changeSeePctPoints: 2.6,
    absoluteSeePctPoints: 7.5,
    citationIds: ['C42'],
    note: 'Cross-sectional SEE 3.1-7.5 points against a four-compartment model, conservative edge stored, with constant error from -3.5 to +11.7 points. Change SEE 1.7-2.6 points, also conservative edge. Its reported precision error of 0.0-0.49% looks algorithmically constrained, so no MDC may be computed from it.',
  },
  skinfold_7site: {
    tier: 'moderate',
    changeSeePctPoints: null,
    absoluteSeePctPoints: 3.5,
    citationIds: ['C18', 'C19', 'C43'],
    note: 'SD 3.5 points against a four-compartment model with a -4.8 point bias (C18), so individual error reaches roughly -11.7. Error is rater-dominated: a rater change ends the series (C43, a preprint). No change SEE.',
  },
  skinfold_3_4_site: {
    tier: 'low',
    changeSeePctPoints: null,
    absoluteSeePctPoints: 6.9,
    citationIds: ['C18'],
    note: 'SD 6.9 points against a four-compartment model with a -3.1 point bias, on the four-site Peterson protocol. No test-retest and no change SEE.',
  },
  navy_tape: {
    tier: 'low',
    changeSeePctPoints: null,
    absoluteSeePctPoints: null,
    citationIds: ['C36'],
    note: 'The only sourced figure is a bias, not a spread: 4.38 points (men) and 4.59 points (women) below DXA in 1,904 soldiers. VW-370 retrieved no SEE, no test-retest and no MDC, and notes the equations extrapolate at extreme height. Track the raw tape instead.',
  },
  scan_3d: {
    tier: 'low',
    changeSeePctPoints: null,
    absoluteSeePctPoints: 6.1,
    citationIds: ['C24'],
    note: 'RMSE 3.7-6.1 points against a four-compartment model, conservative edge stored, with proportional bias in all four scanners tested. VW-370 derives an MDC from its repeatability but publishes no change SEE. Its circumferences are the useful output.',
  },
  ultrasound: {
    tier: 'low',
    changeSeePctPoints: null,
    absoluteSeePctPoints: null,
    citationIds: ['C40', 'C41'],
    note: 'Best-in-class inter-rater agreement for novice raters (C40) but poor agreement with calipers site by site (C41). Error against a four-compartment model and MDC are both unsourced.',
  },
  other: {
    tier: 'low',
    changeSeePctPoints: null,
    absoluteSeePctPoints: null,
    citationIds: [],
    note: 'No row in VW-370. Nothing is claimed about it: the tier is the conservative floor rather than a finding, and with no change SEE no delta renders.',
  },
};

/** One stored body-fat reading, as `sameDeviceDelta` needs to see it. */
export interface BodyFatReading {
  measuredAt: string;
  bodyFatPct: number;
  source: BodyFatSource;
}

/** A renderable same-source change. */
export interface SameDeviceDelta {
  /** Later minus earlier, in percentage points. */
  deltaPctPoints: number;
  /** Half-width of the change-error band: the source's change SEE. */
  bandPctPoints: number;
  verdict: 'increase' | 'decrease' | 'no measurable change';
}

/**
 * Either a delta or the reason there is none. Never both, and never a delta
 * without its band.
 */
export type SameDeviceDeltaResult =
  | { delta: SameDeviceDelta; reason: null }
  | { delta: null; reason: string };

/** Refusal reasons, spelled once so a caller can match on them. */
export const DELTA_REFUSAL_DIFFERENT_SOURCE = 'different source';
export const DELTA_REFUSAL_NO_CHANGE_ERROR = 'no published change error for this source';

/**
 * The change between two readings from the SAME source, banded by that
 * source's change SEE.
 *
 * `readings` is ordered [earlier, later]; the delta is later minus earlier.
 *
 * A delta no larger than the band reads `no measurable change` and NEVER a
 * direction word. That is the honest rendering of a movement the instrument
 * cannot resolve, and it is why the band is stored per source rather than
 * applied as one global threshold.
 */
export function sameDeviceDelta(
  readings: readonly [BodyFatReading, BodyFatReading],
): SameDeviceDeltaResult {
  const [earlier, later] = readings;
  if (earlier.source !== later.source) {
    return { delta: null, reason: DELTA_REFUSAL_DIFFERENT_SOURCE };
  }
  const band = BODY_FAT_SOURCE_TIERS[later.source].changeSeePctPoints;
  if (band === null) {
    return { delta: null, reason: DELTA_REFUSAL_NO_CHANGE_ERROR };
  }
  const deltaPctPoints = later.bodyFatPct - earlier.bodyFatPct;
  return {
    delta: {
      deltaPctPoints,
      bandPctPoints: band,
      verdict: verdictFor(deltaPctPoints, band),
    },
    reason: null,
  };
}

function verdictFor(deltaPctPoints: number, band: number): SameDeviceDelta['verdict'] {
  if (Math.abs(deltaPctPoints) <= band) return 'no measurable change';
  return deltaPctPoints > 0 ? 'increase' : 'decrease';
}
