// An error-minimising minimum velocity threshold (MVT), fitted per exercise
// from one lifter's own history (VW-299).
//
// WHY NOT THE OBSERVED VELOCITY OF THE HEAVIEST REP
// -------------------------------------------------
// The obvious individual MVT is the velocity the lifter actually produced on
// their heaviest single — their observed V1RM. Banyard, Nosaka & Haff (2017)
// measured how stable that is across three sessions: the 1RM itself is
// rock-solid (ICC 0.99, CV 2.1 %) while the velocity at 1RM is not (ICC 0.42,
// CV 22.5 %). Anchoring an extrapolation to a number with that much
// session-to-session spread is the root of most MVT prediction error.
//
// Fitas et al. (2024) took the other route: pick the threshold that MINIMISES
// 1RM prediction error over the lifter's own history rather than reading one
// off a single maximal effort. That cut mean absolute error to 2.8 %, against
// 5.5 % for the individually observed MVT and 4.9 % for a general one. This
// module is that fit.
//
// It is still an extrapolation. Fitas' limits of agreement stayed around 15 kg,
// so a fitted MVT makes an e1RM less wrong, never a measurement — the band on
// `metrics.compute strength.e1rm` (VW-267) still applies unchanged.

import {
  DEFAULT_MVT,
  VELOCITY_AT_PERCENT_1RM,
  buildProfile,
  estimateE1RMFromReps,
  type LoadVelocityDataPoint,
} from '@voltras/workout-analytics';

/** One working set as the fit sees it: a load, a velocity, and its session. */
export interface MvtSetObservation {
  /** Groups observations into the bout they were performed in. */
  sessionId: string;
  /** ISO-8601 start, the only ordering this module trusts. */
  startedAt: string;
  loadLbs: number;
  /** Best rep of the set — the least-fatigued point of the load-velocity pair. */
  bestRepVelocityMps: number;
  repCount: number;
  /**
   * The set ended at momentary failure. Only these anchor a reference 1RM: a
   * set with reps left in the tank says nothing about maximal capacity.
   */
  failure: boolean;
}

/** What the fit found, or what `fitOptimalMvt` returns nothing instead of. */
export interface OptimalMvtFit {
  /** The error-minimising threshold, m/s. */
  mvt: number;
  /** Mean absolute 1RM prediction error at `mvt`, percent. */
  errorPct: number;
  /** Anchored sessions the fit was measured over. */
  sampleSize: number;
  /** Velocity on the heaviest anchored set — the threshold this replaces. */
  observedV1rm: number;
}

/**
 * The search interval, and why it ends where it does.
 *
 * The ceiling is `VELOCITY_AT_PERCENT_1RM[80]`: the analytics package's own
 * reference velocity for a rep at 80 % of 1RM. A "minimum velocity" above that
 * would be calling a rep a lifter has several more of a maximal one, which is
 * not a 1RM under any definition — a fit that wants to go there is fitting
 * something other than maximal effort.
 *
 * The floor is 0.05 m/s: below it a rep has effectively stalled, the linear
 * profile is extrapolating far past its heaviest observed load, and the
 * resulting e1RM diverges. Neither bound is a threshold anyone should be
 * training at; they exist to keep the minimiser inside the region where the
 * model it is minimising over means anything.
 *
 * The step is 0.005 m/s — an order of magnitude finer than the between-session
 * spread of V1RM itself (Banyard 2017: CV 22.5 %, tens of thousandths of a m/s
 * on a typical threshold), so the grid is never the limiting resolution.
 */
export const MVT_FIT_BOUNDS = {
  minMps: 0.05,
  maxMps: VELOCITY_AT_PERCENT_1RM[80],
  stepMps: 0.005,
} as const;

/**
 * Anchored sessions required before a fit is reported.
 *
 * Three, matching the failure anchors `BASELINE_THRESHOLDS.minCalibratedAnchors`
 * requires for CALIBRATED, and for the same reason: one free parameter fitted
 * against one or two targets reproduces them rather than generalising, and the
 * per-session velocity noise Banyard measured is exactly what a two-point fit
 * would be chasing. Below this the honest answer is no fit at all.
 */
export const MIN_ANCHORED_SESSIONS = 3;

/** Where the threshold an estimate was solved at came from. */
export type MvtBasis = 'optimal' | 'observed' | 'default';

/** A threshold and its provenance, never one without the other. */
export interface MvtChoice {
  mvt: number;
  basis: MvtBasis;
}

/** The fitted half of a stored baseline row, as the resolver reads it. */
export interface FittedMvtRecord {
  optimalMvt?: number;
  optimalMvtObservedV1rm?: number;
}

/**
 * Which threshold an e1RM should be solved at, and what to call it.
 *
 * A stored fit wins: it is the only one of the three measured against this
 * lifter's own prediction error (Fitas et al. 2024, 2.8 % against 4.9 % for a
 * general threshold). With no fit stored the general default stands — the
 * individually observed V1RM is NOT promoted into the gap, because it is the
 * worst of the three (5.5 %) and the least stable between sessions (Banyard et
 * al. 2017, ICC 0.42).
 *
 * `observed` is reported when the fit converged onto the observed V1RM anyway.
 * The threshold in force is then that velocity, and calling it `optimal` would
 * claim an individualisation the search did not actually find.
 */
export function resolveMvt(fitted: FittedMvtRecord | undefined): MvtChoice {
  const mvt = fitted?.optimalMvt;
  if (mvt === undefined || !(mvt > 0)) return { mvt: DEFAULT_MVT, basis: 'default' };
  const observed = fitted?.optimalMvtObservedV1rm;
  const landedOnObserved =
    observed !== undefined && Math.abs(mvt - observed) <= MVT_FIT_BOUNDS.stepMps / 2;
  return { mvt, basis: landedOnObserved ? 'observed' : 'optimal' };
}

/** A session's load-velocity model as of that day, plus what it should predict. */
interface AnchoredTrial {
  referenceE1rm: number;
  slope: number;
  intercept: number;
}

/**
 * Fit the MVT that minimises absolute 1RM prediction error over this
 * exercise's own history. `null` when the history cannot support a fit — fewer
 * than {@link MIN_ANCHORED_SESSIONS} anchored sessions, or no usable profile.
 *
 * Each anchored session is scored against the profile as it stood THAT DAY
 * (an expanding window over prior sets, including that session's own), never
 * against the finished history: a threshold tuned with hindsight would report
 * an error no caller could ever have obtained at the time.
 */
export function fitOptimalMvt(observations: readonly MvtSetObservation[]): OptimalMvtFit | null {
  const trials = anchoredTrials(observations);
  const observed = observedV1rm(observations);
  if (trials.length < MIN_ANCHORED_SESSIONS || observed === null) return null;

  let best: { mvt: number; errorPct: number } | null = null;
  for (const candidate of candidateThresholds()) {
    const errorPct = meanAbsoluteErrorPct(trials, candidate);
    if (errorPct === null) continue;
    if (best === null || improves(errorPct, candidate, best)) best = { mvt: candidate, errorPct };
  }
  if (best === null) return null;
  return {
    mvt: best.mvt,
    errorPct: round2(best.errorPct),
    sampleSize: trials.length,
    observedV1rm: round3(observed),
  };
}

/**
 * Mean absolute 1RM prediction error at one threshold, percent — the quantity
 * {@link fitOptimalMvt} minimises, exposed so a caller can score the threshold
 * it would otherwise have used against the fitted one. `null` when the history
 * supports no anchored trial.
 */
export function mvtErrorPct(
  observations: readonly MvtSetObservation[],
  mvt: number,
): number | null {
  const error = meanAbsoluteErrorPct(anchoredTrials(observations), mvt);
  return error === null ? null : round2(error);
}

/**
 * Strictly lower error wins; an exact tie goes to the threshold nearer the
 * general default, which is the runner-up in Fitas' own comparison (4.9 %) and
 * so the least-surprising place to land when the data cannot choose.
 */
function improves(
  errorPct: number,
  candidate: number,
  best: { mvt: number; errorPct: number },
): boolean {
  if (errorPct < best.errorPct) return true;
  if (errorPct > best.errorPct) return false;
  return Math.abs(candidate - DEFAULT_MVT) < Math.abs(best.mvt - DEFAULT_MVT);
}

function candidateThresholds(): number[] {
  const { minMps, maxMps, stepMps } = MVT_FIT_BOUNDS;
  const steps = Math.round((maxMps - minMps) / stepMps);
  return Array.from({ length: steps + 1 }, (_, i) => round3(minMps + i * stepMps));
}

/**
 * `null` rather than `Infinity` when no trial scores: a threshold that predicts
 * a non-positive 1RM has left the region the linear profile describes, and
 * averaging it in as a big number would let a nonsense candidate compete.
 */
function meanAbsoluteErrorPct(trials: readonly AnchoredTrial[], mvt: number): number | null {
  if (trials.length === 0) return null;
  let total = 0;
  for (const trial of trials) {
    const predicted = (mvt - trial.intercept) / trial.slope;
    if (!(predicted > 0)) return null;
    total += (Math.abs(predicted - trial.referenceE1rm) / trial.referenceE1rm) * 100;
  }
  return total / trials.length;
}

/** One trial per anchored session, in the order the sessions happened. */
function anchoredTrials(observations: readonly MvtSetObservation[]): AnchoredTrial[] {
  const trials: AnchoredTrial[] = [];
  const window: LoadVelocityDataPoint[] = [];
  for (const session of sessionsInOrder(observations)) {
    for (const obs of session) {
      window.push({ load: obs.loadLbs, velocity: obs.bestRepVelocityMps });
    }
    const referenceE1rm = sessionReferenceE1rm(session);
    if (referenceE1rm === null || distinctLoads(window) < 2) continue;
    const { slope, intercept } = buildProfile([...window]);
    if (!(slope < 0)) continue;
    trials.push({ referenceE1rm, slope, intercept });
  }
  return trials;
}

/** Usable observations grouped by session, sessions ordered by their start. */
function sessionsInOrder(observations: readonly MvtSetObservation[]): MvtSetObservation[][] {
  const bySession = new Map<string, MvtSetObservation[]>();
  for (const obs of observations) {
    if (!(obs.loadLbs > 0) || !(obs.bestRepVelocityMps > 0)) continue;
    const group = bySession.get(obs.sessionId);
    if (group === undefined) bySession.set(obs.sessionId, [obs]);
    else group.push(obs);
  }
  return [...bySession.values()].sort((a, b) => startOf(a).localeCompare(startOf(b)));
}

function startOf(session: readonly MvtSetObservation[]): string {
  return session.map((o) => o.startedAt).sort()[0] ?? '';
}

function distinctLoads(points: readonly LoadVelocityDataPoint[]): number {
  return new Set(points.map((p) => p.load)).size;
}

/**
 * The strongest 1RM evidence one session produced, or `null` if it produced
 * none. A single rep taken to failure IS the 1RM and is used as-is; a
 * multi-rep failure goes through the same Epley estimate the `reps` shape of
 * `strength.e1rm` uses, so the reference and the tool agree on what a set to
 * failure implies.
 */
function sessionReferenceE1rm(session: readonly MvtSetObservation[]): number | null {
  const references = session
    .filter((obs) => obs.failure && obs.repCount > 0)
    .map((obs) =>
      obs.repCount === 1 ? obs.loadLbs : estimateE1RMFromReps(obs.loadLbs, obs.repCount).e1RM,
    )
    .filter((value) => value > 0);
  return references.length === 0 ? null : Math.max(...references);
}

/**
 * The velocity on the heaviest set taken to failure — the individually
 * observed V1RM, which is the threshold a lifter-specific MVT would otherwise
 * be set to. Ties on load go to the slower rep, the more maximal of the two.
 */
function observedV1rm(observations: readonly MvtSetObservation[]): number | null {
  const anchored = observations.filter(
    (obs) => obs.failure && obs.loadLbs > 0 && obs.bestRepVelocityMps > 0,
  );
  if (anchored.length === 0) return null;
  const heaviest = anchored.reduce((a, b) =>
    b.loadLbs > a.loadLbs ||
    (b.loadLbs === a.loadLbs && b.bestRepVelocityMps < a.bestRepVelocityMps)
      ? b
      : a,
  );
  return heaviest.bestRepVelocityMps;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
