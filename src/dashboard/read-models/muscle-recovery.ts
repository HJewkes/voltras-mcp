// Pure read-model for the body-map plan's "per-muscle recovery state"
// affordance (VW-332, B5). `buildMuscleRecoveryView` shapes recorded sets into
// one row per titan muscle group: when the muscle was last trained, how long
// ago that was in whole days, the entry-depression read from that session, and
// whether that session matched or beat its previous comparable session. It
// performs NO I/O: the caller (`dashboard/server.ts`'s `serveMuscleRecovery`)
// owns the store reads, the same split `muscle-week.ts` uses.
//
// WHAT THIS DELIBERATELY DOES NOT COMPUTE: a per-muscle recovery window, in any
// unit, and nothing derived from one. The research behind B5 looked for a
// citable per-muscle stimulus-recovery-adaptation window and found none — the
// RP corpus offers only tier-variant training-frequency bands
// (`rp-s6-muscle-recovery-tier-frequency`), which vary by training age and say
// nothing about one athlete on one day. Rendering a projected return-to-ready
// moment would dress a number nobody measured as a measurement. What IS
// supported is the performance benchmark: a muscle is recovered when the work
// done on it matched or beat the previous comparable session
// (`rp-s2-recovery-check-performance-benchmark`). So this view reports the
// elapsed days, the entry-depression read, and that benchmark, and leaves the
// judgement to the reader. `muscle-recovery-read-model.test.ts` pins the
// absence, by reading this file back and failing on the vocabulary.
//
// WORK-DONE-ON-THE-REGION, not a claim about the muscle: `lastTrainedAt` uses
// the same target-only attribution `muscle-week.ts` does (B47), proxy rows
// (`isProxyMapping`) included — an adduction really is work done on that leg
// region, even though it is not evidence a quad grew.
//
// Confidentiality: fitness metadata only — no protocol data (NF-07).

import {
  chooseComparisonPartner,
  isComparable,
  type ComparabilitySubject,
} from '../../analytics/comparability.js';
import {
  MUSCLE_MAP_VERSION,
  TITAN_MUSCLE_GROUPS,
  type TitanMuscleGroup,
} from '../../exercises/muscle-map.js';
import type { StoredSession, StoredSet } from '../../store/types.js';
import type { FatigueAxesLookup } from './muscle-recovery-fatigue.js';
import {
  isEligibleWorkingSet,
  titanMusclesFor,
  type MuscleCatalogLookup,
} from './muscle-set-scope.js';

/** The VW-306 entry-depression axis, narrowed to what a body-map row renders. */
export interface MuscleRecoveryEntryDepression {
  /** Percent below the lifter's own prior output at the same load. Negative means above it. */
  pct: number;
  /** The axis's own coarse 0-1 confidence — for ordering and gating, not arithmetic. */
  confidence: number;
}

/**
 * Why the performance benchmark could not be evaluated. Each is a different
 * missing thing, and a surface that renders them must not collapse them: "you
 * have never trained this twice" and "you trained it at a different load" are
 * not the same answer.
 */
export type MuscleRecoveryReason =
  | 'insufficient history'
  | 'no comparable prior'
  | 'no matched-load prior';

/** One titan muscle group's recovery state. */
export interface MuscleRecoveryMuscleView {
  muscle: TitanMuscleGroup;
  /** `startedAt` of the most recent eligible working set attributed to this muscle. */
  lastTrainedAt: string | null;
  /** Whole days elapsed since {@link lastTrainedAt}; 0 for anything inside the last day. */
  daysSince: number | null;
  /** The entry-depression axis of the session {@link lastTrainedAt} belongs to. */
  lastEntryDepression: MuscleRecoveryEntryDepression | null;
  /**
   * Did that session's top-load set match or beat the previous COMPARABLE
   * session's? Null when no such comparison exists — {@link reason} says which
   * piece was missing.
   */
  lastSessionMatchedPrior: boolean | null;
  /** Non-null exactly when {@link lastSessionMatchedPrior} is null. */
  reason: MuscleRecoveryReason | null;
}

export interface MuscleRecoveryView {
  muscleMapVersion: string;
  /** Every titan slug (VW-328), untrained ones included, so the figure can paint every muscle. */
  muscles: MuscleRecoveryMuscleView[];
}

/** Everything `buildMuscleRecoveryView` needs, already read out of the store. */
export interface MuscleRecoveryRows {
  /**
   * The sessions `sets` came from. Read for `dietPhase` only: the phase is a
   * property of the day, so the comparability phase clause (B34, VW-366) needs
   * it stamped onto each set before a pair can be judged like-vs-like.
   */
  sessions: readonly StoredSession[];
  /**
   * Candidate sets. The caller may over-fetch — a trailing window wider than
   * anything rendered is expected, and is what gives the benchmark a prior
   * session to find; this function applies the authoritative
   * date/purpose/ownership/source filter.
   */
  sets: readonly StoredSet[];
  fatigueBySession: FatigueAxesLookup;
  catalog: MuscleCatalogLookup;
  /** The instant to measure elapsed days against. Sets after it are ignored. */
  now: Date;
}

/** Lower bound for the eligibility scan: earlier than any ISO timestamp a set can carry. */
const BEFORE_ANY_SET = '';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A stored set plus the session-level fields comparability judges pairs on. */
type RecoverySubject = StoredSet & Pick<ComparabilitySubject, 'phase'>;

function repCountOf(set: StoredSet): number {
  return set.firmwareRepCount ?? set.reps.length;
}

/** The benchmark quantity: load times reps (`rp-s2-recovery-check-performance-benchmark`). */
function workOf(set: StoredSet): number {
  return (set.weightLbs ?? 0) * repCountOf(set);
}

/** Heaviest set of the group, reps breaking a tie. Undefined only for an empty group. */
function topLoadSet(sets: readonly RecoverySubject[]): RecoverySubject | undefined {
  return sets.reduce<RecoverySubject | undefined>((best, set) => {
    if (best === undefined) return set;
    const byLoad = (set.weightLbs ?? 0) - (best.weightLbs ?? 0);
    if (byLoad > 0) return set;
    if (byLoad < 0) return best;
    return repCountOf(set) > repCountOf(best) ? set : best;
  }, undefined);
}

/** Eligible working sets with the session's observed diet phase stamped on (VW-150). */
function eligibleSubjects(rows: MuscleRecoveryRows): RecoverySubject[] {
  const nowIso = rows.now.toISOString();
  const phaseOf = new Map(rows.sessions.map((session) => [session.id, session.dietPhase]));
  return rows.sets
    .filter(
      (set) => set.exerciseId !== undefined && isEligibleWorkingSet(set, BEFORE_ANY_SET, nowIso),
    )
    .map((set) => {
      const phase = phaseOf.get(set.sessionId);
      return phase === undefined ? set : { ...set, phase };
    });
}

/** The latest eligible set attributed to each titan slug, by the target-only rule (B47). */
function latestByMuscle(
  subjects: readonly RecoverySubject[],
  catalog: MuscleCatalogLookup,
): Map<TitanMuscleGroup, RecoverySubject> {
  const latest = new Map<TitanMuscleGroup, RecoverySubject>();
  for (const set of subjects) {
    for (const muscle of titanMusclesFor(set.exerciseId ?? '', catalog)) {
      const held = latest.get(muscle);
      if (held === undefined || set.startedAt > held.startedAt) latest.set(muscle, set);
    }
  }
  return latest;
}

/** Blocking reasons carry no ` (note): ` marker — see `ComparabilityVerdict`. */
function blockingReasons(reasons: readonly string[]): string[] {
  return reasons.filter((reason) => !reason.includes(' (note): '));
}

/**
 * Which reason a refused comparison gets. A pair blocked ONLY by load is a
 * different situation from one blocked by a changed movement, side or device
 * setup: the load one is the common, expected case (the lifter moved the pin),
 * and it is the one the benchmark itself is about.
 */
function refusalReason(nearestReasons: readonly string[] | undefined): MuscleRecoveryReason {
  if (nearestReasons === undefined) return 'no comparable prior';
  const blockers = blockingReasons(nearestReasons);
  const loadOnly = blockers.length > 0 && blockers.every((r) => r.startsWith('load: '));
  return loadOnly ? 'no matched-load prior' : 'no comparable prior';
}

interface BenchmarkVerdict {
  matched: boolean | null;
  reason: MuscleRecoveryReason | null;
}

/**
 * Did the session `target` belongs to match or beat its previous comparable
 * session on the same exercise?
 *
 * The pairing is `comparability`'s, not a hand-rolled "same exercise" check:
 * that is what makes this like-vs-like rather than a comparison across a
 * changed side, device setup or training phase. Matched load comes free with
 * it — the load clause admits no tolerance — so the benchmark reduces to the
 * reps done at that load, which is exactly what load times reps expresses.
 */
function benchmark(
  target: RecoverySubject,
  subjects: readonly RecoverySubject[],
): BenchmarkVerdict {
  const sessionSets = subjects.filter(
    (set) => set.exerciseId === target.exerciseId && set.sessionId === target.sessionId,
  );
  const sessionStart = sessionSets.reduce(
    (min, s) => (s.startedAt < min ? s.startedAt : min),
    target.startedAt,
  );
  const priors = subjects
    .filter(
      (set) =>
        set.exerciseId === target.exerciseId &&
        set.sessionId !== target.sessionId &&
        set.startedAt < sessionStart,
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (priors.length === 0) return { matched: null, reason: 'insufficient history' };

  const top = topLoadSet(sessionSets) ?? target;
  const report = chooseComparisonPartner(top, priors);
  if (report.comparedTo === undefined) {
    return { matched: null, reason: refusalReason(report.nearest?.reasons) };
  }

  const priorSessionId = priors.find((set) => set.id === report.comparedTo?.setId)?.sessionId;
  const priorBest = priors
    .filter((set) => set.sessionId === priorSessionId && isComparable(top, set).comparable)
    .reduce((best, set) => Math.max(best, workOf(set)), 0);
  return { matched: workOf(top) >= priorBest, reason: null };
}

function daysBetween(fromIso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(fromIso).getTime()) / MS_PER_DAY));
}

/** The entry-depression axis of one session's work on one exercise, when it is measurable. */
function entryDepressionOf(
  set: RecoverySubject,
  fatigueBySession: FatigueAxesLookup,
): MuscleRecoveryEntryDepression | null {
  const axis = fatigueBySession({
    sessionId: set.sessionId,
    exerciseId: set.exerciseId ?? '',
  })?.entryDepression;
  if (axis === undefined || axis.value === null) return null;
  return { pct: axis.value, confidence: axis.confidence };
}

const UNTRAINED: Omit<MuscleRecoveryMuscleView, 'muscle'> = {
  lastTrainedAt: null,
  daysSince: null,
  lastEntryDepression: null,
  lastSessionMatchedPrior: null,
  reason: 'insufficient history',
};

/** Shape recorded sets into per-muscle recovery state (VW-332, B5). */
export function buildMuscleRecoveryView(rows: MuscleRecoveryRows): MuscleRecoveryView {
  const subjects = eligibleSubjects(rows);
  const latest = latestByMuscle(subjects, rows.catalog);

  const muscles = TITAN_MUSCLE_GROUPS.map((muscle): MuscleRecoveryMuscleView => {
    const set = latest.get(muscle);
    if (set === undefined) return { muscle, ...UNTRAINED };
    const { matched, reason } = benchmark(set, subjects);
    return {
      muscle,
      lastTrainedAt: set.startedAt,
      daysSince: daysBetween(set.startedAt, rows.now),
      lastEntryDepression: entryDepressionOf(set, rows.fatigueBySession),
      lastSessionMatchedPrior: matched,
      reason,
    };
  });

  return { muscleMapVersion: MUSCLE_MAP_VERSION, muscles };
}
