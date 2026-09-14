// VW-369: the store side of the recomposition re-ask. Assembles the inputs
// `evaluateRecompDegradation` runs on, and files the lifter's answer.
//
// THE ADVISORY ITSELF IS PURE AND LIVES IN `analytics/recomp-degradation.ts`.
// Everything here is I/O: which phase is declared, how many block boundaries it
// has run through, what the scale and the self-reported band say, and which
// proposals were already declined. No threshold is decided in this file.
//
// IT NEVER WRITES `diet_phases`. `profile.set_diet_phase` is the only writer of
// an observed phase, and the lifter is the only one who may call it. Accepting
// a proposal here records that they said yes, nothing more.

import {
  computeCumulativeLossFacts,
  type CumulativeLossFacts,
} from '../analytics/cumulative-loss.js';
import {
  evaluateRecompDegradation,
  RECOMP_ADVISORY_LEVELS,
  RECOMP_DEGRADATION_CODE,
  RECOMP_DEGRADATION_VERSION,
  type RecompAdvisoryLevel,
  type RecompDeclineRecord,
  type RecompDegradationResult,
} from '../analytics/recomp-degradation.js';
import type { ServerState } from '../state/server-state.js';
import { isDietPhase } from '../store/diet-phase.js';
import type { LeannessBand } from '../store/leanness-band.js';
import {
  LOCAL_USER_ID,
  type StoredAdvisoryResponse,
  type StoredBodyMetric,
  type StoredTrainingBlock,
} from '../store/types.js';

/**
 * Weekly rate a declared `slow-loss` target runs at, as a fraction of the
 * starting weight: the slow edge of the cited fat-loss range
 * (rp:rp-s11-fat-loss-rate-heuristic), the same edge `goal-band.ts` reads.
 */
const SLOW_LOSS_FRACTION_PER_WEEK = 0.005;

/** The instant a block finished: its last template's earliest assignment. */
async function blockFinishedAt(state: ServerState, blockId: string): Promise<string | null> {
  const weeks = await state.store.getTrainingWeeksForBlock(blockId);
  const lastWeek = weeks[weeks.length - 1];
  if (lastWeek === undefined) return null;
  const templates = await state.store.getWorkoutTemplatesForWeek(lastWeek.id);
  const lastTemplate = templates[templates.length - 1];
  if (lastTemplate === undefined) return null;
  const stamps = (await state.store.getAssignmentsForTemplate(lastTemplate.id))
    .map((assignment) => assignment.assignedAt)
    .sort();
  return stamps[0] ?? null;
}

/**
 * Boundaries crossed since the phase started.
 *
 * A block counts only when it finished at or after the phase start, so a phase
 * declared mid-program does not inherit the blocks the lifter ran before it.
 * `pendingBoundary` adds the one being reported right now: on the
 * `plan.complete_workout` path the finishing block's own assignment is not
 * written until after this read, so nothing else would see it.
 */
async function countBoundaries(
  state: ServerState,
  blocks: readonly StoredTrainingBlock[],
  phaseStartedAt: string,
  pendingBoundary: boolean,
): Promise<number> {
  let finished = 0;
  for (const block of blocks) {
    const finishedAt = await blockFinishedAt(state, block.id);
    if (finishedAt !== null && finishedAt >= phaseStartedAt) finished += 1;
  }
  return finished + (pendingBoundary ? 1 : 0);
}

/** The reading nearest the phase start: the first at or after it, else the last before it. */
function readingAtPhaseStart(
  ascending: readonly StoredBodyMetric[],
  phaseStartedAt: string,
): StoredBodyMetric | undefined {
  return (
    ascending.find((metric) => metric.measuredAt >= phaseStartedAt) ??
    ascending[ascending.length - 1]
  );
}

/** The most recently declared band, or undefined when none ever was. */
function latestLeannessBand(ascending: readonly StoredBodyMetric[]): LeannessBand | undefined {
  return ascending.reduce<LeannessBand | undefined>(
    (band, metric) => metric.leannessBand ?? band,
    undefined,
  );
}

function isAdvisoryLevel(value: string): value is RecompAdvisoryLevel {
  return (RECOMP_ADVISORY_LEVELS as readonly string[]).includes(value);
}

/** Every decline on file: any one of them can suppress a repeat. */
async function readRecompDeclines(state: ServerState): Promise<RecompDeclineRecord[]> {
  const decisions = await state.store.listAdvisoryDecisions(LOCAL_USER_ID, {
    code: RECOMP_DEGRADATION_CODE,
    userResponse: 'declined',
  });
  return decisions.flatMap((decision) => {
    const boundaryCount = decision.inputs.boundariesSincePhaseStart;
    if (!isAdvisoryLevel(decision.verdict) || typeof boundaryCount !== 'number') return [];
    return [{ level: decision.verdict, boundaryCount }];
  });
}

/** The cumulative-loss facts for the open phase, or null with nothing logged. */
function lossFacts(
  ascending: readonly StoredBodyMetric[],
  phaseStartedAt: string,
  slowLoss: boolean,
  now: string,
): CumulativeLossFacts | null {
  const start = readingAtPhaseStart(ascending, phaseStartedAt);
  if (start === undefined) return null;
  return computeCumulativeLossFacts({
    readings: ascending
      .filter((metric) => metric.measuredAt >= phaseStartedAt)
      .map((metric) => ({ measuredAt: metric.measuredAt, bodyweightLbs: metric.bodyweightLbs })),
    now,
    phaseStartedAt,
    targetLine: {
      startWeightLbs: start.bodyweightLbs,
      weeklyRateLbs: slowLoss ? -start.bodyweightLbs * SLOW_LOSS_FRACTION_PER_WEEK : 0,
    },
  });
}

/**
 * The re-ask for one block boundary. `blocks` are the program's blocks up to
 * and including the one that finished.
 *
 * Always returns a result: silence carries its own reason, so a reader never
 * has to guess whether the advisory ran.
 */
export async function buildRecompDegradation(
  state: ServerState,
  blocks: readonly StoredTrainingBlock[],
  pendingBoundary: boolean,
  now: string = new Date().toISOString(),
): Promise<RecompDegradationResult> {
  const covering = await state.store.getDietPhaseCovering(LOCAL_USER_ID, now, now);
  if (covering === undefined || !isDietPhase(covering.phase)) {
    return evaluateRecompDegradation({
      phase: 'unknown',
      boundariesSincePhaseStart: 0,
      cumulativeLoss: null,
      declined: [],
    });
  }
  const ascending = (await state.store.listBodyMetrics(LOCAL_USER_ID)).sort((a, b) =>
    a.measuredAt.localeCompare(b.measuredAt),
  );
  const startBand = readingAtPhaseStart(ascending, covering.startedAt)?.leannessBand;
  const currentBand = latestLeannessBand(ascending);
  return evaluateRecompDegradation({
    phase: covering.phase,
    ...(covering.recompMode !== undefined ? { recompMode: covering.recompMode } : {}),
    boundariesSincePhaseStart: await countBoundaries(
      state,
      blocks,
      covering.startedAt,
      pendingBoundary,
    ),
    cumulativeLoss: lossFacts(
      ascending,
      covering.startedAt,
      covering.recompMode === 'slow-loss',
      now,
    ),
    ...(startBand !== undefined ? { phaseStartLeannessBand: startBand } : {}),
    ...(currentBand !== undefined ? { currentLeannessBand: currentBand } : {}),
    declined: await readRecompDeclines(state),
  });
}

/**
 * File the lifter's answer to a re-ask. A decline is what suppresses the next
 * one; an acceptance records that they said yes and still leaves the phase
 * declaration to `profile.set_diet_phase`.
 */
export async function recordRecompResponse(
  state: ServerState,
  result: RecompDegradationResult,
  response: StoredAdvisoryResponse,
  now: string = new Date().toISOString(),
): Promise<{ recorded: boolean; reason: string }> {
  if (result.proposal === null) {
    return { recorded: false, reason: result.silentReason ?? 'no proposal is open' };
  }
  await state.store.putAdvisoryDecision({
    userId: LOCAL_USER_ID,
    code: RECOMP_DEGRADATION_CODE,
    issuedAt: now,
    inputs: result.proposal.inputs,
    thresholds: result.proposal.thresholds,
    algorithmVersion: RECOMP_DEGRADATION_VERSION,
    verdict: result.proposal.level,
    userResponse: response,
    respondedAt: now,
  });
  return {
    recorded: true,
    reason:
      response === 'declined'
        ? 'Declined and filed. The same evidence is not re-offered until a later block boundary or a higher band.'
        : 'Filed. Nothing changed: declare the phase yourself with profile.set_diet_phase if you want it switched.',
  };
}
