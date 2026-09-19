// The recalibration offer (VW-444 part 2, the human's option 2 "offer once,
// remember the answer").
//
// A lift target accepted before calibration is the generic starting ramp. Once
// its calibration gates open, the coach offers a data-based target ONCE and
// records the lifter's answer. Nothing about the accepted row is edited:
//
// - THE OFFER IS A NEW PROPOSAL ROW beside the accepted one, derived INSIDE the
//   accepted target's frame (its start value, start date, end date and week
//   grid). The block is the fixed frame; only the numbers change, so it never
//   restarts from today (human decision 2026-09-18).
// - ACCEPTING is `goal.accept_target` on that row: the accepted starting ramp
//   is retired and the offer accepted in its place.
// - DECLINING is `goal.retire` on that row. The answer suppresses the offer for
//   the rest of the accepted target's block.
// - EVIDENCE GOING BACKWARDS withdraws an unanswered offer: its row is retired
//   and the record says so, and a later calibration may offer afresh. So does
//   retiring the ramp itself by any other path.
//
// The answer lives in `advisory_decisions` under its own code, so no column and
// no migration is needed. `goal.new_chapter` is deliberately not the mechanism:
// it clamps the lift's history to a new boundary, which would discard the very
// sessions that calibrated it.
//
// Confidentiality: fitness metadata and coaching prose only, no protocol data.

import { todayLocal } from '../analytics/training-days.js';
import { contextInFrame, goalBlockFrame } from './goal-block-frame.js';
import { randomUUID } from 'node:crypto';

import { GOAL_BAND_CONSTANTS, calibrationGapOf, isStartingRamp } from '../analytics/goal-band.js';
import type { ServerState } from '../state/server-state.js';
import {
  LOCAL_USER_ID,
  type BaselineState,
  type StoredAdvisoryDecision,
  type StoredGoalTarget,
} from '../store/types.js';
import {
  deriveTargetInFrame,
  readDerivationContext,
  type DerivedTarget,
  type GoalDerivationContext,
} from './goal-derivation.js';

/** The advisory this module issues, in `advisory_decisions.code`. */
export const RECALIBRATION_OFFER_CODE = 'goal_calibrated_reproposal';

/** Bumped when the offer rules below change, so old answers stay re-scorable. */
export const RECALIBRATION_OFFER_VERSION = 'goal-recalibration-offer@1.0.0';

/** What one offer record holds in its `inputs`. */
export interface RecalibrationOfferInputs {
  /** The accepted starting-ramp target the offer would replace. */
  targetId: string;
  /** The proposal row the lifter accepts or retires to answer. */
  offerTargetId: string;
  committedValue: number;
  stretchValue: number;
  /** Set on acceptance: the row that superseded `targetId`. */
  newTargetId?: string;
  withdrawnAt?: string;
}

export interface RecalibrationOffer {
  decisionId: string;
  targetId: string;
  offerTargetId: string;
  metric: string;
  exerciseId: string | null;
  /** The accepted starting ramp's committed number, which the offer never edits. */
  acceptedCommittedValue: number;
  committedValue: number;
  stretchValue: number;
  basis: string;
  infoLevel: string;
  startMeasuredAt: string;
  endsAt: string;
  matchedSessionCount: number;
  baselineState: BaselineState;
  note: string;
}

type CalibrationEvidence = { matchedSessionCount: number; baselineState: BaselineState };

const OFFER_NOTE =
  'Calibrated: the accepted target is still the starting ramp, and a target based on the ' +
  'lifter’s own lifts is on offer inside the same block (same start, end and weeks). Ask once. ' +
  'To accept, call goal.accept_target with offerTargetId: the starting ramp is retired and the ' +
  'offer takes its place. To decline, call goal.retire with offerTargetId and outcome ' +
  'abandoned: the starting ramp stays and the offer is not repeated this block.';

export function offerInputsOf(decision: StoredAdvisoryDecision): RecalibrationOfferInputs {
  return decision.inputs as unknown as RecalibrationOfferInputs;
}

export async function listOfferDecisions(
  store: Pick<ServerState['store'], 'listAdvisoryDecisions'>,
): Promise<StoredAdvisoryDecision[]> {
  return store.listAdvisoryDecisions(LOCAL_USER_ID, { code: RECALIBRATION_OFFER_CODE });
}

/** An accepted, live starting ramp whose block has not ended: the only thing ever offered on. */
export function isOfferCandidate(target: StoredGoalTarget, nowIso: string): boolean {
  return (
    target.acceptedBy !== undefined &&
    target.retiredAt === undefined &&
    isStartingRamp(target.metric, target.infoLevel) &&
    nowIso < target.endsAt
  );
}

/**
 * Offer, refresh or withdraw for every live starting ramp, optionally only
 * under the named priorities. Returns the offers standing after the pass.
 */
export async function reconcileRecalibrationOffers(
  state: ServerState,
  priorityIds?: readonly string[],
): Promise<RecalibrationOffer[]> {
  const now = new Date().toISOString();
  const decisions = await listOfferDecisions(state.store);
  const offers: RecalibrationOffer[] = [];
  for (const priority of await state.store.listPriorities(LOCAL_USER_ID)) {
    if (priorityIds !== undefined && !priorityIds.includes(priority.id)) continue;
    const targets = await state.store.listGoalTargets({ priorityId: priority.id });
    const candidates = targets.filter((target) => isOfferCandidate(target, now));
    if (candidates.length === 0) continue;
    const context = await readDerivationContext(state, priority);
    for (const target of candidates) {
      const offer = await reconcileOne(state, context, target, decisions, now);
      if (offer !== undefined) offers.push(offer);
    }
  }
  return offers;
}

async function reconcileOne(
  state: ServerState,
  context: GoalDerivationContext,
  target: StoredGoalTarget,
  decisions: readonly StoredAdvisoryDecision[],
  now: string,
): Promise<RecalibrationOffer | undefined> {
  const mine = decisions.filter((decision) => offerInputsOf(decision).targetId === target.id);
  if (mine.some((decision) => decision.userResponse === 'declined')) return undefined;
  const open = mine.find((decision) => decision.userResponse === undefined);
  // A block-bound ramp is re-derived on its block's weeks, so the offer keeps the block's dates (VW-477).
  const frame = await goalBlockFrame(state.store, target.blockId, todayLocal());
  const inFrame = contextInFrame(context, frame);
  const framed = await deriveTargetInFrame(state, inFrame, target);
  if (!('band' in framed) || gapOf(framed) !== null) {
    if (open !== undefined) await withdrawOffer(state, open, now);
    return undefined;
  }
  return writeOffer(state, inFrame, target, framed, open, now);
}

function gapOf(evidence: CalibrationEvidence): ReturnType<typeof calibrationGapOf> {
  return calibrationGapOf(evidence.matchedSessionCount, evidence.baselineState);
}

/** Today's calibration evidence for the target's own lift, read the way the page reads it. */
async function readEvidence(
  state: ServerState,
  context: GoalDerivationContext,
  target: StoredGoalTarget,
): Promise<CalibrationEvidence | null> {
  const framed = await deriveTargetInFrame(state, context, target);
  if (!('band' in framed)) return null;
  return { matchedSessionCount: framed.matchedSessionCount, baselineState: framed.baselineState };
}

/**
 * The offer is the band re-derived inside the ramp's own frame (VW-449's
 * `deriveTargetInFrame`): its start value on week 1 of its block, today's info
 * level and, where earned, today's fitted slope.
 */
async function writeOffer(
  state: ServerState,
  context: GoalDerivationContext,
  target: StoredGoalTarget,
  derived: DerivedTarget,
  open: StoredAdvisoryDecision | undefined,
  now: string,
): Promise<RecalibrationOffer> {
  const offerTargetId = open === undefined ? randomUUID() : offerInputsOf(open).offerTargetId;
  const row = await state.store.putGoalTarget(framedRow(target, derived, context, offerTargetId));
  const inputs: RecalibrationOfferInputs = {
    targetId: target.id,
    offerTargetId,
    committedValue: row.committedValue,
    stretchValue: row.stretchValue,
  };
  const decision = await state.store.putAdvisoryDecision({
    ...(open === undefined ? {} : { id: open.id }),
    userId: LOCAL_USER_ID,
    code: RECALIBRATION_OFFER_CODE,
    issuedAt: open?.issuedAt ?? now,
    inputs: { ...inputs },
    thresholds: { minMatchedSessionsForRamp: GOAL_BAND_CONSTANTS.minMatchedSessionsForRamp },
    algorithmVersion: RECALIBRATION_OFFER_VERSION,
    verdict: 'recalibrated_target_offered',
  });
  return offerOf(decision, target, row, derived);
}

/** The offer row: the accepted target's frame, the fresh band's numbers. */
function framedRow(
  frame: StoredGoalTarget,
  derived: DerivedTarget,
  context: GoalDerivationContext,
  id: string,
): StoredGoalTarget {
  return {
    id,
    priorityId: frame.priorityId,
    metric: frame.metric,
    ...(frame.exerciseId === undefined ? {} : { exerciseId: frame.exerciseId }),
    ...(frame.anchorReps === undefined ? {} : { anchorReps: frame.anchorReps }),
    startValue: frame.startValue,
    startMeasuredAt: frame.startMeasuredAt,
    bandLowPctPerWeek: derived.band.bandLowPctPerWeek,
    bandHighPctPerWeek: derived.band.bandHighPctPerWeek,
    committedValue: derived.band.committedValue,
    stretchValue: derived.band.stretchValue,
    basis: derived.band.basis,
    infoLevel: derived.band.infoLevel,
    tierUsed: context.tier,
    tierProvisional: context.tierProvisional,
    dietPhaseAtDerivation: context.dietState.phase,
    acknowledgedStretch: false,
    derivedAt: context.derivedAt,
    endsAt: frame.endsAt,
    ...(frame.blockId === undefined ? {} : { blockId: frame.blockId }),
    ...(frame.newChapterAt === undefined ? {} : { newChapterAt: frame.newChapterAt }),
  };
}

function offerOf(
  decision: StoredAdvisoryDecision,
  target: StoredGoalTarget,
  row: StoredGoalTarget,
  evidence: CalibrationEvidence,
): RecalibrationOffer {
  return {
    decisionId: decision.id,
    targetId: target.id,
    offerTargetId: row.id,
    metric: row.metric,
    exerciseId: row.exerciseId ?? null,
    acceptedCommittedValue: target.committedValue,
    committedValue: row.committedValue,
    stretchValue: row.stretchValue,
    basis: row.basis,
    infoLevel: row.infoLevel,
    startMeasuredAt: row.startMeasuredAt,
    endsAt: row.endsAt,
    matchedSessionCount: evidence.matchedSessionCount,
    baselineState: evidence.baselineState,
    note: OFFER_NOTE,
  };
}

/** Evidence went backwards: the unanswered offer is taken off the table, never left to be accepted. */
async function withdrawOffer(
  state: ServerState,
  open: StoredAdvisoryDecision,
  now: string,
): Promise<void> {
  const inputs = offerInputsOf(open);
  await state.store.retireGoalTarget(inputs.offerTargetId, 'abandoned', now);
  await state.store.putAdvisoryDecision({
    ...open,
    inputs: { ...inputs, withdrawnAt: now },
    userResponse: 'ignored',
    respondedAt: now,
  });
}

/** The unanswered offer whose proposal row is `offerTargetId`, if there is one. */
export async function findOpenOffer(
  state: ServerState,
  offerTargetId: string,
): Promise<StoredAdvisoryDecision | undefined> {
  return (await listOfferDecisions(state.store)).find(
    (decision) =>
      decision.userResponse === undefined &&
      offerInputsOf(decision).offerTargetId === offerTargetId,
  );
}

/** Whether an open offer can still be accepted, re-checked at the moment of acceptance. */
export type OfferCheck = 'live' | 'withdrawn' | 'orphaned';

export async function checkOffer(
  state: ServerState,
  open: StoredAdvisoryDecision,
  offerRow: StoredGoalTarget,
): Promise<OfferCheck> {
  const now = new Date().toISOString();
  const inputs = offerInputsOf(open);
  const stored = await state.store.listGoalTargets({ priorityId: offerRow.priorityId });
  const accepted = stored.find((target) => target.id === inputs.targetId);
  if (accepted === undefined || !isOfferCandidate(accepted, now)) {
    await answerOffer(state, open, 'ignored', now);
    return 'orphaned';
  }
  const priority = (await state.store.listPriorities(LOCAL_USER_ID)).find(
    (row) => row.id === accepted.priorityId,
  );
  const context = priority === undefined ? null : await readDerivationContext(state, priority);
  const evidence = context === null ? null : await readEvidence(state, context, accepted);
  if (
    evidence !== null &&
    calibrationGapOf(evidence.matchedSessionCount, evidence.baselineState) === null
  ) {
    return 'live';
  }
  await withdrawOffer(state, open, now);
  return 'withdrawn';
}

/** Acceptance: retire the starting ramp the offer replaces, and record which row replaced it. */
export async function completeOffer(
  state: ServerState,
  open: StoredAdvisoryDecision,
  newTargetId: string,
): Promise<string> {
  const now = new Date().toISOString();
  const inputs = offerInputsOf(open);
  await state.store.retireGoalTarget(inputs.targetId, 'abandoned', now);
  await state.store.putAdvisoryDecision({
    ...open,
    inputs: { ...inputs, newTargetId },
    userResponse: 'accepted',
    respondedAt: now,
  });
  return inputs.targetId;
}

/** Retiring an offer's row is the lifter declining it; the answer is recorded against the offer. */
export async function declineOfferFor(state: ServerState, offerTargetId: string): Promise<boolean> {
  const open = await findOpenOffer(state, offerTargetId);
  if (open === undefined) return false;
  await answerOffer(state, open, 'declined', new Date().toISOString());
  return true;
}

async function answerOffer(
  state: ServerState,
  open: StoredAdvisoryDecision,
  response: 'declined' | 'ignored',
  now: string,
): Promise<void> {
  await state.store.putAdvisoryDecision({ ...open, userResponse: response, respondedAt: now });
}

/**
 * A ramp retired by any path other than accepting its offer takes its open
 * offer with it: the offer row is retired and the record closed as withdrawn,
 * so no offer outlives the target it would replace.
 */
export async function withdrawOffersFor(
  state: ServerState,
  retiredTargetIds: readonly string[],
): Promise<void> {
  const now = new Date().toISOString();
  const open = (await listOfferDecisions(state.store)).filter(
    (decision) =>
      decision.userResponse === undefined &&
      retiredTargetIds.includes(offerInputsOf(decision).targetId),
  );
  for (const decision of open) await withdrawOffer(state, decision, now);
}

/** Every proposal row an offer ever wrote: they are answers, never "a declined proposal" for the leg. */
export function offerRowIds(decisions: readonly StoredAdvisoryDecision[]): Set<string> {
  return new Set(decisions.map((decision) => offerInputsOf(decision).offerTargetId));
}
