// Gathers the inputs `read-models/muscle-strength.ts` projects (VW-330, B3).
//
// The adapter half of the per-muscle strength read: it does the store reads and
// runs `history.trend`(metric `e1rm`) once per (exercise, side), then hands
// plain rows to the pure projector. No maths lives here — `computeHistoryTrend`
// is the same function `metrics.compute history.trend` runs, so the body-map
// page and the MCP tool can never report different slopes.
//
// Which sets count and which muscle they count toward are NOT decided here:
// both come from `read-models/muscle-set-scope.ts`, the one copy `muscle-plan`
// and `muscle-week` also read. Three panels of one figure that disagree about
// what a working set is would contradict each other on screen.
//
// PER SIDE, NEVER POOLED. A fit is requested with the side it belongs to, so a
// bilateral exercise gets two fits over two disjoint set groups. The one case
// with no honest fit is an exercise carrying BOTH sided and side-unknown sets:
// the store can filter to a side but not to "side is absent", so the
// side-unknown group is left without a fit rather than handed a pooled one.
//
// Confidentiality: loads, reps, muscle names — derived fitness metadata only
// (NF-07).

import {
  buildMuscleStrengthView,
  type MuscleStrengthExerciseInput,
  type MuscleStrengthSetRow,
  type MuscleStrengthSideKey,
  type MuscleStrengthTrend,
  type MuscleStrengthView,
} from './read-models/muscle-strength.js';
import {
  isEligibleWorkingSet,
  titanMusclesFor,
  type MuscleCatalogLookup,
} from './read-models/muscle-set-scope.js';
import { computeHistoryTrend } from '../tools/metrics-tools.js';
import { log } from '../logger.js';
import {
  LOCAL_USER_ID,
  type ExerciseSetsFilter,
  type SessionStore,
  type StoredSession,
  type StoredSet,
  type StoredSide,
  type StoredTrainingProfile,
} from '../store/types.js';

/** The lookback the body-map page reads, matching `history.trend`'s own default. */
export const MUSCLE_STRENGTH_WEEKS = 12;

/** Generous cap on sessions fetched for the window. @see MUSCLE_WEEK_SESSION_LIMIT */
const MUSCLE_STRENGTH_SESSION_LIMIT = 500;

/** The store slice this route needs — the trend read's own, plus the session scan. */
export interface MuscleStrengthStore {
  listSessions(filter: {
    sort: 'startedAt:desc' | 'startedAt:asc';
    limit: number;
    offset: number;
    from?: string;
    to?: string;
  }): Promise<StoredSession[]>;
  getSetsForSession(sessionId: string): Promise<StoredSet[]>;
  getSetsForExercise(filter: ExerciseSetsFilter): Promise<StoredSet[]>;
  getDietPhaseCovering: SessionStore['getDietPhaseCovering'];
  chapterStartedAt: SessionStore['chapterStartedAt'];
  getTrainingProfile(userId: string): Promise<StoredTrainingProfile | undefined>;
}

/** Everything outside the store the assembly reads. */
export interface MuscleStrengthContext {
  store: MuscleStrengthStore;
  catalog: MuscleCatalogLookup;
  now: Date;
  weeks?: number;
}

/** One exercise's eligible sets in the window, before the per-side split. */
interface ExerciseWindow {
  exerciseId: string;
  sets: MuscleStrengthSetRow[];
}

function toSetRow(set: StoredSet): MuscleStrengthSetRow {
  return {
    sessionId: set.sessionId,
    startedAt: set.startedAt,
    side: set.side ?? null,
    weightLbs: Number.isFinite(set.weightLbs) ? (set.weightLbs as number) : null,
    repCount: set.firmwareRepCount ?? set.reps.length,
  };
}

/** Every set the store holds for the window, one session read at a time. */
async function setsInWindow(
  store: MuscleStrengthStore,
  fromIso: string,
  toIso: string,
): Promise<StoredSet[]> {
  const sessions = await store.listSessions({
    sort: 'startedAt:asc',
    limit: MUSCLE_STRENGTH_SESSION_LIMIT,
    offset: 0,
    from: fromIso,
    to: toIso,
  });
  const sets: StoredSet[] = [];
  for (const session of sessions) {
    sets.push(...(await store.getSetsForSession(session.id)));
  }
  return sets;
}

/**
 * Eligible sets grouped by the exercise each set NAMES. A set with no exercise
 * recorded joins no group: it cannot be attributed to a muscle, and guessing
 * from the session would credit a strength trend to the wrong lift.
 */
function groupByExercise(
  sets: readonly StoredSet[],
  fromIso: string,
  toIso: string,
): ExerciseWindow[] {
  const groups = new Map<string, MuscleStrengthSetRow[]>();
  for (const set of sets) {
    if (set.exerciseId === undefined) continue;
    if (!isEligibleWorkingSet(set, fromIso, toIso)) continue;
    const group = groups.get(set.exerciseId);
    if (group === undefined) groups.set(set.exerciseId, [toSetRow(set)]);
    else group.push(toSetRow(set));
  }
  return [...groups.entries()].map(([exerciseId, rows]) => ({ exerciseId, sets: rows }));
}

/** Which side groups these sets fall into; `'none'` holds the side-unknown rows. */
function sideKeysOf(sets: readonly MuscleStrengthSetRow[]): MuscleStrengthSideKey[] {
  return [...new Set(sets.map((set) => set.side ?? 'none'))];
}

/**
 * One side's fit, or `undefined` when the window holds nothing to fit.
 * `computeHistoryTrend` throws `NOT_FOUND` for an empty window, which on this
 * page is an ordinary state (an exercise trained on one side only), not a
 * request error.
 *
 * VW-361: a declared chapter with nothing recorded since it returns a
 * `null` fit instead of throwing, and lands in the same "no fit" state. The
 * page shows no slope either way; what it must never do is draw one across
 * the boundary.
 */
async function fitForSide(
  store: MuscleStrengthStore,
  exerciseId: string,
  weeks: number,
  side?: StoredSide,
): Promise<MuscleStrengthTrend | undefined> {
  try {
    const result = await computeHistoryTrend(
      { store },
      { exerciseId, metric: 'e1rm', weeks },
      side,
    );
    // The fit's four load-bearing numbers, named explicitly: `TrendAnalysis`
    // degrades through the analytics package's .d.ts under NodeNext resolution
    // (the same note `metrics-tools.ts` carries), so spreading it would widen
    // this wire shape to an index signature.
    if (result.trend === null || result.plateau === null) return undefined;
    const { slope, intercept, rSquared, pointCount } = result.trend;
    return {
      trend: { slope, intercept, rSquared, pointCount },
      plateau: { verdict: result.plateau.verdict },
    };
  } catch (err) {
    log.debug(`muscle-strength: no e1rm fit for '${exerciseId}' (${side ?? 'unsided'})`, err);
    return undefined;
  }
}

/**
 * A fit per side group. The side-unknown group gets one only when the exercise
 * has no sided sets at all — see this module's header on why a mixed exercise
 * is left without one rather than given a pooled fit.
 */
async function fitsForExercise(
  store: MuscleStrengthStore,
  exerciseId: string,
  weeks: number,
  sets: readonly MuscleStrengthSetRow[],
): Promise<Partial<Record<MuscleStrengthSideKey, MuscleStrengthTrend>>> {
  const keys = sideKeysOf(sets);
  const fits: Partial<Record<MuscleStrengthSideKey, MuscleStrengthTrend>> = {};
  for (const key of keys) {
    if (key === 'none' && keys.length > 1) continue;
    const fit = await fitForSide(store, exerciseId, weeks, key === 'none' ? undefined : key);
    if (fit !== undefined) fits[key] = fit;
  }
  return fits;
}

/** One trained exercise's muscles, sets and fits, or `undefined` when unmapped. */
async function collectExercise(
  ctx: MuscleStrengthContext,
  window: ExerciseWindow,
  weeks: number,
): Promise<MuscleStrengthExerciseInput | undefined> {
  const primaryMuscles = titanMusclesFor(window.exerciseId, ctx.catalog);
  if (primaryMuscles.length === 0) return undefined;
  return {
    exerciseId: window.exerciseId,
    name: ctx.catalog(window.exerciseId)?.name ?? window.exerciseId,
    primaryMuscles,
    sets: window.sets,
    trendBySide: await fitsForExercise(ctx.store, window.exerciseId, weeks, window.sets),
  };
}

/**
 * `GET /api/muscle-strength`'s payload: every exercise the owner actually
 * trained in the window, projected onto all 15 titan muscle slugs.
 */
export async function fetchMuscleStrength(ctx: MuscleStrengthContext): Promise<MuscleStrengthView> {
  const weeks = ctx.weeks ?? MUSCLE_STRENGTH_WEEKS;
  const fromIso = new Date(ctx.now.getTime() - weeks * 7 * 24 * 60 * 60 * 1000).toISOString();
  // One day of slack past `now`, so a set recorded this instant is inside the
  // helper's exclusive upper bound rather than a millisecond outside it.
  const toIso = new Date(ctx.now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const windows = groupByExercise(await setsInWindow(ctx.store, fromIso, toIso), fromIso, toIso);
  const exercises: MuscleStrengthExerciseInput[] = [];
  for (const window of windows) {
    const collected = await collectExercise(ctx, window, weeks);
    if (collected !== undefined) exercises.push(collected);
  }
  const profile = await ctx.store.getTrainingProfile(LOCAL_USER_ID);
  return buildMuscleStrengthView({ exercises, yearsTraining: profile?.yearsTraining ?? null });
}
