// MRV underperformance over stored sessions — the store-side half of
// VW-91 / B04.
//
// WHAT THIS IS FOR
// ----------------
// Maximum Recoverable Volume is the point past which added volume produces only
// fatigue. Its observable signature is a session that went backwards at load
// the lifter had already handled — and then another one. This module answers
// the pairwise half of that for two specific sessions of one exercise: did the
// current session underperform the baseline? The judgement itself lives in
// `@voltras/workout-analytics` (`evaluateMrvUnderperformance`, and
// `evaluateMrvGuard` to combine two pairs); everything here is loading and
// scoping.
//
// THE DRIFT GUARD IS NOT OPTIONAL. `checkDriftGuard` runs FIRST and its verdict
// is passed into the judgement, which refuses to evaluate anything the guard
// declared incomparable. This module never re-derives comparability of its own —
// there must be exactly one answer to "are these two sessions the same work".
//
// DIAGNOSTIC-ONLY, NO INTERNAL WIRING (VW-131). `mrvguard.check`
// (`tools/mrv-guard-tools.ts`) is the only consumer today, mirroring
// `driftguard.check`'s stance exactly — a prior version of this comment
// claimed "progression scoring, coaching prompts" already called this
// in-process; grepping turned up no such callers. A future deload-advisory
// tool may import `checkMrvGuard` directly; none exists yet.
//
// NOTHING IS PERSISTED. Same philosophy as `exercise-baselines.ts`: the verdict
// is re-derived from stored reps on every call, because a number persisted from
// a formula that later changes becomes a silent lie.

import {
  MRV_UNDERPERFORMANCE_THRESHOLDS,
  evaluateMrvGuard,
  evaluateMrvUnderperformance,
  summarizeSetsForPerformance,
  type BaselineKey,
  type MrvGuardVerdict,
  type MrvUnderperformanceVerdict,
  type PerformanceSummary,
} from '@voltras/workout-analytics';

import { checkDriftGuard } from './drift-guard.js';
import { isEligibleForComparison, scopeSessionSetsToExerciseId } from './set-scope.js';
import type { SessionStore } from './types.js';

export interface MrvGuardInput {
  /** Identity of the thing being compared. `setupId` has no writer yet. */
  key: BaselineKey;
  /** The session the comparison treats as the reference (usually the older). */
  baselineSessionId: string;
  /** The session being judged against the reference. */
  currentSessionId: string;
}

/**
 * Compare what one exercise achieved across two sessions.
 *
 * A session with no load-bearing sets for the key yields `evaluable: false`: an
 * ABSENT read is not evidence that performance held, and the safe direction for
 * a fatigue signal is to say nothing rather than to say "fine".
 */
export async function checkMrvUnderperformance(
  store: SessionStore,
  input: MrvGuardInput,
): Promise<MrvUnderperformanceVerdict> {
  // The gate, first and unconditionally. `MrvGuardInput` is the same shape as
  // `DriftGuardInput` precisely so the two always see the same session pair.
  const driftVerdict = await checkDriftGuard(store, input);

  const [baseline, current] = await Promise.all([
    summarizeSession(store, input.baselineSessionId, input.key),
    summarizeSession(store, input.currentSessionId, input.key),
  ]);

  if (baseline === undefined || current === undefined) {
    return noReadVerdict(baseline === undefined ? 'baseline' : 'current');
  }
  return evaluateMrvUnderperformance(baseline, current, driftVerdict);
}

/**
 * Sets of one exercise (and, when the key names one, one side) within a
 * session, reduced to what they achieved. Warm-up and side scoping is
 * `isEligibleForComparison` — the same filter `checkDriftGuard` applies, so the
 * gate and the judgement can never disagree about which sets are the work.
 */
async function summarizeSession(
  store: SessionStore,
  sessionId: string,
  key: BaselineKey,
): Promise<PerformanceSummary | undefined> {
  const allSets = await store.getSetsForSession(sessionId);
  const scoped = scopeSessionSetsToExerciseId(allSets, key.exerciseId).filter((set) =>
    isEligibleForComparison(set, key),
  );
  return summarizeSetsForPerformance(scoped);
}

export interface MrvGuardCheckInput {
  /** Identity of the thing being compared. */
  key: BaselineKey;
  /** Oldest of the three sessions — the prior pair's baseline. */
  session1Id: string;
  /** Middle session — the prior pair's current AND the current pair's baseline. */
  session2Id: string;
  /** Newest session — the current pair's current, and the one judged live. */
  session3Id: string;
}

/**
 * The B04 signal itself: two CONSECUTIVE pairwise comparisons across three
 * sessions in temporal order, combined by `evaluateMrvGuard`'s pure AND. One
 * underperforming session is noise; two in a row, at matched-or-greater load
 * and with drift-guard clearance on both pairs, is a confirmed MRV breach.
 */
export async function checkMrvGuard(
  store: SessionStore,
  input: MrvGuardCheckInput,
): Promise<{
  priorPair: MrvUnderperformanceVerdict;
  currentPair: MrvUnderperformanceVerdict;
  guard: MrvGuardVerdict;
}> {
  const [priorPair, currentPair] = await Promise.all([
    checkMrvUnderperformance(store, {
      key: input.key,
      baselineSessionId: input.session1Id,
      currentSessionId: input.session2Id,
    }),
    checkMrvUnderperformance(store, {
      key: input.key,
      baselineSessionId: input.session2Id,
      currentSessionId: input.session3Id,
    }),
  ]);
  return { priorPair, currentPair, guard: evaluateMrvGuard(priorPair, currentPair) };
}

/** The verdict for "one side of the comparison has no load-bearing sets". */
function noReadVerdict(missing: 'baseline' | 'current'): MrvUnderperformanceVerdict {
  return {
    evaluable: false,
    underperformed: false,
    volumeLoadDeltaPct: 0,
    velocityDeltaPct: 0,
    reasoning: `no sets with recorded weight in the ${missing} session — performance is unmeasurable`,
    thresholdsUsed: {
      volumeLoadDeclinePct: MRV_UNDERPERFORMANCE_THRESHOLDS.volumeLoadDeclinePct,
      velocityDeclinePct: MRV_UNDERPERFORMANCE_THRESHOLDS.velocityDeclinePct,
      loadToleranceLbs: MRV_UNDERPERFORMANCE_THRESHOLDS.loadToleranceLbs,
    },
  };
}
