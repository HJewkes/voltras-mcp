// Exercise-history read-models: the pure per-exercise derivations behind
// `GET /api/exercise-trend`, `/api/capacity-band`, and `/api/pr-history`.
//
// All three fold the SAME already-gathered input — a chronological (ascending)
// list of a single exercise's past sessions with their stored sets — into their
// respective view shapes. `server.ts` does the store I/O (resolving the exercise,
// listing sessions, loading each session's sets) and hands the plain
// `HistorySession[]` here; these functions decide the output. Keeping them pure
// makes the e1RM / Kalman / PR math unit-testable without an HTTP server or store.
//
// Confidentiality boundary (NF-07): every value here is derived fitness metadata
// estimated 1RMs, velocities). No protocol bytes, frames, or command codes cross
// this seam — the caller only ever passes already-typed stored reps.

import {
  estimateE1RMFromReps,
  getRepPeakVelocity,
  StateSpaceStrengthModel,
  type Rep,
} from '@voltras/workout-analytics';

/** One stored set the history derivations read: its load and its reps. */
export interface HistorySet {
  weightLbs: number;
  reps: readonly Rep[];
}

/** One past session of the exercise: when it happened + its stored sets. */
export interface HistorySession {
  /** ISO timestamp of the session. */
  startedAt: string;
  sets: readonly HistorySet[];
}

// ── e1RM series (shared by trend + capacity band) ────────────────────────────

/** One past session's best (exact, unrounded) e1RM observation, chronological. */
export interface ExerciseE1rmObservation {
  /** ISO timestamp of the session. */
  date: string;
  /** Best exact estimated 1RM (lbs) across the session's sets of this exercise. */
  e1rm: number;
}

/**
 * The chronological per-session best-e1RM series — the shared observation stream
 * behind both the strength trend and the capacity band. For each session, the best
 * `estimateE1RMFromReps(weight, repCount)` across its sets is one observation
 * (sessions with no scorable set are skipped). Exact/unrounded — callers round for
 * their own display. Input MUST be in chronological (ascending) order.
 */
export function buildE1rmSeries(sessions: readonly HistorySession[]): ExerciseE1rmObservation[] {
  const series: ExerciseE1rmObservation[] = [];
  for (const session of sessions) {
    let best = 0;
    for (const set of session.sets) {
      if (set.reps.length < 1) continue;
      const est = estimateE1RMFromReps(set.weightLbs, set.reps.length).e1RM;
      if (Number.isFinite(est) && est > best) best = est;
    }
    if (best <= 0) continue;
    series.push({ date: session.startedAt, e1rm: best });
  }
  return series;
}

// ── strength trend ───────────────────────────────────────────────────────────

/** One point on the per-exercise estimated-1RM trend (titan StrengthTrendChart shape). */
export interface ExerciseTrendPoint {
  /** ISO timestamp of the session. */
  date: string;
  /** Best estimated 1RM (lbs) across that session's sets of this exercise. */
  e1rm: number;
  /** True when this session set a new all-time e1RM in the returned window. */
  isPR: boolean;
}

/**
 * Per-exercise estimated-1RM trend: the e1RM series rounded for display, with a
 * running max flagging PR sessions.
 */
export function buildExerciseTrend(
  series: readonly ExerciseE1rmObservation[],
): ExerciseTrendPoint[] {
  const points: ExerciseTrendPoint[] = [];
  let runningMax = Number.NEGATIVE_INFINITY;
  for (const obs of series) {
    const e1rm = Math.round(obs.e1rm);
    const isPR = e1rm > runningMax;
    if (isPR) runningMax = e1rm;
    points.push({ date: obs.date, e1rm, isPR });
  }
  return points;
}

// ── capacity band (Kalman) ─────────────────────────────────────────────────────

/** k for the ±k·σ capacity corridor around the Kalman strength estimate (1σ). */
export const CAPACITY_BAND_K_SIGMA = 1;
/**
 * Minimum history for an informative band. With 1–2 sessions the state-space
 * filter has barely departed its seed prior, so the "band" is just the arbitrary
 * seed half-width — return none and let the panel hide rather than show noise.
 */
export const MIN_CAPACITY_BAND_SESSIONS = 3;

/**
 * One dated point on the capacity band: WA's smoothed strength estimate, its
 * ±k·σ corridor bounds, and the observed session e1RM that produced it. Exact
 * values — the SPA mapper does titan's rounding/formatting.
 */
export interface CapacityBandPoint {
  /** ISO timestamp of the session. */
  date: string;
  /** Smoothed latent-strength estimate (lbs) after assimilating this session. */
  estimate: number;
  /** Lower corridor bound: `estimate − k·√variance`. */
  bandLow: number;
  /** Upper corridor bound: `estimate + k·√variance`. */
  bandHigh: number;
  /** The session's observed best e1RM (lbs) — the plotted dot's load. */
  e1rm: number;
}

/**
 * Capacity band = WA `StateSpaceStrengthModel` (a local-linear-trend Kalman
 * filter) folded over the exercise's per-session e1RM series. Each observation
 * yields `{ estimate, variance }`; the corridor is `estimate ± k·√variance`, so
 * it tightens as confidence grows. See `coordination/architecture/
 * capacity-band-model-2026-07-04.md`. Returns none below the minimum-session gate.
 */
export function buildCapacityBand(series: readonly ExerciseE1rmObservation[]): CapacityBandPoint[] {
  if (series.length < MIN_CAPACITY_BAND_SESSIONS) return [];
  const model = new StateSpaceStrengthModel();
  return series.map((obs) => {
    const { estimate, variance } = model.update(obs.e1rm);
    const sd = Math.sqrt(variance);
    return {
      date: obs.date,
      estimate,
      bandLow: estimate - CAPACITY_BAND_K_SIGMA * sd,
      bandHigh: estimate + CAPACITY_BAND_K_SIGMA * sd,
      e1rm: obs.e1rm,
    };
  });
}

// ── PR history ─────────────────────────────────────────────────────────────────

const PR_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** ISO timestamp → "MMM D" display date (UTC, deterministic). Falls back to raw. */
export function fmtPrDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${PR_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** One PR record for titan PrHistoryModal. */
export interface PrRecordView {
  type: 'e1rm' | 'weight' | 'reps' | 'velocity';
  value: number;
  unit?: 'lbs';
  date: string;
}

/**
 * All-time PR records for an exercise from stored history: best estimated 1RM, top
 * set weight, most reps in a set, and fastest rep — each with the date it was set.
 * Records for a category are omitted when nothing scored in it.
 */
export function buildPrHistory(sessions: readonly HistorySession[]): PrRecordView[] {
  const best = { e1rm: 0, weight: 0, reps: 0, velMms: 0 };
  const dates = { e1rm: '', weight: '', reps: '', velMms: '' };
  for (const session of sessions) {
    for (const set of session.sets) {
      const reps = set.reps.length;
      if (reps < 1) continue;
      const e1 = estimateE1RMFromReps(set.weightLbs, reps).e1RM;
      if (Number.isFinite(e1) && e1 > best.e1rm) {
        best.e1rm = e1;
        dates.e1rm = session.startedAt;
      }
      if (set.weightLbs > best.weight) {
        best.weight = set.weightLbs;
        dates.weight = session.startedAt;
      }
      if (reps > best.reps) {
        best.reps = reps;
        dates.reps = session.startedAt;
      }
      for (const rep of set.reps) {
        const pv = getRepPeakVelocity(rep);
        if (typeof pv === 'number' && Number.isFinite(pv) && pv > best.velMms) {
          best.velMms = pv;
          dates.velMms = session.startedAt;
        }
      }
    }
  }

  const records: PrRecordView[] = [];
  if (best.e1rm > 0)
    records.push({
      type: 'e1rm',
      value: Math.round(best.e1rm),
      unit: 'lbs',
      date: fmtPrDate(dates.e1rm),
    });
  if (best.weight > 0)
    records.push({
      type: 'weight',
      value: Math.round(best.weight),
      unit: 'lbs',
      date: fmtPrDate(dates.weight),
    });
  if (best.reps > 0) records.push({ type: 'reps', value: best.reps, date: fmtPrDate(dates.reps) });
  if (best.velMms > 0)
    records.push({
      type: 'velocity',
      value: Number((best.velMms / 1000).toFixed(2)),
      date: fmtPrDate(dates.velMms),
    });
  return records;
}
