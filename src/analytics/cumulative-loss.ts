// VW-375 (research W4): the shared cumulative-loss + trend FACTS that VW-346's
// R6 (the block-boundary diet re-ask) and VW-373's W2 (the bodyweight-rate
// advisory) both read, so the diet-fatigue bands exist in exactly one file.
// Two implementations of the 7% / 10% bands would drift (VW-367 §4).
//
// PURE. No store, no clock: `now` is an input, exactly as in
// `bodyweight-trend.ts`. This module answers "how much has been lost, and what
// does RP call that", never "what should change" — the proposals, cadence and
// vetoes belong to R6 and W2.
//
// THE TREND FACTS ARE NOT RECOMPUTED HERE. `computeBodyweightTrend` owns the
// smoothed mean series, the weekly delta and the slope class; this module
// imports it and passes those through beside the band.
//
// EVERY CONSTANT NAMES ITS SOURCE, same convention as `diet-phase-tolerance.ts`,
// `goal-band.ts` and `bodyweight-trend.ts`: `rp:<id>` for a mined note,
// ENGINEERING DEFAULT for a number the corpus does not state.

import {
  computeBodyweightTrend,
  type BodyweightMeanPoint,
  type BodyweightRateClass,
  type BodyweightSlopeClass,
  type BodyweightTrendInput,
} from './bodyweight-trend.js';

/**
 * The mined note every band below comes from. Exported so a consumer's copy
 * can cite it without restating the id.
 */
export const CUMULATIVE_LOSS_SOURCE_ID = 'rp-s11-diet-fatigue-pct-weight-lost-proxy';

/**
 * The diet-fatigue proxy bands, as percent of starting bodyweight lost since
 * the phase began. Positive means lost.
 *
 * rp:rp-s11-diet-fatigue-pct-weight-lost-proxy, Claim verbatim: "For a
 * continuous fat-loss phase with no breaks, cumulative percent of starting
 * body weight lost is a better predictor of diet fatigue than elapsed time.
 * RP's rough bands: losing 3-5% of body weight produces little to no diet
 * fatigue regardless of how fast or slow it took; 7-10% usually produces
 * noticeable fatigue in most people; more than 10% lost in one continuous
 * phase almost always produces significant diet fatigue."
 *
 * The note's own caveat calls these "rounded ranges ... not exact cutoffs".
 */
export const CUMULATIVE_LOSS_CONSTANTS = {
  /**
   * Where the note's lowest named band opens, in percent lost.
   * rp:rp-s11-diet-fatigue-pct-weight-lost-proxy ("losing 3-5%").
   */
  lowBandFloorPct: 3,
  /**
   * Where the note's lowest named band closes, in percent lost.
   * rp:rp-s11-diet-fatigue-pct-weight-lost-proxy ("losing 3-5%"). Not itself a
   * cut point here: see `noticeableBandFloorPct` for what happens between.
   */
  lowBandCitedCeilingPct: 5,
  /**
   * Where noticeable diet fatigue opens, in percent lost.
   * rp:rp-s11-diet-fatigue-pct-weight-lost-proxy ("7-10% usually produces
   * noticeable fatigue"), and VW-346 §2d's first observed trigger.
   *
   * The note leaves 5-7% unnamed. ENGINEERING DEFAULT: that gap resolves
   * DOWNWARD into `low`, so nothing fires before the cited 7%.
   */
  noticeableBandFloorPct: 7,
  /**
   * Where significant diet fatigue opens, in percent lost.
   * rp:rp-s11-diet-fatigue-pct-weight-lost-proxy ("more than 10% ... almost
   * always produces significant diet fatigue"), and VW-346 §2d's second
   * observed trigger.
   *
   * The note says "more than 10%"; VW-346 §2d fires on the CROSSING. Treating
   * the boundary as inclusive is the trigger-safe reading of a band the note
   * itself calls rounded, and is an ENGINEERING DEFAULT at exactly 10.0%.
   */
  significantBandFloorPct: 10,
} as const;

/** RP's own words for how much diet fatigue the cumulative loss predicts. */
export type DietFatigueProxyBand = 'none' | 'low' | 'noticeable' | 'significant';

/** Bands weakest first, so a consumer can tell an escalation from a repeat. */
export const DIET_FATIGUE_BAND_ORDER: readonly DietFatigueProxyBand[] = [
  'none',
  'low',
  'noticeable',
  'significant',
];

export interface CumulativeLossFacts {
  /** Percent of phase-start weight lost. Positive is lost, negative is gained. */
  pctLostSincePhaseStart: number | null;
  /** `null` when the series is too thin for a mean, so no band is claimed. */
  band: DietFatigueProxyBand | null;
  /** The percent at which `band` opens, or `null` for `none` and unevaluable. */
  bandFloorPct: number | null;
  weeksInPhase: number;
  /** `'settling'` means weeks 1-2, where the loss is still water (VW-367 §1c). */
  rateClass: BodyweightRateClass;
  weeklyDeltaLbs: number | null;
  slopeClass: BodyweightSlopeClass | null;
  /** The 7-day mean series `computeBodyweightTrend` built, passed through. */
  meanSeries: readonly BodyweightMeanPoint[];
}

/** Where a band sits in `DIET_FATIGUE_BAND_ORDER`. */
export function dietFatigueBandRank(band: DietFatigueProxyBand): number {
  return DIET_FATIGUE_BAND_ORDER.indexOf(band);
}

/**
 * Classify percent lost against the cited bands. A gain (negative percent
 * lost) is `'none'`: the proxy is defined for a continuous fat-loss phase.
 */
export function classifyCumulativeLossPct(pctLost: number): DietFatigueProxyBand {
  const { lowBandFloorPct, noticeableBandFloorPct, significantBandFloorPct } =
    CUMULATIVE_LOSS_CONSTANTS;
  if (pctLost >= significantBandFloorPct) return 'significant';
  if (pctLost >= noticeableBandFloorPct) return 'noticeable';
  if (pctLost >= lowBandFloorPct) return 'low';
  return 'none';
}

function bandFloorPct(band: DietFatigueProxyBand): number | null {
  switch (band) {
    case 'significant':
      return CUMULATIVE_LOSS_CONSTANTS.significantBandFloorPct;
    case 'noticeable':
      return CUMULATIVE_LOSS_CONSTANTS.noticeableBandFloorPct;
    case 'low':
      return CUMULATIVE_LOSS_CONSTANTS.lowBandFloorPct;
    case 'none':
      return null;
  }
}

/**
 * The cumulative-loss band plus the trend facts behind it, for one lifter at
 * one instant. No I/O, no `Date.now()` — `input.now` is the only clock.
 */
export function computeCumulativeLossFacts(input: BodyweightTrendInput): CumulativeLossFacts {
  const trend = computeBodyweightTrend(input);
  const signedPctChange = trend.cumulativePctChangeSincePhaseStart;
  const pctLostSincePhaseStart = signedPctChange === null ? null : -signedPctChange;
  const band =
    pctLostSincePhaseStart === null ? null : classifyCumulativeLossPct(pctLostSincePhaseStart);

  return {
    pctLostSincePhaseStart,
    band,
    bandFloorPct: band === null ? null : bandFloorPct(band),
    weeksInPhase: trend.weeksInPhase,
    rateClass: trend.rateClass,
    weeklyDeltaLbs: trend.weeklyDeltaLbs,
    slopeClass: trend.slopeClass,
    meanSeries: trend.meanSeries,
  };
}
