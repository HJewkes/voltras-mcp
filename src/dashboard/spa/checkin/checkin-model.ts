/**
 * The weekly check-in flow as pure data (VW-846 S1): the steps, the week pin, the bodyweight
 * unit conversion, how a review result picks the next step, how an error picks a step state,
 * and when a retry may reuse an action id. No React, no fetch, no clock: callers pass `now`.
 */
import { ActionRefusedError, IndeterminateWriteError } from '../api-client.js';
import { KG_PER_LB, type MassUnit } from '../live-page/mass.js';

export type CheckinStep = 'bodyweight' | 'weekly_checkin' | 'weekly_review' | 'done';

export const CHECKIN_STEPS: readonly CheckinStep[] = [
  'bodyweight',
  'weekly_checkin',
  'weekly_review',
  'done',
];

/** `flowStep` values the posts carry. */
export type CheckinFlowStep =
  | 'bodyweight'
  | 'weekly_checkin'
  | 'weekly_review'
  | 'weekly_review_answer';

/** The step after `step`; `done` is last. */
export function nextStep(step: CheckinStep): CheckinStep {
  const index = CHECKIN_STEPS.indexOf(step);
  return CHECKIN_STEPS[Math.min(index + 1, CHECKIN_STEPS.length - 1)];
}

function twoDigits(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * The most recent Sunday on or before `now`, as a local-calendar `YYYY-MM-DD`. A browser copy of
 * the server's rule, so a run pinned at mount names the same week the tools default to. Walks
 * back by the local day of week, so Saturday night stays in its week and Sunday 00:00 starts the
 * next one.
 */
export function mostRecentLocalSunday(now: Date): string {
  const sunday = new Date(now);
  sunday.setDate(now.getDate() - now.getDay());
  return `${sunday.getFullYear()}-${twoDigits(sunday.getMonth() + 1)}-${twoDigits(sunday.getDate())}`;
}

/** `checkin-<weekOf>-<suffix>`: one id for every post of a run. */
export function newFlowId(weekOf: string, suffix: string): string {
  return `checkin-${weekOf}-${suffix}`;
}

/** Entry value in the display unit to the stored pounds, rounded to 0.1. */
export function toPounds(value: number, unit: MassUnit): number {
  const lbs = unit === 'kg' ? value / KG_PER_LB : value;
  return Math.round(lbs * 10) / 10;
}

export const WEIGHT_WARN_RANGE_LBS = { min: 50, max: 700 } as const;
export const NOTE_MAX_CHARS = 500;

export type WeightCheck = { kind: 'invalid' } | { kind: 'ok'; lbs: number; warning: boolean };

/** Finite and positive blocks; outside the typo range only warns. */
export function checkWeight(value: number, unit: MassUnit): WeightCheck {
  if (!Number.isFinite(value) || value <= 0) return { kind: 'invalid' };
  const lbs = toPounds(value, unit);
  if (lbs <= 0) return { kind: 'invalid' };
  return {
    kind: 'ok',
    lbs,
    warning: lbs < WEIGHT_WARN_RANGE_LBS.min || lbs > WEIGHT_WARN_RANGE_LBS.max,
  };
}

/** The slice of `goal.weekly_review`'s result the flow reads. */
export interface ReviewResult {
  outcome: string;
  advisory: string | null;
  levers: readonly string[];
  notes: readonly string[];
  proposal: { userResponse: string | null } | null;
}

const GAP_OUTCOMES: ReadonlySet<string> = new Set([
  'no_declared_diet_phase',
  'no_accepted_bodyweight_target',
]);

export type ReviewView =
  | { kind: 'gap'; notes: readonly string[] }
  | { kind: 'no_proposal'; notes: readonly string[] }
  | { kind: 'answered'; userResponse: string }
  | { kind: 'open'; advisory: string; levers: readonly string[] };

/** Which of the four screens the review result calls for. */
export function viewOfReview(result: ReviewResult): ReviewView {
  if (GAP_OUTCOMES.has(result.outcome)) return { kind: 'gap', notes: result.notes };
  if (result.proposal === null) return { kind: 'no_proposal', notes: result.notes };
  if (result.proposal.userResponse !== null) {
    return { kind: 'answered', userResponse: result.proposal.userResponse };
  }
  return { kind: 'open', advisory: result.advisory ?? '', levers: result.levers };
}

/** Everything but `open` has nothing left to ask, so the flow goes to Done. */
export function stepAfterReview(view: ReviewView): CheckinStep {
  return view.kind === 'open' ? 'weekly_review' : 'done';
}

export type StepError =
  | { kind: 'invalid_input'; message: string }
  | { kind: 'rerun_review' }
  | { kind: 'already_answered' }
  | { kind: 'refused'; code: string }
  | { kind: 'indeterminate' }
  | { kind: 'not_saved' };

/** Map what a post threw to the state the step shows; the user stays on the step either way. */
export function stepErrorOf(err: unknown): StepError {
  if (err instanceof ActionRefusedError) {
    if (err.code === 'invalid_input') return { kind: 'invalid_input', message: err.message };
    if (err.code === 'NO_OPEN_ADVISORY') return { kind: 'rerun_review' };
    if (err.code === 'ADVISORY_ALREADY_ANSWERED') return { kind: 'already_answered' };
    return { kind: 'refused', code: err.code };
  }
  if (err instanceof IndeterminateWriteError) return { kind: 'indeterminate' };
  return { kind: 'not_saved' };
}

/**
 * One action id per step attempt. `idFor` returns the held id while the input is unchanged
 * (Retry), and mints a new one when it differs (an edit), because the server refuses the same
 * id with other input.
 */
export interface AttemptIds {
  idFor(step: CheckinFlowStep, input: unknown): string;
  /**
   * End the attempt at `step`: the next `idFor` mints. Called once a post has a settled outcome
   * (success or a tool refusal), because the server stores that outcome under the id and would
   * replay it, a stale review or a refusal, for a repeat of the same input.
   */
  forget(step: CheckinFlowStep): void;
}

export function createAttemptIds(mint: () => string): AttemptIds {
  const held = new Map<CheckinFlowStep, { key: string; id: string }>();
  return {
    idFor(step, input) {
      const key = JSON.stringify(input);
      const current = held.get(step);
      if (current?.key === key) return current.id;
      const id = mint();
      held.set(step, { key, id });
      return id;
    },
    forget(step) {
      held.delete(step);
    },
  };
}

/** Mints `measuredAt` on first use and returns the same instant after, so a retry corrects, not adds. */
export function createMeasuredAtPin(now: () => Date): () => string {
  let pinned: string | null = null;
  return () => (pinned ??= now().toISOString());
}
