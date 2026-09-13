// Prescriptive load-drift flag (VW-300).
//
// Jimenez-Reyes et al. 2021 (PeerJ, DOI 10.7717/peerj.10942) tracked a fixed-absolute-load
// group programmed at 80% 1RM: with no velocity check in the loop, the
// lifters' true 1RM moved over 8 weeks and the SAME absolute load quietly
// became ~64% 1RM (session velocity drifted to 0.88-0.91 m/s against a
// 0.67-0.68 m/s target for that %). Nothing in a set count or a tonnage
// figure catches this — the number on the plan never changed. A
// load-velocity profile does: the velocity a fixed load produces TODAY is
// compared against what that same load was worth, in %1RM, when it was
// programmed.
//
// This is a sibling of `store/drift-guard.ts`, not a fork of it. That module
// judges whether two sessions are comparable at all (ROM/tempo shape); this
// one judges whether a fixed absolute load is still the %1RM it was
// prescribed as. Different question, same posture: a diagnostic read that
// never gates a decision on its own.

import {
  buildProfile,
  estimateE1RMFromProfile,
  estimateLoad,
  getSetMeanVelocity,
  type LoadVelocityDataPoint,
  type LoadVelocityProfile,
  type Set as AnalyticsSet,
  type BaselineKey,
} from '@voltras/workout-analytics';

import { resolveMvt, type FittedMvtRecord } from './optimal-mvt.js';
import {
  LOCAL_USER_ID,
  type ExerciseSetsFilter,
  type StoredExerciseBaseline,
  type StoredSet,
} from '../store/types.js';
import { normaliseVelocityToMps } from '../store/velocity-units.js';

/** The flag `evaluateLoadDrift` returns, or `null` when drift isn't material. */
export interface LoadDriftFlag {
  /** %1RM the prescribed load was programmed as, against the lifter's own profile. */
  programmedPct: number;
  /** %1RM the measured velocity at that same load implies, against the same profile. */
  impliedPct: number;
  /** `impliedPct - programmedPct`. Negative means the load quietly got easier. */
  deltaPct: number;
  reason: string;
}

/**
 * Minimum drift, in percentage points of 1RM, before this flags at all.
 *
 * Jimenez-Reyes 2021's fixed-load group drifted 80% -> ~64%, a 16-point gap,
 * over 8 weeks with no velocity check in place. 10 points sits meaningfully
 * below that failure case while staying clear of the noise a single set's
 * mean velocity carries against a linear profile fit on a handful of points.
 */
export const LOAD_DRIFT_THRESHOLD_PP = 10;

/**
 * Compare a prescribed absolute load against the lifter's own load-velocity
 * profile: what %1RM was this load PROGRAMMED as (`prescribedLoadLbs` /
 * profile e1RM), and what %1RM does the MEASURED velocity at that load imply
 * today (the load the profile says that velocity belongs to / the same
 * e1RM). `null` when the profile can't anchor an e1RM (a flat or invalid
 * regression) or the drift sits under {@link LOAD_DRIFT_THRESHOLD_PP}.
 */
export function evaluateLoadDrift(args: {
  profile: LoadVelocityProfile;
  mvt: number;
  prescribedLoadLbs: number;
  measuredVelocityMps: number;
}): LoadDriftFlag | null {
  const { profile, mvt, prescribedLoadLbs, measuredVelocityMps } = args;
  if (!(profile.slope < 0) || !(prescribedLoadLbs > 0)) return null;

  const e1RM = estimateE1RMFromProfile(profile, mvt).e1RM;
  if (!(e1RM > 0)) return null;

  const programmedPct = (prescribedLoadLbs / e1RM) * 100;
  const impliedLoad = estimateLoad(profile, measuredVelocityMps);
  const impliedPct = (impliedLoad / e1RM) * 100;
  const deltaPct = impliedPct - programmedPct;
  if (Math.abs(deltaPct) < LOAD_DRIFT_THRESHOLD_PP) return null;

  const direction = deltaPct < 0 ? 'below' : 'above';
  return {
    programmedPct: round1(programmedPct),
    impliedPct: round1(impliedPct),
    deltaPct: round1(deltaPct),
    reason:
      `Measured velocity at the prescribed load implies ${round1(impliedPct)}% 1RM, ` +
      `${round1(Math.abs(deltaPct))} points ${direction} the ${round1(programmedPct)}% this ` +
      `load was programmed as — at or past the ${LOAD_DRIFT_THRESHOLD_PP}-point threshold ` +
      `(Jimenez-Reyes et al. 2021).`,
  };
}

/** The store slice {@link checkLoadDrift} needs to build a lifter's own load-velocity profile. */
export interface LoadDriftStore {
  getSetsForExercise(filter: ExerciseSetsFilter): Promise<StoredSet[]>;
  getBaseline(key: BaselineKey): Promise<StoredExerciseBaseline | undefined>;
}

/**
 * Whether a measured load counts as "the prescribed load" for a drift check.
 * A half-pound tolerance absorbs device/tenths rounding without treating an
 * unrelated top set as evidence about the programmed one.
 */
export function loadMatchesPrescription(
  measuredLbs: number | undefined,
  prescribedLbs: number,
): boolean {
  return measuredLbs !== undefined && Math.abs(measuredLbs - prescribedLbs) < 0.5;
}

/**
 * Build this lifter's own load-velocity profile from their prior WORKING sets
 * of `exerciseId` — `measuredSet` excluded, so the check is always "does this
 * set fit the profile everything before it drew", never "does this set fit a
 * profile that already includes it" — then run {@link evaluateLoadDrift}
 * against `measuredSet`'s own mean concentric velocity.
 *
 * `null` with fewer than two prior weighted working sets: a profile through
 * one point has nothing to be a fit AGAINST, and mirrors the same floor
 * `profileE1RM` (`tools/metrics-tools.ts`) uses for the same reason.
 */
export async function checkLoadDrift(
  store: LoadDriftStore,
  args: { exerciseId: string; prescribedLoadLbs: number; measuredSet: StoredSet },
): Promise<LoadDriftFlag | null> {
  const { exerciseId, prescribedLoadLbs, measuredSet } = args;
  const history = await store.getSetsForExercise({
    userId: LOCAL_USER_ID,
    exerciseId,
    purpose: ['working'],
  });
  const points: LoadVelocityDataPoint[] = history
    .filter((s) => s.id !== measuredSet.id && Number.isFinite(s.weightLbs))
    .map((s) => ({ load: s.weightLbs as number, velocity: getSetMeanVelocity(toAnalyticsSet(s)) }));
  if (points.length < 2) return null;

  const baseline = await store.getBaseline({ userId: LOCAL_USER_ID, exerciseId });
  const mvt = resolveMvt(baseline as FittedMvtRecord | undefined);
  const profile = buildProfile(points, mvt.mvt);
  const measuredVelocityMps = getSetMeanVelocity(toAnalyticsSet(measuredSet));

  return evaluateLoadDrift({ profile, mvt: mvt.mvt, prescribedLoadLbs, measuredVelocityMps });
}

function toAnalyticsSet(stored: StoredSet): AnalyticsSet {
  return { reps: normaliseVelocityToMps(stored).reps };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
