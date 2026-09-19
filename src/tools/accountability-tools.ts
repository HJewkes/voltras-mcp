// `accountability.state` — a READ-ONLY window on the coach's protocol position
// (VW-286).
//
// Two things in one response: the persisted state (from `accountability_state`)
// and a DRY RUN of what the reducer would decide right now. The dry run writes
// nothing and sends nothing — there is no transport wired into this tool, by
// design: the scheduled job owns sending, this tool exists so a human can ask
// "why has the coach been quiet" and get the reason rather than a shrug.
//
// The adherence direction comes from `report.weekly`'s `WeeklyAdherence.trend`
// and never from a planned/done count: the escalation ladder is keyed to
// direction, and a raw count would let a bad week read as a trend.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import {
  composeGhostNudge,
  composeMissRecovery,
  composeRealignOpener,
  composeSundayAnchor,
} from '../accountability/composer.js';
import {
  initialAccountabilityState,
  reduceAccountability,
  PROACTIVE_WINDOW_MS,
} from '../accountability/state-machine.js';
import {
  fixedClock,
  type AccountabilityDecision,
  type AccountabilityEvent,
  type AccountabilityState,
  type AdherenceRead,
  type AdherenceTrend,
  type NextWorkoutRead,
  type ProactiveKind,
  type ProtocolState,
} from '../accountability/types.js';
import { AccountabilityPreviewInput, AccountabilityStateInput } from '../schemas/accountability.js';
import type { ServerState } from '../state/server-state.js';
import { LOCAL_USER_ID } from '../store/types.js';
import { wrapHandler } from './helpers.js';
import { nextWorkout as lookupNextWorkout } from './plan-tools.js';
import { buildWeeklyReport } from './report-tools.js';

const SUNDAY = 0;
const THURSDAY = 4;
const MONDAY = 1;
const TUESDAY = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * No profile field or session input carries the lifter's own display name
 * anywhere in the store (single local user, addressed directly) — a real gap,
 * not a placeholder standing in for something computable today.
 */
const LIFTER_NAME_PLACEHOLDER = 'You';

class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ToolError';
  }
}

export const ACCOUNTABILITY_STATE_DESCRIPTION =
  'READ-ONLY. Report the coach accountability protocol state for the owner and the decision the ' +
  'protocol would make right now, without writing anything and without sending anything. ' +
  'Returns `protocolState` (planned / completed / missed / ghosting / realign_needed / holding), ' +
  '`enteredAt`, `consecutiveMisses`, `lastInboundAt`, `holdingUntil`, `ghostSendsThisEpisode`, ' +
  '`proactiveSendsInWindow` (the rolling 7-day count the 2-message ceiling is enforced against), ' +
  '`persisted` (false when no row exists yet and the defaults are being shown), ' +
  '`evaluatedAt` (the instant the dry run was evaluated at), plus `tick` ' +
  '(`sunday_anchor` on a Sunday, `thursday` on a Thursday, `none` on every other day), ' +
  '`adherenceTrend` read from `report.weekly`, and `decision` — `{action, kind, reason}` where ' +
  '`action` is `send` or `silent` and `reason` always says why, including why it is silent. ' +
  'Pass `at` to evaluate the dry run as of another instant. No device traffic, no network.';

export const ACCOUNTABILITY_PREVIEW_DESCRIPTION =
  'READ-ONLY. Run the same dry evaluation as `accountability.state` and, when the decision is ' +
  '`send`, also render the coach message that decision would carry — from live reads (`report.weekly` ' +
  'adherence, `plan.next_workout`, the rolling 28-day training-day count), never from stored copy. Sends nothing ' +
  "and writes nothing. Returns `decision` (as `accountability.state`), `kind` (the decision's `kind`, " +
  'or null when the decision is silent), `text` (the rendered message, or null when silent or when ' +
  'the plan has nothing queued to render from), `inputsUsed` (the adherence, ' +
  '`rolling28DayTrainingDays` and ' +
  'next-workout values the render read, or null when nothing was rendered), and `evaluatedAt`. Pass ' +
  '`at` to evaluate as of another instant.';

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

export interface AccountabilityStateResult {
  protocolState: ProtocolState;
  enteredAt: string;
  consecutiveMisses: number;
  lastInboundAt: string | null;
  holdingUntil: string | null;
  ghostSendsThisEpisode: number;
  proactiveSendsInWindow: number;
  persisted: boolean;
  evaluatedAt: string;
  tick: 'sunday_anchor' | 'thursday' | 'none';
  adherenceTrend: AdherenceTrend | null;
  decision: AccountabilityDecision;
}

export function registerAccountabilityTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
  install(
    placeholders,
    'accountability.state',
    AccountabilityStateInput,
    wrapHandler(AccountabilityStateInput, (input) => describeAccountabilityState(state, input)),
    ACCOUNTABILITY_STATE_DESCRIPTION,
  );
  install(
    placeholders,
    'accountability.preview',
    AccountabilityPreviewInput,
    wrapHandler(AccountabilityPreviewInput, (input) => describeAccountabilityPreview(state, input)),
    ACCOUNTABILITY_PREVIEW_DESCRIPTION,
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
  tool.update({
    paramsSchema: schema.shape,
    callback: callback as never,
    description,
  } as never);
}

/** The persisted row (or its defaults), plus a dry evaluation, shared by both tools. */
interface DryRunEvaluation {
  current: AccountabilityState;
  persisted: boolean;
  now: Date;
  tick: AccountabilityStateResult['tick'];
  trend: AdherenceTrend | null;
  decision: AccountabilityDecision;
}

async function evaluateDryRun(
  state: ServerState,
  input: { at?: string | undefined },
): Promise<DryRunEvaluation> {
  const now = input.at === undefined ? new Date() : new Date(input.at);
  const stored = await state.store.getAccountabilityState(LOCAL_USER_ID);
  const current = stored ?? initialAccountabilityState(LOCAL_USER_ID, now);
  const tick = tickForDay(now);
  const trend = tick === 'thursday' ? await readAdherenceTrend(state) : null;
  return {
    current,
    persisted: stored !== undefined,
    now,
    tick,
    trend,
    decision: dryRunDecision(current, tick, trend, now),
  };
}

export async function describeAccountabilityState(
  state: ServerState,
  input: z.infer<typeof AccountabilityStateInput>,
): Promise<AccountabilityStateResult> {
  const evaluation = await evaluateDryRun(state, input);
  return {
    protocolState: evaluation.current.state,
    enteredAt: evaluation.current.enteredAt,
    consecutiveMisses: evaluation.current.consecutiveMisses,
    lastInboundAt: evaluation.current.lastInboundAt,
    holdingUntil: evaluation.current.holdingUntil,
    ghostSendsThisEpisode: evaluation.current.ghostSends.length,
    proactiveSendsInWindow: sendsInWindow(evaluation.current, evaluation.now),
    persisted: evaluation.persisted,
    evaluatedAt: evaluation.now.toISOString(),
    tick: evaluation.tick,
    adherenceTrend: evaluation.trend,
    decision: evaluation.decision,
  };
}

export interface AccountabilityPreviewInputsUsed {
  adherence: AdherenceRead | null;
  rolling28DayTrainingDays: number;
  nextWorkout: NextWorkoutRead | null;
}

export interface AccountabilityPreviewResult {
  decision: AccountabilityDecision;
  kind: ProactiveKind | null;
  text: string | null;
  inputsUsed: AccountabilityPreviewInputsUsed | null;
  evaluatedAt: string;
}

export async function describeAccountabilityPreview(
  state: ServerState,
  input: z.infer<typeof AccountabilityPreviewInput>,
): Promise<AccountabilityPreviewResult> {
  const evaluation = await evaluateDryRun(state, input);
  const evaluatedAt = evaluation.now.toISOString();
  if (evaluation.decision.action !== 'send') {
    return { decision: evaluation.decision, kind: null, text: null, inputsUsed: null, evaluatedAt };
  }
  const rendered = await renderDecision(
    state,
    evaluation.current,
    evaluation.decision.kind,
    evaluation.now,
  );
  return {
    decision: evaluation.decision,
    kind: evaluation.decision.kind,
    text: rendered.text,
    inputsUsed: rendered.inputsUsed,
    evaluatedAt,
  };
}

/**
 * Renders the composer output for a `send` decision from live reads. Never
 * called for `silent`: there is nothing to render and no read is owed.
 */
async function renderDecision(
  state: ServerState,
  current: AccountabilityState,
  kind: ProactiveKind,
  now: Date,
): Promise<{ text: string; inputsUsed: AccountabilityPreviewInputsUsed }> {
  const [report, nextWorkoutRead] = await Promise.all([
    buildWeeklyReport(state, { format: 'json', to: now.toISOString() }),
    readNextWorkout(state),
  ]);
  const inputsUsed: AccountabilityPreviewInputsUsed = {
    adherence: report.header.adherence,
    rolling28DayTrainingDays: report.header.rolling28DayTrainingDays,
    nextWorkout: nextWorkoutRead,
  };
  const text = composeForKind(kind, current, inputsUsed, now);
  return { text, inputsUsed };
}

function composeForKind(
  kind: ProactiveKind,
  current: AccountabilityState,
  inputs: AccountabilityPreviewInputsUsed,
  now: Date,
): string {
  switch (kind) {
    case 'sunday_anchor':
      return composeSundayAnchor({
        lifterName: LIFTER_NAME_PLACEHOLDER,
        adherence: inputs.adherence,
        rolling28DayTrainingDays: inputs.rolling28DayTrainingDays,
        nextWorkout: inputs.nextWorkout,
        // No slot/fallback-day configuration is persisted anywhere yet
        // (VW-236 lands the Sunday goal-setting sitting that will produce
        // one); rendering with none named is the honest state until then.
        slots: [],
        monthlyCommitmentReoffer: false,
      }).text;
    case 'miss_recovery': {
      const nextWorkoutRead = requireNextWorkout(inputs.nextWorkout);
      return composeMissRecovery({
        lifterName: LIFTER_NAME_PLACEHOLDER,
        missed: missedSessionFacts(current, nextWorkoutRead),
        nextWorkout: nextWorkoutRead,
        reEntryDay: weekdayName(new Date(now.getTime() + DAY_MS)),
        holding: holdingRead(current),
      }).text;
    }
    case 'ghost_nudge': {
      // Two templates cover four total sends (2 a week for 2 weeks):
      // ghostSends.length 0/1/2/3 cycles nudge 1/2/1/2, each standalone.
      const n: 1 | 2 = current.ghostSends.length % 2 === 0 ? 1 : 2;
      return composeGhostNudge(n, {
        lifterName: LIFTER_NAME_PLACEHOLDER,
        nextWorkout: inputs.nextWorkout,
      }).text;
    }
    case 'realign_opener':
      return composeRealignOpener({
        lifterName: LIFTER_NAME_PLACEHOLDER,
        adherence: inputs.adherence,
        rolling28DayTrainingDays: inputs.rolling28DayTrainingDays,
        slots: [],
      }).text;
  }
}

function requireNextWorkout(nextWorkoutRead: NextWorkoutRead | null): NextWorkoutRead {
  if (nextWorkoutRead === null) {
    throw new ToolError(
      'NO_NEXT_WORKOUT',
      'The plan has nothing queued to source a miss-recovery offer from.',
    );
  }
  return nextWorkoutRead;
}

/**
 * No persisted slot/fallback-day configuration exists yet (VW-236); the day
 * the miss was detected stands in for the planned day, and one named day
 * later stands in for its fallback — both a documented approximation, not a
 * lookup, until real per-day slots land.
 */
function missedSessionFacts(current: AccountabilityState, nextWorkoutRead: NextWorkoutRead) {
  const enteredAt = new Date(current.enteredAt);
  return {
    plannedDay: weekdayName(enteredAt),
    fallbackDay: weekdayName(new Date(enteredAt.getTime() + 2 * DAY_MS)),
    exerciseNames: nextWorkoutRead.exercises.map((exercise) => exercise.name),
  };
}

function holdingRead(current: AccountabilityState): { active: boolean; endDate?: string } {
  return {
    active: current.state === 'holding',
    ...(current.holdingUntil !== null ? { endDate: current.holdingUntil } : {}),
  };
}

function weekdayName(date: Date): string {
  return WEEKDAY_NAMES[date.getDay()];
}

async function readNextWorkout(state: ServerState): Promise<NextWorkoutRead | null> {
  const result = await lookupNextWorkout(state, {});
  if ('completed' in result) return null;
  return {
    templateName: result.template.name,
    exercises: result.plannedExercises.map((plannedExercise) => ({
      name: state.exercises.getById(plannedExercise.exerciseId)?.name ?? plannedExercise.exerciseId,
      ...(plannedExercise.targetWeightLbs !== undefined
        ? { targetWeightLbs: plannedExercise.targetWeightLbs }
        : {}),
    })),
  };
}

/**
 * The decision the reducer WOULD make, discarding the state it returns. On a
 * day with no scheduled tick there is no event to fold, and saying so is the
 * honest answer — the protocol is event-driven, not a daily cron.
 */
function dryRunDecision(
  current: AccountabilityState,
  tick: AccountabilityStateResult['tick'],
  trend: AdherenceTrend | null,
  now: Date,
): AccountabilityDecision {
  if (tick === 'none') {
    return {
      action: 'silent',
      reason:
        'no scheduled tick today: the Sunday anchor is the only fixed touch and the mid-week ' +
        'touch fires on a Thursday. Everything else is event-driven',
    };
  }
  const event: AccountabilityEvent =
    tick === 'sunday_anchor'
      ? { type: 'sunday_anchor_tick' }
      : {
          type: 'thursday_tick',
          earlyWeekMiss: enteredMissedOnMonOrTue(current),
          plannedSessionSkippedSinceSunday: current.state === 'missed',
          adherenceTrend: trend,
        };
  return reduceAccountability(current, event, fixedClock(now)).decision;
}

/**
 * The Thursday trigger needs "a Mon or Tue planned session is missed", and the
 * only thing the stored row knows is when it entered `missed`. A real tick gets
 * the flag from the caller, which knows the plan; this dry run derives it, so
 * a miss detected later in the week reads as no early-week miss.
 */
function enteredMissedOnMonOrTue(current: AccountabilityState): boolean {
  if (current.state !== 'missed') return false;
  const day = new Date(current.enteredAt).getDay();
  return day === MONDAY || day === TUESDAY;
}

async function readAdherenceTrend(state: ServerState): Promise<AdherenceTrend | null> {
  const report = await buildWeeklyReport(state, { format: 'json' });
  return report.header.adherence?.trend ?? null;
}

function tickForDay(now: Date): AccountabilityStateResult['tick'] {
  // Local weekday, because the lifter's week is local; the reducer itself is
  // timezone-agnostic and takes the tick as an event.
  const day = now.getDay();
  if (day === SUNDAY) return 'sunday_anchor';
  if (day === THURSDAY) return 'thursday';
  return 'none';
}

function sendsInWindow(current: AccountabilityState, now: Date): number {
  const cutoff = now.getTime() - PROACTIVE_WINDOW_MS;
  return current.proactiveSends.filter((s) => Date.parse(s.at) > cutoff).length;
}
