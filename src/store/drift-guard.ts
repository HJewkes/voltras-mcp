// Drift guard over stored sessions — the store-side half of VW-90 / B15.
//
// WHAT THIS IS FOR
// ----------------
// Every cross-session verdict VMCP will emit (progression detected, MRV
// exceeded, underperformance) is the inference "same work, different result".
// That inference is only sound while the WORK was the same. A lifter who
// shortened their range of motion or sped up the concentric moves more load at
// the same effort; compared naively that reads as progress, and the reverse
// reads as fatigue. Neither is true.
//
// This module answers, for two specific sessions of one exercise: are these
// comparable at all? The judgement itself lives in `@voltras/workout-analytics`
// (`evaluateDriftGuard`); everything here is loading and scoping.
//
// THE REAL INTERFACE IS `checkDriftGuard`, NOT THE MCP TOOL.
// The future MRV detector (VW-91 / B04) runs in-process and calls this function
// directly. `driftguard.check` exists so a human can inspect the same verdict;
// it is a diagnostic, not the consumption path.
//
// NOTHING IS PERSISTED. Same philosophy as `exercise-baselines.ts`: a drift
// verdict is re-derived from stored reps on every call, because a number
// persisted from a formula that later changes becomes a silent lie.

import {
  DRIFT_GUARD_THRESHOLDS,
  evaluateDriftGuard,
  summarizeSetsForDrift,
  type BaselineKey,
  type DriftGuardVerdict,
  type DriftSummary,
} from '@voltras/workout-analytics';

import { normalisePositionsToMetres } from './position-units.js';
import { isEligibleForComparison, scopeSessionSetsToExerciseId } from './set-scope.js';
import type { SessionStore } from './types.js';

export interface DriftGuardInput {
  /** Identity of the thing being compared. `setupId` has no writer yet. */
  key: BaselineKey;
  /** The session the comparison treats as the reference (usually the older). */
  baselineSessionId: string;
  /** The session being judged against the reference. */
  currentSessionId: string;
}

/**
 * Compare the execution shape of one exercise across two sessions.
 *
 * A session with no qualifying reps for the key yields `comparable: false`: an
 * ABSENT read is not evidence of comparability, and the safe direction for a
 * gate is to refuse. Downstream must treat that identically to a real drift
 * block — skip the comparison.
 */
export async function checkDriftGuard(
  store: SessionStore,
  input: DriftGuardInput,
): Promise<DriftGuardVerdict> {
  const [baseline, current] = await Promise.all([
    summarizeSessionForDrift(store, input.baselineSessionId, input.key),
    summarizeSessionForDrift(store, input.currentSessionId, input.key),
  ]);

  if (baseline === undefined || current === undefined) {
    return noReadVerdict(baseline === undefined ? 'baseline' : 'current');
  }
  return evaluateDriftGuard(baseline, current);
}

/**
 * Sets of one exercise (and, when the key names one, one side) within a
 * session, reduced to their execution shape. Warm-up and side scoping is
 * `isEligibleForComparison`, shared with the MRV detector so the gate and the
 * thing it gates always read the same sets.
 *
 * Exported alongside {@link checkDriftGuard} because a caller that needs the
 * reference session's ROM as a DENOMINATOR — `metrics.compute quality.rom`'s
 * `romVsBaselinePct` — cannot get it from a `DriftGuardVerdict`, which carries
 * only percentages. Reaching for `summarizeSetsForDrift` directly instead
 * would put a second warm-up/side filter in the tree, and the gate and the
 * number it gates would be free to disagree about which sets they read.
 *
 * Positions are normalised to metres first (VW-203). `DriftSummary.medianRomM`
 * is an ABSOLUTE length, and `romDriftPct` divides one session's by another's,
 * so a capture-era difference between the two sessions would otherwise read as
 * a drift verdict rather than as the unit mismatch it is.
 */
export async function summarizeSessionForDrift(
  store: Pick<SessionStore, 'getSetsForSession'>,
  sessionId: string,
  key: BaselineKey,
): Promise<DriftSummary | undefined> {
  const allSets = await store.getSetsForSession(sessionId);
  const scoped = scopeSessionSetsToExerciseId(allSets, key.exerciseId)
    .filter((set) => isEligibleForComparison(set, key))
    .map(normalisePositionsToMetres);
  return summarizeSetsForDrift(scoped);
}

/** The verdict for "one side of the comparison has no reps to read". */
function noReadVerdict(missing: 'baseline' | 'current'): DriftGuardVerdict {
  return {
    comparable: false,
    flagged: true,
    tempoDriftPct: 0,
    romDriftPct: 0,
    reasoning: `no qualifying reps in the ${missing} session — drift is unmeasurable`,
    thresholdsUsed: {
      tempoDriftPct: DRIFT_GUARD_THRESHOLDS.tempoDriftPct,
      romDriftPct: DRIFT_GUARD_THRESHOLDS.romDriftPct,
    },
  };
}
