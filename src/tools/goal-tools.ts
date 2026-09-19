// The `goal.*` tools (VW-350, plan H2): declare priorities, propose targets,
// accept one, list, retire, start a new chapter.
//
// THE HUMAN DECLARES, THE COACH DERIVES. `goal.declare_priorities` is the only
// tool here that takes the lifter's own words, and even that takes no number.
// `goal.propose_targets` reads a start value out of history, bands it, and
// stores the band as a PROPOSAL (`acceptedBy` absent). Nothing is a target
// until the lifter accepts it.
//
// ONCE ACCEPTED, FIXED (human decision, 2026-09-13). There is no tool here
// that edits an accepted target, and the store refuses one anyway
// (`GOAL_TARGET_FIXED`). The coach may not raise it when the lifter runs ahead
// — being ahead is a decision for the block boundary — and may not quietly
// lower it when they fall behind, because a target that moves to meet the
// lifter makes every "met" meaningless. The two exits are `goal.retire` with
// an outcome and `goal.new_chapter`.
//
// COMMITTED IS THE LOW EDGE AND NOTHING IS SHADED. RP's rule is to counter a
// wish with a target that cannot be under-delivered
// (rp:rp-s10-underpromise-overdeliver-goal-setting); B55's rule is that a
// displayed projection is never shaded. Both hold here because the band is
// shown whole: the committed value is its conservative edge, the stretch is
// its optimistic one, and accepting a value outside the band never moves the
// band to match.

import { todayLocal } from '../analytics/training-days.js';
import {
  contextInFrame,
  defaultDatedBlockId,
  goalBlockFrame,
  targetBlockId,
  type GoalBlockFrame,
} from './goal-block-frame.js';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';

import type { GoalBand } from '../analytics/goal-band.js';
import { blockEndsAt } from '../analytics/goal-block-weeks.js';
import {
  selectGoalMetrics,
  wholeBodyRefOf,
  type GoalGainMetric,
  type GoalMetricSelection,
} from '../analytics/goal-metrics.js';
import {
  GoalAcceptTargetInput,
  GoalDeclarePrioritiesInput,
  GoalListInput,
  GoalNewChapterInput,
  GoalProposeTargetsInput,
  GoalRetireInput,
  GoalWeeklyReviewInput,
} from '../schemas/goal.js';
import type { ServerState } from '../state/server-state.js';
import {
  LOCAL_USER_ID,
  type StoredAdvisoryDecision,
  type StoredGoalTarget,
  type StoredPriority,
  type StoredPriorityLevel,
} from '../store/types.js';
import { readDietPhaseState } from './diet-phase-state.js';
import {
  deriveTarget,
  readDerivationContext,
  type DerivedTarget,
  type GoalDerivationContext,
  type SkippedMetric,
} from './goal-derivation.js';
import {
  evaluateDeclaration,
  FAT_LOSS_DOWNGRADE_CODE,
  GOAL_GUARDRAIL_THRESHOLDS,
  GOAL_GUARDRAIL_VERSION,
  type GoalDowngradeProposal,
  type GoalGuardrailWarning,
} from './goal-guardrails.js';
import { wrapHandler } from './helpers.js';
import { getTierSignal } from './tier-signal.js';
import {
  GOAL_ACCEPT_TARGET_DESCRIPTION,
  GOAL_DECLARE_PRIORITIES_DESCRIPTION,
  GOAL_LIST_DESCRIPTION,
  GOAL_NEW_CHAPTER_DESCRIPTION,
  GOAL_PROPOSE_TARGETS_DESCRIPTION,
  GOAL_RETIRE_DESCRIPTION,
  GOAL_WEEKLY_REVIEW_DESCRIPTION,
} from './goal-descriptions.js';
import { readUnreviewed } from '../analytics/session-review.js';
import { runWeeklyReview } from './goal-weekly-review.js';
import {
  checkOffer,
  completeOffer,
  declineOfferFor,
  findOpenOffer,
  listOfferDecisions,
  offerRowIds,
  reconcileRecalibrationOffers,
  withdrawOffersFor,
  type RecalibrationOffer,
} from './goal-recalibration.js';
import {
  acceptedStartingRamp,
  proposedStartingRamp,
  type ProposedStartingRamp,
  type StartingRampNotice,
} from './goal-starting-ramp.js';

/** Weeks a horizon falls back to. rp:rp-s10-three-month-planning-horizon */
const DEFAULT_HORIZON_WEEKS = 12;

/** The reconciliation every proposal and acceptance carries (plan §1.7). */
const COMMITTED_EDGE_RP_IDS = ['rp:rp-s10-underpromise-overdeliver-goal-setting'];

class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ToolError';
  }
}

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

export function registerGoalTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
  install(
    placeholders,
    'goal.declare_priorities',
    GoalDeclarePrioritiesInput,
    wrapHandler(GoalDeclarePrioritiesInput, (input) => declarePriorities(state, input)),
    GOAL_DECLARE_PRIORITIES_DESCRIPTION,
  );
  install(
    placeholders,
    'goal.propose_targets',
    GoalProposeTargetsInput,
    wrapHandler(GoalProposeTargetsInput, (input) => proposeTargets(state, input)),
    GOAL_PROPOSE_TARGETS_DESCRIPTION,
  );
  install(
    placeholders,
    'goal.accept_target',
    GoalAcceptTargetInput,
    wrapHandler(GoalAcceptTargetInput, (input) => acceptTarget(state, input)),
    GOAL_ACCEPT_TARGET_DESCRIPTION,
  );
  install(
    placeholders,
    'goal.list',
    GoalListInput,
    wrapHandler(GoalListInput, (input) => listGoals(state, input)),
    GOAL_LIST_DESCRIPTION,
  );
  install(
    placeholders,
    'goal.retire',
    GoalRetireInput,
    wrapHandler(GoalRetireInput, (input) => retireGoal(state, input)),
    GOAL_RETIRE_DESCRIPTION,
  );
  install(
    placeholders,
    'goal.new_chapter',
    GoalNewChapterInput,
    wrapHandler(GoalNewChapterInput, (input) => startNewChapter(state, input)),
    GOAL_NEW_CHAPTER_DESCRIPTION,
  );
  install(
    placeholders,
    'goal.weekly_review',
    GoalWeeklyReviewInput,
    wrapHandler(GoalWeeklyReviewInput, async (input) => ({
      ...(await runWeeklyReview(state, input)),
      recalibrationOffers: await reconcileRecalibrationOffers(state),
    })),
    GOAL_WEEKLY_REVIEW_DESCRIPTION,
  );
}

function install<S extends z.ZodObject>(
  placeholders: PlaceholderTools,
  name: string,
  schema: S,
  callback: (args: unknown, extra?: unknown) => Promise<unknown>,
  description: string,
): void {
  const tool = placeholders.get(name);
  if (tool === undefined) {
    throw new Error(`tool placeholder not registered: ${name}`);
  }
  tool.update({ paramsSchema: schema.shape, callback: callback as never, description } as never);
}

// --- goal.declare_priorities ---

export interface DeclarePrioritiesResult {
  priorities: StoredPriority[];
  warnings: GoalGuardrailWarning[];
  proposals: GoalDowngradeProposal[];
  dietPhase: string;
  tierUsed: string;
  thresholds: typeof GOAL_GUARDRAIL_THRESHOLDS;
  /** The block the declaration was stamped with, and whether it was the dated default (VW-476). */
  block: { id: string; defaulted: boolean } | null;
}

async function declarePriorities(
  state: ServerState,
  given: z.infer<typeof GoalDeclarePrioritiesInput>,
): Promise<DeclarePrioritiesResult> {
  const blockId = given.blockId ?? (await defaultDatedBlockId(state.store, todayLocal()));
  const input = blockId === undefined ? given : { ...given, blockId };
  const declaredAt = new Date().toISOString();
  const signal = await getTierSignal(state, LOCAL_USER_ID);
  const tier = signal.declared ?? signal.tier;
  const dietState = await readDietPhaseState(state, declaredAt);
  const existing = await state.store.listPriorities(LOCAL_USER_ID);
  assertOneWholeBodyPriorityPerRef(input.items, existing);
  const guardrails = evaluateDeclaration({
    items: input.items,
    existing,
    dietPhase: dietState.phase,
    tier,
    ...(input.blockId !== undefined ? { blockId: input.blockId } : {}),
    declinedRefs: await readDeclinedRefs(state),
  });
  await recordDeclines(state, guardrails.declinedNow, dietState.phase, declaredAt);
  return {
    priorities: await storeDeclaration(state, input, existing, declaredAt),
    warnings: guardrails.warnings,
    proposals: guardrails.proposals,
    dietPhase: dietState.phase,
    tierUsed: tier,
    thresholds: GOAL_GUARDRAIL_THRESHOLDS,
    block: blockId === undefined ? null : { id: blockId, defaulted: given.blockId === undefined },
  };
}

type DeclaredItem = { kind: StoredPriority['kind']; ref: string };

/**
 * One live priority per whole-body ref. Two would each derive a target for the
 * same metric, and the page would draw one goal twice. Re-declaring the same
 * kind and ref is a re-declaration, which `mergePriority` folds into its row.
 */
function assertOneWholeBodyPriorityPerRef(
  items: readonly DeclaredItem[],
  existing: readonly StoredPriority[],
): void {
  const seen = new Set<string>();
  for (const item of items) {
    const ref = wholeBodyRefOf(item);
    if (ref === null) continue;
    const other = existing.find(
      (row) => wholeBodyRefOf(row) === ref && !(row.kind === item.kind && row.ref === item.ref),
    );
    if (seen.has(ref) || other !== undefined) throw duplicateWholeBody(ref, other);
    seen.add(ref);
  }
}

function duplicateWholeBody(ref: string, other: StoredPriority | undefined): ToolError {
  const where =
    other === undefined
      ? 'twice in this declaration'
      : `already, as priority ${other.id} with ref "${other.ref}"`;
  return new ToolError(
    'GOAL_WHOLE_BODY_PRIORITY_EXISTS',
    `The whole-body priority "${ref}" is declared ${where}. Declare it once: re-declare the same ` +
      'ref to change its level, or retire the other priority first.',
  );
}

/** Every declared item, written as declared. No guardrail reaches this. */
async function storeDeclaration(
  state: ServerState,
  input: z.infer<typeof GoalDeclarePrioritiesInput>,
  existing: readonly StoredPriority[],
  declaredAt: string,
): Promise<StoredPriority[]> {
  const horizonWeeks = await resolveHorizonWeeks(state, input.horizonWeeks, input.blockId);
  const stamp = { declaredAt, horizonWeeks, blockId: input.blockId };
  const priorities: StoredPriority[] = [];
  for (const item of input.items) {
    priorities.push(await state.store.putPriority(mergePriority(item, existing, stamp)));
  }
  return priorities;
}

/** A re-declaration keeps its row, so `mesosHeld` keeps counting across blocks. */
function mergePriority(
  item: { kind: StoredPriority['kind']; ref: string; level: StoredPriorityLevel },
  existing: readonly StoredPriority[],
  stamp: { declaredAt: string; horizonWeeks: number; blockId?: string | undefined },
): StoredPriority {
  const prior = existing.find(
    (priority) => priority.kind === item.kind && priority.ref === item.ref,
  );
  const heldAnotherMeso =
    prior !== undefined && stamp.blockId !== undefined && prior.blockId !== stamp.blockId;
  return {
    id: prior?.id ?? randomUUID(),
    userId: LOCAL_USER_ID,
    ...(stamp.blockId !== undefined ? { blockId: stamp.blockId } : {}),
    horizonWeeks: stamp.horizonWeeks,
    kind: item.kind,
    ref: item.ref,
    level: item.level,
    declaredAt: stamp.declaredAt,
    mesosHeld: (prior?.mesosHeld ?? 0) + (heldAnotherMeso ? 1 : 0),
  };
}

async function resolveHorizonWeeks(
  state: ServerState,
  declared: number | undefined,
  blockId: string | undefined,
): Promise<number> {
  if (declared !== undefined) return declared;
  const block = blockId === undefined ? undefined : await state.store.getTrainingBlock(blockId);
  return block?.weeksCount ?? DEFAULT_HORIZON_WEEKS;
}

/**
 * Refs whose fat-loss downgrade the lifter has already declined.
 *
 * WHY `advisory_decisions` AND NOT A `goal_targets` ROW. A level downgrade is
 * not a target: it has no metric, no start value and no band, so filing it as
 * a target would need placeholder numbers in four NOT NULL columns and would
 * then show up in `goal.list` as a target nobody proposed. `advisory_decisions`
 * already stores exactly this — an advisory, the inputs it fired on, the
 * thresholds in force, and what the lifter answered.
 */
export async function readDeclinedRefs(state: ServerState): Promise<string[]> {
  const decisions = await state.store.listAdvisoryDecisions(LOCAL_USER_ID, {
    code: FAT_LOSS_DOWNGRADE_CODE,
    userResponse: 'declined',
  });
  return decisions
    .map((decision) => decision.inputs.ref)
    .filter((ref): ref is string => typeof ref === 'string');
}

/**
 * Only ANSWERED advisories are written. An advisory that fired and was not
 * answered is re-derived from live inputs on the next call, so persisting it
 * would add a row carrying no information the next read cannot recompute.
 */
async function recordDeclines(
  state: ServerState,
  refs: readonly string[],
  phase: string,
  at: string,
): Promise<void> {
  for (const ref of refs) {
    await state.store.putAdvisoryDecision({
      userId: LOCAL_USER_ID,
      code: FAT_LOSS_DOWNGRADE_CODE,
      issuedAt: at,
      inputs: { ref, dietPhase: phase },
      thresholds: { ...GOAL_GUARDRAIL_THRESHOLDS },
      algorithmVersion: GOAL_GUARDRAIL_VERSION,
      verdict: 'downgrade_to_maintain',
      userResponse: 'declined',
      respondedAt: at,
    });
  }
}

// --- goal.propose_targets ---

export interface ProposedTarget {
  targetId: string;
  metric: string;
  exerciseId: string | null;
  anchorReps: number | null;
  startValue: number;
  startMeasuredAt: string;
  matchedSessionCount: number;
  bandLowPctPerWeek: number;
  bandHighPctPerWeek: number;
  committedValue: number;
  stretchValue: number;
  basis: string;
  infoLevel: string;
  tierUsed: string;
  tierProvisional: boolean;
  dietPhaseAtDerivation: string;
  provisional: boolean;
  acceptedBy: null;
  rpIds: string[];
  notes: string[];
  /** A cold lift target: the generic starting ramp, re-proposed after calibration (VW-444). */
  startingRamp?: ProposedStartingRamp;
}

/** One derived leg before anything is written: the same shape, minus the row. */
export type PreviewedTarget = Omit<ProposedTarget, 'targetId' | 'acceptedBy'>;

export interface ProposeTargetsResult {
  priorityId: string;
  targets: ProposedTarget[];
  /** Read-only legs: shown with their band, never scored and never stored. */
  context: PreviewedTarget[];
  skipped: SkippedMetric[];
  selections: GoalMetricSelection[];
  horizonWeeks: number;
  notes: string[];
  /** Calibrated starting ramps under this priority, each with its data-based offer (VW-444). */
  recalibrationOffers: RecalibrationOffer[];
  /**
   * Past local days nobody has marked training or test (VW-489). Every start value
   * and every attendance band here is derived from training-marked history only, so
   * a cold proposal or a skipped attendance leg beside a non-zero `unreviewedDays`
   * means the evidence is withheld pending review, not missing.
   */
  unreviewedDays: number;
  /** Those days themselves, newest first, so a coach can name them. */
  unreviewedDayList: string[];
}

/** A primary leg that would be stored, with everything the writer needs. */
export interface PreviewedLeg {
  selection: GoalGainMetric;
  derived: DerivedTarget;
  entry: PreviewedTarget;
}

export interface GoalTargetPreview {
  priorityId: string;
  legs: PreviewedLeg[];
  contextTargets: PreviewedTarget[];
  skipped: SkippedMetric[];
  selections: GoalMetricSelection[];
  horizonWeeks: number;
  notes: string[];
  derivation: GoalDerivationContext;
  /** The dated block the targets are set for, when there is one (VW-477). */
  frame: GoalBlockFrame | null;
  /** Rows this preview was blocked against; a writer reuses their ids. */
  stored: readonly StoredGoalTarget[];
  /** Proposal rows written by a recalibration offer: answers, never a declined leg. */
  offerRows: ReadonlySet<string>;
}

/**
 * Every band a priority would get, derived and nothing written.
 *
 * Split out of `goal.propose_targets` so the block-boundary re-ask (VW-359)
 * can show the next block's bands without persisting a proposal nobody asked
 * for. Proposing is this plus the writes; the band logic has one home.
 */
export async function previewTargets(
  state: ServerState,
  priority: StoredPriority,
): Promise<GoalTargetPreview> {
  const today = todayLocal();
  const frame = await goalBlockFrame(
    state.store,
    await targetBlockId(state.store, priority, today),
    today,
  );
  const derivation = contextInFrame(await readDerivationContext(state, priority), frame);
  const preview: GoalTargetPreview = {
    priorityId: priority.id,
    legs: [],
    contextTargets: [],
    skipped: [],
    selections: selectGoalMetrics(priority, state.exercises.list()),
    horizonWeeks: derivation.horizonWeeks,
    notes: derivation.notes,
    derivation,
    frame,
    stored: await state.store.listGoalTargets(
      { priorityId: priority.id },
      { includeRetired: true },
    ),
    offerRows: offerRowIds(await listOfferDecisions(state.store)),
  };
  for (const selection of preview.selections) {
    if (selection.kind !== 'gain') continue;
    await addPreviewLeg(state, preview, selection);
  }
  return preview;
}

async function addPreviewLeg(
  state: ServerState,
  preview: GoalTargetPreview,
  selection: GoalGainMetric,
): Promise<void> {
  const blocked = blockingRow(preview.stored, selection, preview.offerRows);
  if (blocked !== null) {
    preview.skipped.push(blocked);
    return;
  }
  const derived = await deriveTarget(state, preview.derivation, selection);
  if (!('band' in derived)) {
    preview.skipped.push(derived);
    return;
  }
  const entry = previewEntry(derived, preview.derivation);
  if (selection.role === 'context') {
    preview.contextTargets.push(entry);
    return;
  }
  preview.legs.push({ selection, derived, entry });
}

async function proposeTargets(
  state: ServerState,
  input: z.infer<typeof GoalProposeTargetsInput>,
): Promise<ProposeTargetsResult> {
  const priority = await findPriority(state, input.priorityId);
  const preview = await previewTargets(state, priority);
  const targets: ProposedTarget[] = [];
  for (const leg of preview.legs) {
    const row = await state.store.putGoalTarget(
      toStoredTarget(
        leg.derived,
        preview,
        reusableId(preview.stored, leg.selection),
        await chapterStamp(state, leg.derived),
      ),
    );
    targets.push({ targetId: row.id, acceptedBy: null, ...leg.entry });
  }
  return {
    priorityId: preview.priorityId,
    targets,
    context: preview.contextTargets,
    skipped: preview.skipped,
    selections: preview.selections,
    horizonWeeks: preview.horizonWeeks,
    notes: preview.notes,
    recalibrationOffers: await reconcileRecalibrationOffers(state, [priority.id]),
    ...(await readUnreviewed(state.store)),
  };
}

/**
 * VW-361: `newChapterAt` is a STAMP taken from `exercise_chapters` at
 * derivation, the same way `sessions.diet_phase` stamps `diet_phases`. The
 * table is the one source of truth — this column exists so a target still
 * reports the boundary its numbers were derived under after a later
 * declaration moves it.
 */
async function chapterStamp(state: ServerState, derived: DerivedTarget): Promise<string | null> {
  if (derived.exerciseId === null) return null;
  return state.store.chapterStartedAt(LOCAL_USER_ID, derived.exerciseId);
}

/**
 * Why a metric gets no new proposal: the lifter already accepted a target for
 * it, or they declined one and a declined proposal is never re-offered
 * (audit:308).
 */
function blockingRow(
  stored: readonly StoredGoalTarget[],
  selection: GoalGainMetric,
  offerRows: ReadonlySet<string>,
): SkippedMetric | null {
  const matching = stored.filter((row) => sameLeg(row, selection) && !offerRows.has(row.id));
  const accepted = matching.find(
    (row) => row.acceptedBy !== undefined && row.retiredAt === undefined,
  );
  if (accepted !== undefined) {
    return {
      metric: selection.metric,
      exerciseId: selection.exerciseId,
      reason:
        `Target ${accepted.id} is already accepted and its numbers are fixed. Retire it with an ` +
        'outcome, or stamp a new chapter, before a new band is derived for this metric.',
    };
  }
  const declined = matching.find(
    (row) => row.acceptedBy === undefined && row.outcome === 'abandoned',
  );
  if (declined === undefined) return null;
  return {
    metric: selection.metric,
    exerciseId: selection.exerciseId,
    reason:
      `A proposal for this metric was declined (target ${declined.id}) and a declined proposal is ` +
      'never re-offered. Declare the priority again if you want it reconsidered.',
  };
}

/** A live proposal for the same leg is re-derived in place rather than duplicated. */
function reusableId(
  stored: readonly StoredGoalTarget[],
  selection: GoalGainMetric,
): string | undefined {
  return stored.find(
    (row) => sameLeg(row, selection) && row.acceptedBy === undefined && row.retiredAt === undefined,
  )?.id;
}

function sameLeg(row: StoredGoalTarget, selection: GoalGainMetric): boolean {
  return row.metric === selection.metric && (row.exerciseId ?? null) === selection.exerciseId;
}

function previewEntry(derived: DerivedTarget, context: GoalDerivationContext): PreviewedTarget {
  const startingRamp = proposedStartingRamp(derived);
  return {
    metric: derived.metric,
    exerciseId: derived.exerciseId,
    anchorReps: derived.anchorReps,
    startValue: derived.startValue,
    startMeasuredAt: derived.startMeasuredAt,
    matchedSessionCount: derived.matchedSessionCount,
    bandLowPctPerWeek: derived.band.bandLowPctPerWeek,
    bandHighPctPerWeek: derived.band.bandHighPctPerWeek,
    committedValue: derived.band.committedValue,
    stretchValue: derived.band.stretchValue,
    basis: derived.band.basis,
    infoLevel: derived.band.infoLevel,
    tierUsed: context.tier,
    tierProvisional: context.tierProvisional,
    dietPhaseAtDerivation: context.dietState.phase,
    provisional: derived.band.provisional,
    rpIds: citedRpIds(derived.band),
    notes: derived.band.notes,
    ...(startingRamp === undefined ? {} : { startingRamp }),
  };
}

/**
 * The rp ids the band itself cited, plus the one behind the committed edge.
 * Read out of the notes rather than listed here, so the ids reported are
 * exactly the ones the derivation used.
 */
function citedRpIds(band: GoalBand): string[] {
  const cited = band.notes.flatMap((note) => note.match(/rp:[a-z0-9-]+/g) ?? []);
  return [...new Set([...COMMITTED_EDGE_RP_IDS, ...cited])];
}

function toStoredTarget(
  derived: DerivedTarget,
  preview: Pick<GoalTargetPreview, 'derivation' | 'frame'>,
  id: string | undefined,
  newChapterAt: string | null,
): StoredGoalTarget {
  const context = preview.derivation;
  const frame = preview.frame;
  return {
    id: id ?? randomUUID(),
    priorityId: context.priorityId,
    metric: derived.metric,
    ...(derived.exerciseId !== null ? { exerciseId: derived.exerciseId } : {}),
    ...(derived.anchorReps !== null ? { anchorReps: derived.anchorReps } : {}),
    startValue: derived.startValue,
    startMeasuredAt: derived.startMeasuredAt,
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
    endsAt: frame?.endsAt ?? blockEndsAt(derived.startMeasuredAt, context.horizonWeeks),
    ...(frame === null ? {} : { blockId: frame.blockId }),
    ...(newChapterAt !== null ? { newChapterAt } : {}),
  };
}

// --- goal.accept_target ---

export interface AcceptTargetResult {
  target: StoredGoalTarget;
  acceptedBy: string;
  acknowledgedStretch: boolean;
  bandUnchanged: true;
  rpIds: string[];
  note: string;
  /** A cold lift target: the generic starting ramp, re-proposed after calibration (VW-444). */
  startingRamp?: StartingRampNotice;
  /** Present when this acceptance answered a recalibration offer: the ramp it retired. */
  recalibration?: { decisionId: string; supersededTargetId: string };
}

async function acceptTarget(
  state: ServerState,
  input: z.infer<typeof GoalAcceptTargetInput>,
): Promise<AcceptTargetResult> {
  const target = await findTarget(state, input.targetId);
  assertAcceptable(target);
  assertAnchorLoadApplies(target, input.anchorLoad);
  const offer = await liveOffer(state, target);
  const committed = input.committedValue ?? target.committedValue;
  const stretch = input.stretchValue ?? target.stretchValue;
  const custom = input.committedValue !== undefined || input.stretchValue !== undefined;
  const outside = assertInsideBand(target, committed, stretch, input.acknowledgeStretch === true);
  const saved = await state.store.putGoalTarget({
    ...target,
    ...(await blockStampFor(state, target)),
    committedValue: committed,
    stretchValue: stretch,
    ...(input.anchorLoad === undefined ? {} : { anchorLoad: input.anchorLoad }),
    acceptedBy: custom ? 'user' : 'coach-default',
    acknowledgedStretch: outside,
  });
  if (offer === undefined) return acceptedResult(saved);
  const supersededTargetId = await completeOffer(state, offer, saved.id);
  return { ...acceptedResult(saved), recalibration: { decisionId: offer.id, supersededTargetId } };
}

/**
 * A proposal written before targets carried a block gets one at acceptance (VW-477): the same
 * block a new proposal would be set for, and that block's end. A target that has one keeps it.
 */
async function blockStampFor(
  state: ServerState,
  target: StoredGoalTarget,
): Promise<Pick<StoredGoalTarget, 'blockId' | 'endsAt'> | Record<string, never>> {
  if (target.blockId !== undefined) return {};
  const priority = (await state.store.listPriorities(LOCAL_USER_ID)).find(
    (row) => row.id === target.priorityId,
  );
  if (priority === undefined) return {};
  const today = todayLocal();
  const frame = await goalBlockFrame(
    state.store,
    await targetBlockId(state.store, priority, today),
    today,
  );
  return frame === null ? {} : { blockId: frame.blockId, endsAt: frame.endsAt };
}

function acceptedResult(saved: StoredGoalTarget): AcceptTargetResult {
  const startingRamp = acceptedStartingRamp(saved);
  return {
    target: saved,
    acceptedBy: saved.acceptedBy ?? 'coach-default',
    acknowledgedStretch: saved.acknowledgedStretch,
    bandUnchanged: true,
    rpIds: COMMITTED_EDGE_RP_IDS,
    note:
      'Accepted and now fixed: these numbers do not move again. The band itself is unchanged — ' +
      'accepting a value past its edge never re-draws the projection to match (B55).',
    ...(startingRamp === undefined ? {} : { startingRamp }),
  };
}

/**
 * The open recalibration offer this row answers, re-checked now (VW-444). An
 * offer whose evidence went backwards is withdrawn and refused rather than
 * accepted on stale calibration; one whose starting ramp is already gone is
 * accepted as an ordinary proposal.
 */
async function liveOffer(
  state: ServerState,
  target: StoredGoalTarget,
): Promise<StoredAdvisoryDecision | undefined> {
  const open = await findOpenOffer(state, target.id);
  if (open === undefined) return undefined;
  const check = await checkOffer(state, open, target);
  if (check === 'live') return open;
  if (check === 'orphaned') return undefined;
  throw new ToolError(
    'GOAL_RECALIBRATION_WITHDRAWN',
    `The recalibration offer ${target.id} was withdrawn: the lift is no longer calibrated, so ` +
      'the accepted starting ramp stays. It is offered again once calibration returns.',
  );
}

function assertAcceptable(target: StoredGoalTarget): void {
  if (target.retiredAt !== undefined) {
    throw new ToolError(
      'GOAL_TARGET_RETIRED',
      `goal target ${target.id} was retired on ${target.retiredAt}; propose a new one.`,
    );
  }
  if (target.acceptedBy !== undefined) {
    throw new ToolError(
      'GOAL_TARGET_FIXED',
      `goal target ${target.id} was already accepted; its numbers cannot change. Retire it with ` +
        'an outcome, or stamp a new chapter, and derive a new target.',
    );
  }
}

/** Only a `reps_at_load` target counts its reps at a fixed load (VW-399). */
function assertAnchorLoadApplies(target: StoredGoalTarget, anchorLoad: number | undefined): void {
  if (anchorLoad === undefined || target.metric === 'reps_at_load') return;
  throw new ToolError(
    'GOAL_ANCHOR_LOAD_NOT_APPLICABLE',
    `goal target ${target.id} tracks ${target.metric}; anchorLoad only applies to reps_at_load.`,
  );
}

/**
 * Values outside the proposed band. Past the stretch edge is allowed WITH an
 * acknowledgement — the lifter may reach past what the evidence supports as
 * long as they are told they are doing it. Short of the committed edge is
 * refused outright: that edge is already the conservative one
 * (rp:rp-s10-underpromise-overdeliver-goal-setting), and a target below it
 * would be one nothing could fail to meet.
 *
 * Returns whether the acceptance went past the stretch edge, which is what
 * `acknowledgedStretch` records.
 */
function assertInsideBand(
  target: StoredGoalTarget,
  committed: number,
  stretch: number,
  acknowledged: boolean,
): boolean {
  const beyond = [committed, stretch].map((value) => bandPosition(target, value));
  if (beyond.includes('below')) {
    throw new ToolError(
      'GOAL_TARGET_BELOW_BAND',
      `A value short of the committed edge (${target.committedValue}) is refused: that edge is ` +
        'already the conservative one, so a target under it is one you cannot fail to meet.',
    );
  }
  const above = beyond.includes('above');
  if (above && !acknowledged) {
    throw new ToolError(
      'GOAL_TARGET_ABOVE_BAND',
      `A value past the stretch edge (${target.stretchValue}) needs acknowledgeStretch: the ` +
        'evidence does not support it, and the band is not re-drawn to make it look supported (B55).',
    );
  }
  return above;
}

/** Where a value sits relative to the band, in the band's own direction. */
function bandPosition(target: StoredGoalTarget, value: number): 'below' | 'inside' | 'above' {
  const [low, high] = [target.committedValue, target.stretchValue];
  const rising = high >= low;
  if (rising) {
    if (value < low) return 'below';
    return value > high ? 'above' : 'inside';
  }
  if (value > low) return 'below';
  return value < high ? 'above' : 'inside';
}

// --- goal.list / goal.retire / goal.new_chapter ---

export interface GoalListEntry {
  priority: StoredPriority;
  targets: StoredGoalTarget[];
}

async function listGoals(
  state: ServerState,
  input: z.infer<typeof GoalListInput>,
): Promise<{ priorities: GoalListEntry[] }> {
  const options = { includeRetired: input.includeRetired === true };
  const priorities = await state.store.listPriorities(LOCAL_USER_ID, options);
  const entries: GoalListEntry[] = [];
  for (const priority of priorities) {
    entries.push({
      priority,
      targets: await state.store.listGoalTargets({ priorityId: priority.id }, options),
    });
  }
  return { priorities: entries };
}

export interface RetireGoalResult {
  priority: StoredPriority | null;
  targets: StoredGoalTarget[];
  cascaded: number;
  /** True when the retired row was an open recalibration offer, now recorded as declined (VW-444). */
  declinedOffer?: boolean;
}

async function retireGoal(
  state: ServerState,
  input: z.infer<typeof GoalRetireInput>,
): Promise<RetireGoalResult> {
  const retiredAt = new Date().toISOString();
  if ((input.priorityId === undefined) === (input.targetId === undefined)) {
    throw new ToolError(
      'INVALID_INPUT',
      'Pass exactly one of priorityId or targetId: retiring a priority cascades to its targets, ' +
        'and retiring one target leaves the priority live.',
    );
  }
  if (input.targetId !== undefined) {
    const target = await state.store.retireGoalTarget(input.targetId, input.outcome, retiredAt);
    if (target === undefined) throw notFound('goal target', input.targetId);
    const declinedOffer = await declineOfferFor(state, target.id);
    await withdrawOffersFor(state, [target.id]);
    return { priority: null, targets: [target], cascaded: 0, declinedOffer };
  }
  const priorityId = input.priorityId as string;
  const priority = await state.store.retirePriority(priorityId, retiredAt);
  if (priority === undefined) throw notFound('priority', priorityId);
  const targets = await state.store.listGoalTargets({ priorityId }, { includeRetired: true });
  const cascaded = targets.filter((target) => target.retiredAt === retiredAt).length;
  await applyOutcome(state, targets, input.outcome, retiredAt);
  await withdrawOffersFor(
    state,
    targets.map((target) => target.id),
  );
  return { priority, targets: await refreshTargets(state, priorityId), cascaded };
}

/**
 * The cascade marks its targets `'abandoned'`, which is right when the
 * priority simply went away. A caller who says the priority was MET or MISSED
 * is stating something about the work, so the targets it just retired are
 * restamped with that outcome.
 */
async function applyOutcome(
  state: ServerState,
  targets: readonly StoredGoalTarget[],
  outcome: 'met' | 'missed' | 'abandoned',
  retiredAt: string,
): Promise<void> {
  if (outcome === 'abandoned') return;
  for (const target of targets.filter((row) => row.retiredAt === retiredAt)) {
    await state.store.putGoalTarget({ ...target, outcome });
  }
}

async function refreshTargets(state: ServerState, priorityId: string): Promise<StoredGoalTarget[]> {
  return state.store.listGoalTargets({ priorityId }, { includeRetired: true });
}

/**
 * VW-361: the declaration goes into `exercise_chapters` and the target's own
 * `newChapterAt` is the STAMP of it, never a second source of truth. Which is
 * why a target with no exercise behind it is refused: a chapter is a statement
 * about a MOVEMENT, and there is no bodyweight technique to reform.
 */
async function startNewChapter(
  state: ServerState,
  input: z.infer<typeof GoalNewChapterInput>,
): Promise<{ target: StoredGoalTarget; chapterId: string; note: string }> {
  const at = input.at ?? new Date().toISOString();
  const existing = await findTarget(state, input.targetId);
  if (existing.exerciseId === undefined) {
    throw new ToolError(
      'INVALID_INPUT',
      `Target ${input.targetId} tracks ${existing.metric}, which has no movement to reform. ` +
        'A new chapter is declared per exercise; use exercise.mark_new_chapter directly.',
    );
  }
  const chapter = await state.store.markExerciseChapter({
    userId: LOCAL_USER_ID,
    exerciseId: existing.exerciseId,
    startedAt: at,
    declaredAt: new Date().toISOString(),
  });
  const target = await state.store.setGoalTargetNewChapter(input.targetId, at);
  if (target === undefined) throw notFound('goal target', input.targetId);
  return {
    target,
    chapterId: chapter.id,
    note:
      'New chapter stamped. The target’s numbers are unchanged — this records that the movement ' +
      'behind them changed, so the comparable series restarts here rather than reading as a drop. ' +
      `Every read of ${existing.exerciseId} now clamps to this boundary; ` +
      'exercise.retire_chapter undoes it.',
  };
}

async function findPriority(state: ServerState, id: string): Promise<StoredPriority> {
  const priorities = await state.store.listPriorities(LOCAL_USER_ID, { includeRetired: true });
  const priority = priorities.find((row) => row.id === id);
  if (priority === undefined) throw notFound('priority', id);
  if (priority.retiredAt !== undefined) {
    throw new ToolError(
      'PRIORITY_RETIRED',
      `priority ${id} was retired on ${priority.retiredAt}; declare it again to track it.`,
    );
  }
  return priority;
}

async function findTarget(state: ServerState, id: string): Promise<StoredGoalTarget> {
  const targets = await state.store.listGoalTargets(
    { userId: LOCAL_USER_ID },
    { includeRetired: true },
  );
  const target = targets.find((row) => row.id === id);
  if (target === undefined) throw notFound('goal target', id);
  return target;
}

function notFound(what: string, id: string): ToolError {
  return new ToolError('NOT_FOUND', `No ${what} with id "${id}" exists.`);
}
