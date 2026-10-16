// Pure "last time" targets for one exercise (VW-642, slice S2 of VW-442).
//
// `deriveExerciseTargets` reads one past session's sets of one exercise, already
// scoped to the lifter, and returns the set count, rep range and load that work
// showed. It carries no RPE, rest, intent, tempo or title: last time's numbers
// say nothing about coaching intent, so none is invented. No I/O and no open
// session, so a caller can run it per exercise before any session exists.
//
// Confidentiality: fitness units only, no protocol data (NF-07).

import { classifyBreak, daysBetween } from '../../analytics/re-entry.js';
import { localDate } from '../../analytics/training-days.js';
import type { SetPurpose, StoredSide } from '../../store/types.js';
import type { ExerciseCatalogLookup, PrescriptionView } from './session-plan.js';

/** The slice of a stored set the derivation reads. */
export interface DerivableSet {
  reps: readonly unknown[];
  setPurpose?: SetPurpose;
  side?: StoredSide;
  weightLbs?: number;
}

/** Targets last time's working sets showed. `repsHigh` is present only for a real range. */
export interface DerivedTargets {
  sets: number;
  repsLow: number;
  repsHigh?: number;
  weightLbs?: number;
}

/** A working set with at least one rep: the rule the rail and the pace read already use. */
function isWorkingSet(set: DerivableSet): boolean {
  return set.reps.length > 0 && (set.setPurpose === undefined || set.setPurpose === 'working');
}

/** The largest per-side count, with side-unknown sets as their own group, so "3 per side" is not 6. */
function perSideSetCount(sets: readonly DerivableSet[]): number {
  const counts = new Map<StoredSide | undefined, number>();
  for (const set of sets) counts.set(set.side, (counts.get(set.side) ?? 0) + 1);
  return Math.max(...counts.values());
}

/** Last time's targets from its working sets, or null when it logged none. */
export function deriveExerciseTargets(sets: readonly DerivableSet[]): DerivedTargets | null {
  const working = sets.filter(isWorkingSet);
  if (working.length === 0) return null;
  const repCounts = working.map((set) => set.reps.length);
  const repsLow = Math.min(...repCounts);
  const repsHigh = Math.max(...repCounts);
  const loads = working.flatMap((set) => (set.weightLbs === undefined ? [] : [set.weightLbs]));
  return {
    sets: perSideSetCount(working),
    repsLow,
    ...(repsHigh > repsLow && { repsHigh }),
    ...(loads.length > 0 && { weightLbs: Math.max(...loads) }),
  };
}

/** What `buildDerivedPrescriptionView` wraps: the targets and the session they came from. */
export interface DerivedPrescriptionRows {
  activeExerciseId: string;
  targets: DerivedTargets;
  derivedFromStartedAt: string;
  /** The lifter's local calendar date now, 'YYYY-MM-DD': the day "last time" is aged against. */
  today: string;
}

/** Whole local training days since `startedAt`, and whether that is a break (VW-851 rule 1). */
function ageOfLastTime(startedAt: string, today: string): { daysAgo: number; stale: boolean } {
  const daysAgo = daysBetween(localDate(startedAt), today);
  return { daysAgo, stale: classifyBreak(daysAgo) !== 'none' };
}

/** A labelled `derived` prescription with a one-row rail, so the page finds the rep target. */
export function buildDerivedPrescriptionView(
  rows: DerivedPrescriptionRows,
  catalog: ExerciseCatalogLookup | undefined,
): PrescriptionView {
  const { activeExerciseId, targets } = rows;
  return {
    source: 'derived',
    derivedFrom: {
      startedAt: rows.derivedFromStartedAt,
      ...ageOfLastTime(rows.derivedFromStartedAt, rows.today),
    },
    ...targets,
    exercises: [
      {
        exerciseId: activeExerciseId,
        name: catalog?.getById(activeExerciseId)?.name ?? activeExerciseId,
        order: 0,
        ...targets,
        active: true,
      },
    ],
  };
}
