// `goal.weekly_review` (VW-376, research W5): the bodyweight-rate advisory
// wired into the goal coach as a RE-PROPOSAL at the Sunday tick.
//
// SOURCE OF RECORD: the VW-367 bodyweight-rate methodology note (2026-09-13)
// §2b-2c, §4 and §5 row W5, plus goal-coach plan v2 §2c. Named by ticket
// rather than by path, the way `bodyweight-rate-advisory.ts` and
// `bodyweight-trend.ts` already do.
//
// WHY A NEW `goal.*` TOOL AND NOT AN EXISTING SURFACE. The Sunday sitting the
// plan names (v2 §5 row G12') is a HUMAN step, not a tool, and the only other
// Sunday-anchored code is `accountability.*` — which owns the check-in message
// cadence and is classified `read`, sends nothing and writes nothing. Folding
// a proposal writer into it would break that classification. This belongs to
// the coach's own namespace: it reads the goal target it judges against, and
// the only row it writes is the proposal.
//
// WHAT IT NEVER TOUCHES. It never writes `diet_phases` — the phase is an
// OBSERVED record the lifter declares with `profile.set_diet_phase`
// (`store/diet-phase.ts`), and a coach that could restate it would be
// inventing the fact it is judging. It never writes `goal_targets` either:
// the committed line on the chart is the one that was accepted, and a rate
// re-proposal is a NEW proposal beside it, never an edit of it (methodology
// §4; plan v2 §1.7, B55).

import type { z } from 'zod';

import {
  computeBodyweightRateAdvisory,
  type BodyweightRateAdvisory,
  type BodyweightRateOutcome,
  type WeeklySelfReport,
} from '../analytics/bodyweight-rate-advisory.js';
import {
  readingsAsOf,
  type BodyweightReading,
  type BodyweightTargetLine,
} from '../analytics/bodyweight-trend.js';
import type { GoalWeeklyReviewInput } from '../schemas/goal.js';
import type { ServerState } from '../state/server-state.js';
import type { DietPhase, RecompMode } from '../store/diet-phase.js';
import {
  LOCAL_USER_ID,
  type SessionStore,
  type StoredAdvisoryDecision,
  type StoredAdvisoryResponse,
  type StoredGoalTarget,
} from '../store/types.js';
import { readDietPhaseState } from './diet-phase-state.js';
import { mostRecentSundayIso, readWeeklyCheckin, type WeeklyCheckin } from './profile-tools.js';

/** The advisory this tool issues, in `advisory_decisions.code`. */
export const BODYWEIGHT_RATE_ADVISORY_CODE = 'bodyweight_rate_reproposal';

/** Bumped when the loop below changes, so old answers stay re-scorable. */
export const BODYWEIGHT_RATE_ADVISORY_VERSION = 'bodyweight-rate-advisory@1.0.0';

const DAY_MS = 24 * 60 * 60 * 1000;

class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ToolError';
  }
}

/** Two gaps of this tool's own, beside the advisory module's own outcomes. */
export type WeeklyReviewOutcome =
  | BodyweightRateOutcome
  | 'no_declared_diet_phase'
  | 'no_accepted_bodyweight_target';

export interface WeeklyReviewProposal {
  decisionId: string;
  issuedAt: string;
  verdict: string;
  userResponse: StoredAdvisoryResponse | null;
}

export interface WeeklyReviewResponse {
  decisionId: string;
  userResponse: StoredAdvisoryResponse;
  respondedAt: string;
}

export interface WeeklyReviewResult {
  weekOf: string;
  reviewedAt: string;
  outcome: WeeklyReviewOutcome;
  dietPhase: string;
  recompMode: RecompMode | null;
  checkin: WeeklyCheckin | null;
  readingCount: number;
  targetId: string | null;
  committedValue: number | null;
  stretchValue: number | null;
  committedUnchanged: true;
  advisory: string | null;
  levers: readonly string[];
  observation: BodyweightRateAdvisory['observation'] | null;
  vetoes: BodyweightRateAdvisory['vetoes'];
  offCadenceConditions: BodyweightRateAdvisory['offCadenceConditions'];
  confounders: readonly string[];
  lowConfidence: boolean;
  proposal: WeeklyReviewProposal | null;
  suppressedByDecline: boolean;
  response: WeeklyReviewResponse | null;
  notes: string[];
}

/** The reads one review runs on, assembled once. */
/** The reads the rate loop makes, and nothing it writes: what the goals page can also supply. */
export interface WeeklyReviewReadState {
  store: Pick<
    SessionStore,
    | 'getDietPhaseCovering'
    | 'listGoalTargets'
    | 'listBodyMetrics'
    | 'getSelfReportsForUser'
    | 'listAdvisoryDecisions'
  >;
}

interface ReviewContext {
  weekOf: string;
  reviewedAt: string;
  phase: DietPhase;
  recompMode: RecompMode | null;
  phaseStartedAt: string;
  readings: BodyweightReading[];
  checkin: WeeklyCheckin | null;
  target: StoredGoalTarget;
}

/**
 * `goal.weekly_review` — run the rate loop for one week, and record what the
 * lifter answers about it.
 */
export async function runWeeklyReview(
  state: ServerState,
  input: z.infer<typeof GoalWeeklyReviewInput>,
): Promise<WeeklyReviewResult> {
  const now = new Date();
  const weekOf = input.weekOf ?? mostRecentSundayIso(now);
  const reviewedAt = reviewInstant(weekOf, now);
  const response =
    input.response === undefined
      ? null
      : await recordResponse(state, weekOf, input.response, reviewedAt);
  const context = await readContext(state, weekOf, reviewedAt);
  if ('gap' in context) return { ...emptyResult(weekOf, reviewedAt, response), ...context.gap };
  return review(state, context, response);
}

/**
 * The instant the trend is computed as of: now, or the end of `weekOf` when a
 * past week is being reviewed. A back-dated review must not read a series the
 * week it is judging had not produced yet.
 */
function reviewInstant(weekOf: string, now: Date): string {
  const weekEnd = Date.parse(`${weekOf}T00:00:00.000Z`) + 7 * DAY_MS;
  return new Date(Math.min(now.getTime(), weekEnd)).toISOString();
}

/**
 * The advisory `goal.weekly_review` computes for the week containing `now`,
 * without recording anything. `null` when there is no declared phase or no
 * accepted bodyweight target, the two gaps the tool reports instead.
 */
export async function readBodyweightRateAdvisory(
  state: WeeklyReviewReadState,
  now: Date,
): Promise<BodyweightRateAdvisory | null> {
  const weekOf = mostRecentSundayIso(now);
  const context = await readContext(state, weekOf, reviewInstant(weekOf, now));
  return 'gap' in context ? null : runAdvisory(state, context);
}

async function readContext(
  state: WeeklyReviewReadState,
  weekOf: string,
  reviewedAt: string,
): Promise<ReviewContext | { gap: Partial<WeeklyReviewResult> }> {
  const diet = await readDietPhaseState(state, reviewedAt);
  if (diet.phase === 'unknown' || diet.startedAt === undefined) {
    return { gap: noDeclaredPhase() };
  }
  const target = await findBodyweightTarget(state);
  if (target === null) return { gap: noAcceptedTarget(diet.phase) };
  const metrics = await state.store.listBodyMetrics(LOCAL_USER_ID);
  return {
    weekOf,
    reviewedAt,
    phase: diet.phase,
    recompMode: diet.recompMode ?? null,
    phaseStartedAt: diet.startedAt,
    readings: readingsAsOf(metrics, reviewedAt).map((row) => ({
      measuredAt: row.measuredAt,
      bodyweightLbs: row.bodyweightLbs,
    })),
    checkin: await readWeeklyCheckin(state, weekOf),
    target,
  };
}

function noDeclaredPhase(): Partial<WeeklyReviewResult> {
  return {
    outcome: 'no_declared_diet_phase',
    notes: [
      'No declared diet phase covers this review, so there is no rate to judge the scale against. ' +
        'Declare one with `profile.set_diet_phase`; it is never inferred from the weight series.',
    ],
  };
}

function noAcceptedTarget(phase: string): Partial<WeeklyReviewResult> {
  return {
    outcome: 'no_accepted_bodyweight_target',
    dietPhase: phase,
    notes: [
      'No accepted bodyweight target to judge the scale against. Derive one with ' +
        '`goal.propose_targets` and accept it with `goal.accept_target`: a proposal nobody ' +
        'answered is not a line anyone committed to.',
    ],
  };
}

/**
 * The accepted, live bodyweight target, newest derivation first. Only an
 * ACCEPTED one counts: the committed line this advisory is measured against
 * has to be one the lifter agreed to.
 */
async function findBodyweightTarget(
  state: WeeklyReviewReadState,
): Promise<StoredGoalTarget | null> {
  const targets = await state.store.listGoalTargets({ userId: LOCAL_USER_ID });
  return (
    targets.find(
      (row) =>
        row.metric === 'bodyweight' && row.acceptedBy !== undefined && row.retiredAt === undefined,
    ) ?? null
  );
}

/**
 * The goal line the trend is judged against: the accepted target's own start
 * value and its COMMITTED edge, converted from percent per week to lb per
 * week. The committed edge is the band's low edge (plan v2 §1.7), and reading
 * the stored row rather than re-deriving it is what keeps this advisory
 * measured against the line on the chart. For a slow-loss recomposition the
 * committed edge is 0 %/wk (VW-468), so the line is flat at the start weight and
 * the advisory takes the goal's direction from the band. Never the stretch edge:
 * against it a flat week, which keeps the commitment, would read behind.
 */
function targetLineFor(target: StoredGoalTarget): BodyweightTargetLine {
  return {
    startWeightLbs: target.startValue,
    weeklyRateLbs: (target.startValue * target.bandLowPctPerWeek) / 100,
  };
}

async function runAdvisory(
  state: WeeklyReviewReadState,
  context: ReviewContext,
): Promise<BodyweightRateAdvisory> {
  return computeBodyweightRateAdvisory({
    trend: {
      readings: context.readings,
      now: context.reviewedAt,
      phaseStartedAt: context.phaseStartedAt,
      targetLine: targetLineFor(context.target),
    },
    phase: context.phase,
    ...(context.recompMode !== null ? { recompMode: context.recompMode } : {}),
    lastProposalAt: await lastProposalBefore(state, context.weekOf),
    ...(context.checkin !== null ? { selfReport: toSelfReport(context.checkin) } : {}),
  });
}

async function review(
  state: ServerState,
  context: ReviewContext,
  response: WeeklyReviewResponse | null,
): Promise<WeeklyReviewResult> {
  const advisory = await runAdvisory(state, context);
  const emitted = await emit(state, context, advisory);
  return {
    ...emptyResult(context.weekOf, context.reviewedAt, response),
    outcome: advisory.outcome,
    dietPhase: context.phase,
    recompMode: context.recompMode,
    checkin: context.checkin,
    readingCount: context.readings.length,
    targetId: context.target.id,
    committedValue: context.target.committedValue,
    stretchValue: context.target.stretchValue,
    advisory: emitted.suppressedByDecline ? null : advisory.advisory,
    levers: advisory.levers,
    observation: advisory.observation,
    vetoes: advisory.vetoes,
    offCadenceConditions: advisory.offCadenceConditions,
    confounders: advisory.confounders,
    lowConfidence: advisory.lowConfidence,
    ...emitted,
  };
}

/** Nulls out the three-point scale's own nulls: the advisory takes absence. */
function toSelfReport(checkin: WeeklyCheckin): WeeklySelfReport {
  return {
    ...(checkin.hunger !== null ? { hunger: checkin.hunger } : {}),
    ...(checkin.dietPlanAdherence !== null ? { dietPlanAdherence: checkin.dietPlanAdherence } : {}),
    ...(checkin.sleepQuality !== null ? { sleepQuality: checkin.sleepQuality } : {}),
  };
}

/**
 * THE CADENCE CLOCK RUNS BETWEEN SITTINGS, NOT WITHIN ONE. Only proposals
 * issued before this week's anchor advance it, so re-running the review on the
 * same Sunday re-derives the same advisory rather than aging itself out of the
 * half-week floor. Repeats inside one week are deduplicated by the
 * observation key instead (see {@link observationKey}).
 */
async function lastProposalBefore(
  state: WeeklyReviewReadState,
  weekOf: string,
): Promise<string | null> {
  const rows = await listDecisions(state);
  const anchor = `${weekOf}T00:00:00.000Z`;
  return rows.find((row) => row.issuedAt < anchor)?.issuedAt ?? null;
}

function listDecisions(state: WeeklyReviewReadState): Promise<StoredAdvisoryDecision[]> {
  return state.store.listAdvisoryDecisions(LOCAL_USER_ID, {
    code: BODYWEIGHT_RATE_ADVISORY_CODE,
  });
}

/**
 * WHAT "THE SAME OBSERVATION" MEANS: the same week anchor and the same urgency
 * band. A declined proposal is never re-emitted for that pair, so re-running
 * the review on the same Sunday says nothing further; the next week is a new
 * anchor, and a signal that worsens inside the same week crosses into a new
 * band. The rank is RP's own 0-10 / 10-20 / 20-40 percent sizing bands used
 * ONLY to order urgency (methodology §2b, human decision item 1), so it stays
 * inside `inputs_json` and is never surfaced as a number.
 */
function observationKey(weekOf: string, urgencyRank: number): string {
  return `${weekOf}#${String(urgencyRank)}`;
}

interface EmitResult {
  proposal: WeeklyReviewProposal | null;
  suppressedByDecline: boolean;
  notes: string[];
}

/**
 * Record the proposal, unless there is none to record or the lifter already
 * declined this observation. A vetoed week emits no text and so writes
 * nothing: a proposal nobody made is not a row.
 */
async function emit(
  state: ServerState,
  context: ReviewContext,
  advisory: BodyweightRateAdvisory,
): Promise<EmitResult> {
  if (advisory.advisory === null) return { proposal: null, suppressedByDecline: false, notes: [] };
  const key = observationKey(context.weekOf, advisory.urgencyRank);
  const existing = (await listDecisions(state)).filter((row) => row.inputs.observationKey === key);
  const declined = existing.find((row) => row.userResponse === 'declined');
  if (declined !== undefined) {
    return {
      proposal: null,
      suppressedByDecline: true,
      notes: [
        'You already declined this week’s rate proposal at this urgency, so it is not raised ' +
          'again. It can return next week, or sooner if the signal crosses into a wider band.',
      ],
    };
  }
  return { proposal: await write(state, context, advisory, existing[0], key), ...blank() };
}

function blank(): { suppressedByDecline: boolean; notes: string[] } {
  return { suppressedByDecline: false, notes: [] };
}

/**
 * One row per observation: a repeat of the same week at the same urgency
 * updates the row that fired rather than adding a second one, and keeps the
 * answer already on it.
 */
async function write(
  state: ServerState,
  context: ReviewContext,
  advisory: BodyweightRateAdvisory,
  existing: StoredAdvisoryDecision | undefined,
  key: string,
): Promise<WeeklyReviewProposal> {
  const saved = await state.store.putAdvisoryDecision({
    ...(existing !== undefined ? { id: existing.id } : {}),
    userId: LOCAL_USER_ID,
    code: BODYWEIGHT_RATE_ADVISORY_CODE,
    issuedAt: existing?.issuedAt ?? context.reviewedAt,
    inputs: {
      ...advisory.inputs,
      weekOf: context.weekOf,
      observationKey: key,
      targetId: context.target.id,
      committedValue: context.target.committedValue,
    },
    thresholds: advisory.thresholds,
    algorithmVersion: BODYWEIGHT_RATE_ADVISORY_VERSION,
    verdict: advisory.outcome,
    ...(existing?.userResponse !== undefined ? { userResponse: existing.userResponse } : {}),
    ...(existing?.respondedAt !== undefined ? { respondedAt: existing.respondedAt } : {}),
  });
  return {
    decisionId: saved.id,
    issuedAt: saved.issuedAt,
    verdict: saved.verdict,
    userResponse: saved.userResponse ?? null,
  };
}

/**
 * Answer the proposal this week's review raised. The answer rides the next
 * call of the issuing tool, exactly as `declineFatLossDowngrade` rides the
 * next `goal.declare_priorities` (VW-350) — one response path, one table, and
 * no tool that can answer an advisory it did not issue.
 */
async function recordResponse(
  state: ServerState,
  weekOf: string,
  response: StoredAdvisoryResponse,
  at: string,
): Promise<WeeklyReviewResponse> {
  const open = (await listDecisions(state)).find(
    (row) => row.inputs.weekOf === weekOf && row.userResponse === undefined,
  );
  if (open === undefined) {
    throw new ToolError(
      'NO_OPEN_ADVISORY',
      `No unanswered bodyweight-rate proposal for the week of ${weekOf}. Run ` +
        '`goal.weekly_review` without a `response` first: an answer is recorded against the ' +
        'proposal it answers, never on its own.',
    );
  }
  const saved = await state.store.putAdvisoryDecision({
    ...open,
    userResponse: response,
    respondedAt: at,
  });
  return {
    decisionId: saved.id,
    userResponse: response,
    respondedAt: saved.respondedAt ?? at,
  };
}

function emptyResult(
  weekOf: string,
  reviewedAt: string,
  response: WeeklyReviewResponse | null,
): WeeklyReviewResult {
  return {
    weekOf,
    reviewedAt,
    outcome: 'unevaluable',
    dietPhase: 'unknown',
    recompMode: null,
    checkin: null,
    readingCount: 0,
    targetId: null,
    committedValue: null,
    stretchValue: null,
    committedUnchanged: true,
    advisory: null,
    levers: ['intake', 'activity'],
    observation: null,
    vetoes: [],
    offCadenceConditions: [],
    confounders: [],
    lowConfidence: false,
    proposal: null,
    suppressedByDecline: false,
    response,
    notes: [],
  };
}
