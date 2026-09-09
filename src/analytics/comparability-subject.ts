// Writers for the B16 v2 `ComparabilitySubject` fields (VW-211): until now
// `setIndexInExercise`, `exerciseIntroducedAt`, `trackedTrainingMonths` and
// `corroboratingExerciseCount` had no writer, so every clause that reads them
// (comparability.ts's (b)/(d)/(f) claim clauses and the (e) swap clause)
// degraded on every pair. The four `derive*` functions below are pure maps
// over already-fetched rows; `buildComparabilitySubjectGroups` is the one
// impure piece, and it stays a plain function of its arguments by taking its
// store reads as injected async functions rather than importing `ServerState`
// or `SessionStore`.
//
// VW-150 adds a fifth, `phase`, on the same terms: `diet_phases` had DDL and a
// comparability clause but no writer, so the phase clause was unchecked on
// every pair. It is resolved PER SESSION rather than per set — a diet phase is
// a property of the day, not of one bout — and memoized by session id.
//
// "Claim window" — the scope B16 (d)'s corroboration count applies over — is
// left UNBOUNDED. No clause in comparability.ts names a window length (the
// corroboration THRESHOLD, `CORROBORATING_EXERCISES`, is not a duration), and
// VW-211 forbids inventing one, so corroboration is counted across the
// lifter's entire stored history rather than a made-up recent slice.

import type { ComparabilitySubject } from './comparability.js';
import type { StoredSet } from '../store/types.js';

/** A `StoredSet` plus the five fields this file writes onto it. */
export type ComparabilityEnrichedSet = StoredSet &
  Pick<
    ComparabilitySubject,
    | 'setIndexInExercise'
    | 'exerciseIntroducedAt'
    | 'trackedTrainingMonths'
    | 'corroboratingExerciseCount'
    | 'phase'
  >;

/** B16 (b): 1-based position of `target` among its exercise's sets in this session. */
export function deriveSetIndexInExercise(
  target: StoredSet,
  sameExerciseSetsInSession: readonly StoredSet[],
): number | undefined {
  if (target.exerciseId === undefined) return undefined;
  const ordered = [...sameExerciseSetsInSession].sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt),
  );
  const index = ordered.findIndex((s) => s.id === target.id);
  return index === -1 ? undefined : index + 1;
}

/** B16 (e): `startedAt` of the lifter's first stored set of `exerciseId`. */
export function deriveExerciseIntroducedAt(
  exerciseId: string | undefined,
  allSetsForExercise: readonly StoredSet[],
): string | undefined {
  if (exerciseId === undefined || allSetsForExercise.length === 0) return undefined;
  // Reduce rather than trust arrival order, so a caller that hands in an
  // unsorted list still gets the true earliest `startedAt`.
  return allSetsForExercise.reduce(
    (earliest, s) => (s.startedAt < earliest ? s.startedAt : earliest),
    allSetsForExercise[0]!.startedAt,
  );
}

const MS_PER_MONTH = (365.25 / 12) * 24 * 60 * 60 * 1000;

/** B16 (f): months between the lifter's first stored session and this set. */
export function deriveTrackedTrainingMonths(
  setStartedAt: string,
  firstSessionStartedAt: string | null | undefined,
): number | undefined {
  if (firstSessionStartedAt === null || firstSessionStartedAt === undefined) return undefined;
  const spanMs = new Date(setStartedAt).getTime() - new Date(firstSessionStartedAt).getTime();
  if (!Number.isFinite(spanMs) || spanMs < 0) return undefined;
  return Math.floor(spanMs / MS_PER_MONTH);
}

/**
 * B16 (d): distinct exercises sharing `targetExerciseId`'s primary muscle
 * across `lifterSessionExerciseIds`, counting `targetExerciseId` itself.
 */
export function deriveCorroboratingExerciseCount(
  targetExerciseId: string | undefined,
  lifterSessionExerciseIds: readonly (string | undefined)[],
  primaryMuscleOf: (exerciseId: string) => string | undefined,
): number | undefined {
  if (targetExerciseId === undefined) return undefined;
  const targetMuscle = primaryMuscleOf(targetExerciseId);
  if (targetMuscle === undefined) return undefined;
  const distinct = new Set<string>([targetExerciseId]);
  for (const exerciseId of lifterSessionExerciseIds) {
    if (exerciseId !== undefined && primaryMuscleOf(exerciseId) === targetMuscle) {
      distinct.add(exerciseId);
    }
  }
  return distinct.size;
}

/** Pre-fetched rows the four `derive*` functions need for one (exercise, lifter) pair. */
interface ComparabilitySubjectContext {
  allSetsForExercise: readonly StoredSet[];
  firstSessionStartedAt: string | null;
  lifterSessionExerciseIds: readonly (string | undefined)[];
  primaryMuscleOf: (exerciseId: string) => string | undefined;
}

function toComparabilityEnrichedSet(
  set: StoredSet,
  sameExerciseSetsInSession: readonly StoredSet[],
  ctx: ComparabilitySubjectContext,
  phase: string | undefined,
): ComparabilityEnrichedSet {
  return {
    ...set,
    phase,
    setIndexInExercise: deriveSetIndexInExercise(set, sameExerciseSetsInSession),
    exerciseIntroducedAt: deriveExerciseIntroducedAt(set.exerciseId, ctx.allSetsForExercise),
    trackedTrainingMonths: deriveTrackedTrainingMonths(set.startedAt, ctx.firstSessionStartedAt),
    corroboratingExerciseCount: deriveCorroboratingExerciseCount(
      set.exerciseId,
      ctx.lifterSessionExerciseIds,
      ctx.primaryMuscleOf,
    ),
  };
}

/** The store reads a caller must supply to fetch a `ComparabilitySubjectContext`. */
export interface ComparabilitySubjectFetchers {
  /** Every stored set for one exercise/lifter, unbounded (no `from`/`to`). */
  getSetsForExercise: (
    exerciseId: string,
    lifter: string | undefined,
  ) => Promise<readonly StoredSet[]>;
  /** The lifter's earliest stored session, or `null` if they have none. */
  getFirstSessionStartedAt: (lifter: string | undefined) => Promise<string | null>;
  /** Each of the lifter's sessions' own `exerciseId`, unbounded. */
  getLifterSessionExerciseIds: (
    lifter: string | undefined,
  ) => Promise<readonly (string | undefined)[]>;
  primaryMuscleOf: (exerciseId: string) => string | undefined;
  /**
   * The OBSERVED diet phase covering one session, or `undefined` when none is
   * declared over it (VW-150). Resolving "which phase" is the store's job —
   * the table is retroactively correctable and wins over the denormalised
   * stamp, and a guest lifter's session never inherits the owner's phase.
   */
  getSessionDietPhase: (sessionId: string) => Promise<string | undefined>;
}

/**
 * Enriches every set in every group with the four v2 subject fields.
 *
 * A "group" is one exercise's sets within one session — the scope
 * `setIndexInExercise` (B16 b) is defined over, and exactly what
 * `getSetsForSession`/`getSetsForExercise` already hand the three consumers.
 * Fetches are memoized by (exerciseId, lifter) across every group in one
 * call, so a caller comparing many sessions of the same exercise
 * (`progression.get_for_exercise`) pays for the extra reads once rather than
 * once per session.
 */
export async function buildComparabilitySubjectGroups(
  groups: readonly (readonly StoredSet[])[],
  fetchers: ComparabilitySubjectFetchers,
): Promise<ComparabilityEnrichedSet[][]> {
  const cache = new Map<string, Promise<ComparabilitySubjectContext>>();
  const phaseCache = new Map<string, Promise<string | undefined>>();

  function phaseFor(sessionId: string): Promise<string | undefined> {
    const cached = phaseCache.get(sessionId);
    if (cached !== undefined) return cached;
    const built = fetchers.getSessionDietPhase(sessionId);
    phaseCache.set(sessionId, built);
    return built;
  }

  function contextFor(
    exerciseId: string | undefined,
    lifter: string | undefined,
  ): Promise<ComparabilitySubjectContext> {
    const key = JSON.stringify([exerciseId ?? null, lifter ?? null]);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const built = (async (): Promise<ComparabilitySubjectContext> => {
      const [allSetsForExercise, firstSessionStartedAt, lifterSessionExerciseIds] =
        await Promise.all([
          exerciseId === undefined
            ? Promise.resolve<readonly StoredSet[]>([])
            : fetchers.getSetsForExercise(exerciseId, lifter),
          fetchers.getFirstSessionStartedAt(lifter),
          fetchers.getLifterSessionExerciseIds(lifter),
        ]);
      return {
        allSetsForExercise,
        firstSessionStartedAt,
        lifterSessionExerciseIds,
        primaryMuscleOf: fetchers.primaryMuscleOf,
      };
    })();
    cache.set(key, built);
    return built;
  }

  const result: ComparabilityEnrichedSet[][] = [];
  for (const group of groups) {
    const enriched: ComparabilityEnrichedSet[] = [];
    for (const set of group) {
      const ctx = await contextFor(set.exerciseId, set.lifter);
      enriched.push(toComparabilityEnrichedSet(set, group, ctx, await phaseFor(set.sessionId)));
    }
    result.push(enriched);
  }
  return result;
}
