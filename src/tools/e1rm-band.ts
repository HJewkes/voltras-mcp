// The error band every e1RM this server reports travels with (VW-267).
//
// Greig, Aspe, Hall, Comfort, Cooper & Swinton (Sports Medicine, 2023) pooled
// 137 load-velocity models over 26 studies and 434 participants: standard error
// of the estimate 9.8% of measured 1RM (95% CI 7.4 to 12.2), with a SYSTEMATIC
// overestimate of 4.5 kg, equal to 3.7% of 1RM (95% CI 0.5 to 6.9). Those
// authors' own recommendation is to use direct 1RM assessment where possible
// and treat a load-velocity estimate as a TREND instrument across a training
// cycle, never as the number that sets today's load. Banyard, Nosaka & Haff
// (J Strength Cond Res, 2017) name the noise source: actual 1RM repeats with
// ICC 0.99 / CV 2.1%, but the velocity at 1RM repeats with ICC 0.42 / CV 22.5%,
// and that instability is what the extrapolation multiplies.
//
// So `fitFor` is the load-bearing field, not the numbers. It is `'trend'` on
// every band this module builds, whatever the method, because no e1RM here is
// a measurement.
//
// THE POOLED FIGURES ARE LOAD-VELOCITY FIGURES AND ARE NOT TRANSFERRED. A
// rep-based (Epley) estimate never touches a velocity, so Greig's SEE does not
// describe its error and no source in this repo states one that does. Its band
// therefore carries nulls and says why, the same posture `history.trend` takes
// on `direction` and `history.weekly_volume` takes on `verdict`. A pooled
// number reported against a method it was not measured on would read as
// evidence, and there is none.
//
// The bias is REPORTED, NEVER APPLIED. Subtracting a pooled 3.7% from one
// lifter's one exercise would invent a correction the meta-analysis does not
// license; the band shows the figure and leaves the estimate alone.

/** Which estimator produced the e1RM a band is being built for. */
export type E1RMMethod = 'profile' | 'reps' | 'hybrid';

/** Pooled standard error of the estimate, as a percentage of measured 1RM. */
export const E1RM_SEE_PCT = 9.8;

/** 95% CI on `E1RM_SEE_PCT`. */
export const E1RM_SEE_PCT_CI: readonly [number, number] = [7.4, 12.2];

/** Systematic overestimate, as a percentage of measured 1RM. */
export const E1RM_BIAS_PCT = 3.7;

/** 95% CI on `E1RM_BIAS_PCT`. */
export const E1RM_BIAS_PCT_CI: readonly [number, number] = [0.5, 6.9];

const CITATION =
  'Greig, Aspe, Hall, Comfort, Cooper & Swinton, Sports Medicine 2023 — individual-participant ' +
  'meta-analysis of 137 load-velocity models, 26 studies, 434 participants; noise source in ' +
  'Banyard, Nosaka & Haff, J Strength Cond Res 2017 (velocity at 1RM, ICC 0.42, CV 22.5%).';

/**
 * What a reader has to know before using the number the band is attached to.
 * Every numeric field is null when no source in this repo states that figure
 * for the method that produced the estimate.
 */
export interface E1RMBand {
  /** Always `'trend'`: an e1RM is evidence across sessions, never within one. */
  fitFor: 'trend';
  method: E1RMMethod;
  seePct: number | null;
  seePctCi: readonly [number, number] | null;
  /** `seePct` of this estimate, in lb. */
  seeLbs: number | null;
  biasPct: number | null;
  /** `biasPct` of this estimate, in lb. Reported, never subtracted. */
  biasLbs: number | null;
  /** The estimate minus/plus `seeLbs`. */
  lowLbs: number | null;
  highLbs: number | null;
  citation: string;
  note: string;
}

const VELOCITY_NOTE =
  'Trend instrument, not a measurement: the pooled standard error is 9.8% of 1RM (95% CI 7.4 to ' +
  '12.2) and the estimate runs 3.7% high on average (a 4.5 kg systematic overestimate, 95% CI ' +
  '0.5 to 6.9). The bias is reported here, never subtracted — a pooled correction does not ' +
  'describe one lifter on one exercise. A session-to-session change smaller than `seeLbs` is ' +
  'indistinguishable from estimation error, so read the multi-session slope from ' +
  '`metrics.compute history.trend` (metric `e1rm`) and never move load on a single-session ' +
  'delta.';

const REPS_NOTE =
  'Trend instrument, not a measurement. The numeric fields are null on purpose: this estimate ' +
  'is the Epley rep formula, which never touches a velocity, and the only pooled error figures ' +
  'this repo cites (standard error 9.8% of 1RM, systematic overestimate 3.7%) were measured on ' +
  'LOAD-VELOCITY models. Reporting them against a rep formula would read as evidence that was ' +
  'never collected, so they are named here as context and applied to nothing. What still holds ' +
  'is the posture: read the multi-session slope from `metrics.compute history.trend` (metric ' +
  '`e1rm`) and never move load on a single-session delta.';

/** One decimal place, the precision the published figures themselves carry. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * The band for one e1RM. `method` decides whether the pooled load-velocity
 * figures describe it; see this module's header for why `reps` gets nulls.
 */
export function e1rmBand(e1rmLbs: number, method: E1RMMethod): E1RMBand {
  if (method === 'reps') {
    return {
      fitFor: 'trend',
      method,
      seePct: null,
      seePctCi: null,
      seeLbs: null,
      biasPct: null,
      biasLbs: null,
      lowLbs: null,
      highLbs: null,
      citation: CITATION,
      note: REPS_NOTE,
    };
  }
  const seeLbs = round1((e1rmLbs * E1RM_SEE_PCT) / 100);
  return {
    fitFor: 'trend',
    method,
    seePct: E1RM_SEE_PCT,
    seePctCi: E1RM_SEE_PCT_CI,
    seeLbs,
    biasPct: E1RM_BIAS_PCT,
    biasLbs: round1((e1rmLbs * E1RM_BIAS_PCT) / 100),
    lowLbs: round1(e1rmLbs - seeLbs),
    highLbs: round1(e1rmLbs + seeLbs),
    citation: CITATION,
    note: VELOCITY_NOTE,
  };
}

/**
 * Whether two e1RM readings differ by less than the pooled standard error —
 * i.e. whether the difference is indistinguishable from estimation error.
 * Scaled off the larger reading, so the band is the wider of the two.
 */
export function withinE1RMBand(a: number, b: number): boolean {
  const see = (Math.max(a, b) * E1RM_SEE_PCT) / 100;
  return Math.abs(a - b) < see;
}
