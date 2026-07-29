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
  /**
   * Load for the set. Absent as of schema v6 when no header weight was
   * recorded — previously a `0` sentinel that every load-based derivation
   * read as a real unloaded set.
   */
  weightLbs?: number;
  reps: readonly Rep[];
}

/** One past session of the exercise: when it happened + its stored sets. */
export interface HistorySession {
  /** ISO timestamp of the session. */
  startedAt: string;
  /**
   * The session's sets OF THIS EXERCISE — already narrowed by the caller, the
   * only side that knows which exercise the request was about. Every derivation
   * below (best e1RM, the Kalman corridor, PR detection) reduces this list as
   * though it were a single movement, so a foreign set in here is a PR credited
   * to the wrong lift.
   */
  sets: readonly HistorySet[];
}

// ── exercise selection (which exercise the panels are about) ─────────────────

/**
 * Identity of the exercise a history request is about. Sessions are labelled
 * inconsistently in practice — early ones carry only a free-text
 * `exerciseName`, later ones only a catalog `exerciseId` — so an exercise is
 * identified by *either* handle and matched on whichever the session has.
 */
export interface HistoryExerciseRef {
  /** Catalog id, when the sessions carry one. */
  exerciseId?: string | undefined;
  /** Display label: the catalog name, else the session's free-text exercise name. */
  label?: string | undefined;
}

/** A scanned session reduced to what exercise selection needs. */
export interface HistoryCandidate extends HistoryExerciseRef {
  /** True when the session has at least one set with at least one rep. */
  hasData: boolean;
}

/**
 * Label comparison key. Case- and punctuation-insensitive so the slug id
 * `cable-chest-press` and the typed name `Cable Chest Press` — the same
 * exercise, recorded either way across the history — collapse to one series.
 */
export function normalizeExerciseLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Every comparison key a ref answers to — its id and its label, normalized. */
function exerciseHandles(ref: HistoryExerciseRef): string[] {
  const keys: string[] = [];
  for (const handle of [ref.exerciseId, ref.label]) {
    if (handle === undefined) continue;
    const key = normalizeExerciseLabel(handle);
    if (key !== '' && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * True when a session belongs to the requested exercise. Either handle on
 * either side is enough: a request for the id `cable-chest-press` picks up the
 * older sessions typed as "Cable Chest Press" and vice versa.
 */
export function matchesExercise(session: HistoryExerciseRef, want: HistoryExerciseRef): boolean {
  const wanted = exerciseHandles(want);
  return exerciseHandles(session).some((key) => wanted.includes(key));
}

/**
 * The exercise the history panels default to: the most recent one that has
 * scorable data. Deliberately NOT the active session's exercise — the
 * dashboard is usually opened with nothing running, and keying on the active
 * session made every history panel render blank (VMCP-05.06).
 *
 * `candidates` MUST be in reverse-chronological (descending) order.
 */
export function selectDefaultExercise(
  candidates: readonly HistoryCandidate[],
): HistoryExerciseRef | undefined {
  for (const c of candidates) {
    if (!c.hasData) continue;
    if (c.exerciseId === undefined && c.label === undefined) continue;
    return { exerciseId: c.exerciseId, label: c.label };
  }
  return undefined;
}

/**
 * Fill in a partially-specified ref (e.g. `?exerciseId=` with no name) from the
 * scanned sessions, so an id-only request still matches this exercise's
 * name-only sessions and the response can report a display label.
 */
export function canonicalizeExerciseRef(
  want: HistoryExerciseRef,
  candidates: readonly HistoryCandidate[],
): HistoryExerciseRef {
  const ref: HistoryExerciseRef = { ...want };
  for (const c of candidates) {
    if (!matchesExercise(c, ref)) continue;
    ref.exerciseId ??= c.exerciseId;
    ref.label ??= c.label;
    if (ref.exerciseId !== undefined && ref.label !== undefined) break;
  }
  return ref;
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
 * it tightens as confidence grows. See `sources/architecture/
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
 * Peak concentric velocity, tolerant of a stored rep that never got a
 * concentric phase. WA's accessor dereferences `rep.concentric` unguarded, so
 * one malformed row would otherwise throw and blank the whole PR panel.
 */
function safePeakVelocity(rep: Rep): number | undefined {
  if ((rep as Partial<Rep>).concentric === undefined) return undefined;
  return getRepPeakVelocity(rep);
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
      // Both records are load-based, so a set with no recorded weight sets
      // neither. It still counts toward the rep record below, which needs no
      // load. (Pre-v6 these rows carried a 0 and lost both comparisons anyway.)
      if (set.weightLbs !== undefined) {
        const e1 = estimateE1RMFromReps(set.weightLbs, reps).e1RM;
        if (Number.isFinite(e1) && e1 > best.e1rm) {
          best.e1rm = e1;
          dates.e1rm = session.startedAt;
        }
        if (set.weightLbs > best.weight) {
          best.weight = set.weightLbs;
          dates.weight = session.startedAt;
        }
      }
      if (reps > best.reps) {
        best.reps = reps;
        dates.reps = session.startedAt;
      }
      for (const rep of set.reps) {
        const pv = safePeakVelocity(rep);
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
