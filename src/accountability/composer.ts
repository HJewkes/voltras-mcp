// Renders the coach's five message templates (`copy.ts`) from structured
// inputs (VW-287). Pure: every function here takes facts and returns text.
//
// It never sends and never reads the store. The protocol state machine (VW-286)
// decides WHEN a message goes out; this module decides WHAT it says. That split
// is what lets the copy rules in
// `sources/notes/2026-09-12-accountability-system-plan.md` §2 be asserted on
// rendered text with no clock, no transport and no database.
//
// Input interfaces are imported from the state machine's `types.ts` (VW-291):
// one definition per concept, so a caller (a tool handler) builds an
// `AdherenceRead` or a `NextWorkoutRead` once and either module can consume
// it. Re-exported here so existing imports of these names from this module
// keep working.

import {
  COMMITMENT_LANGUAGE_PLACEHOLDER,
  GHOST_NUDGE_1,
  GHOST_NUDGE_2,
  HOLDING_ACKNOWLEDGEMENT,
  MISS_RECOVERY,
  NON_JUDGMENT_LINE,
  OPERATIONAL_HONESTY_LINE,
  REALIGN_OPENER,
  SILENCE_MEANS_ON_TRACK_LINE,
  SUNDAY_ANCHOR,
} from './copy.js';
import { COMPOSER_FRAGMENTS as LINES, REDUCED_SCOPE_MINUTES } from '../coach-copy/composer.js';
import type {
  AdherenceRead,
  HoldingRead,
  MissedSessionFacts,
  NextWorkoutExercise,
  NextWorkoutRead,
  PlannedSlot,
  PlanningDueRead,
} from './types.js';

export type {
  AdherenceRead,
  HoldingRead,
  MissedSessionFacts,
  NextWorkoutExercise,
  NextWorkoutRead,
  PlannedSlot,
  PlanningDueRead,
} from './types.js';

/** An engineering default; its source sits beside it in the coach-copy registry. */
const DEFAULT_REDUCED_SCOPE_MINUTES = REDUCED_SCOPE_MINUTES.value;

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];

export type CoachMessageKind =
  | 'sunday_anchor'
  | 'miss_recovery'
  | 'holding_acknowledgement'
  | 'ghost_nudge_1'
  | 'ghost_nudge_2'
  | 'realign_opener';

export interface ComposedMessage {
  kind: CoachMessageKind;
  text: string;
}

export interface SundayAnchorInput {
  lifterName: string;
  /** `null` when no template was assigned in the range, which is not a shortfall. */
  adherence: AdherenceRead | null;
  rolling28DayTrainingDays: number;
  nextWorkout: NextWorkoutRead | null;
  slots: PlannedSlot[];
  /** Last week's if-then in the lifter's words, shown back before this week's is asked for. */
  ifThenPlan?: string;
  commitmentLanguage?: string;
  /** Once a month, at a temporal landmark (LIT §1.2, §1.5). */
  monthlyCommitmentReoffer: boolean;
  /** Present when the next block is due to be planned (VW-476); the sitting is only offered. */
  planning?: PlanningDueRead | null;
}

export interface MissRecoveryInput {
  lifterName: string;
  missed: MissedSessionFacts;
  nextWorkout: NextWorkoutRead;
  /** The named day the re-entry lands on. The state machine picks it; the copy states it. */
  reEntryDay: string;
  reducedScopeMinutes?: number;
  holding: HoldingRead;
}

export interface GhostNudgeInput {
  lifterName: string;
  nextWorkout: NextWorkoutRead | null;
  reducedScopeMinutes?: number;
}

export interface RealignOpenerInput {
  lifterName: string;
  adherence: AdherenceRead | null;
  rolling28DayTrainingDays: number;
  slots: PlannedSlot[];
}

/** Fills each `{{token}}` once; a filled value is never scanned for further tokens. */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, token: string) => {
    const value = values[token];
    if (value === undefined) {
      throw new Error(`coach copy: template placeholder "${token}" has no value`);
    }
    return value;
  });
}

/** Fills a whole message, then drops the lines that rendered empty. */
function render(template: string, values: Record<string, string>): string {
  return fill(template, values)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

function numberWord(count: number): string {
  return NUMBER_WORDS[count] ?? String(count);
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? 'nothing named';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Trend as a direction, never a raw deviation count: the escalation ladder is
 * keyed to trend (RP §2), and a count is the running total copy rule 2 bans.
 */
function trendWord(trend: AdherenceRead['trend']): string {
  if (trend === 'improving') return LINES.trendImproving.text;
  if (trend === 'declining') return LINES.trendDeclining.text;
  if (trend === 'steady') return LINES.trendSteady.text;
  return LINES.trendNoPrior.text;
}

function adherenceLine(adherence: AdherenceRead | null): string {
  if (adherence === null) return LINES.adherenceNone.text;
  return fill(LINES.adherenceRead.text, {
    planned: String(adherence.planned),
    done: String(adherence.done),
    trend: trendWord(adherence.trend),
  });
}

/** Copy rule 7: a rolling window has no zero state, which is the point of it. */
function rollingLine(trainingDays: number): string {
  return fill(LINES.rolling.text, { trainingDays: String(trainingDays) });
}

function nextUpLine(nextWorkout: NextWorkoutRead | null): string {
  if (nextWorkout === null) return LINES.nextUpEmpty.text;
  return fill(LINES.nextUp.text, {
    templateName: nextWorkout.templateName,
    exercises: joinNames(nextWorkout.exercises.map((exercise) => exercise.name)),
  });
}

/** Offers the planning sitting, never starts it: the lifter picks when (VW-476). */
function planningLine(planning: PlanningDueRead | null): string {
  if (planning === null) return '';
  return fill(LINES.planning.text, { reason: planning.reason });
}

function slotsLine(slots: readonly PlannedSlot[]): string {
  const rendered = slots
    .map((slot) => fill(LINES.slot.text, { day: slot.day, fallbackDay: slot.fallbackDay }))
    .join(', ');
  return fill(LINES.slots.text, { slots: rendered });
}

function ifThenLine(ifThenPlan: string | undefined): string {
  if (ifThenPlan === undefined) return LINES.ifThenFirst.text;
  return fill(LINES.ifThenRepeat.text, { ifThenPlan });
}

function commitmentLine(input: SundayAnchorInput): string {
  if (!input.monthlyCommitmentReoffer) return '';
  const wording = input.commitmentLanguage ?? COMMITMENT_LANGUAGE_PLACEHOLDER;
  return fill(LINES.monthMarker.text, { wording });
}

function loadClause(exercise: NextWorkoutExercise): string {
  if (exercise.targetWeightLbs === undefined) return '';
  return fill(LINES.loadClause.text, { weightLbs: String(exercise.targetWeightLbs) });
}

/**
 * The single reduced-scope re-entry, sourced from `plan.next_workout`'s lead
 * exercise and put on a named day. One offer, not a menu: the megastudy's
 * winning intervention was a specific return to the next session (LIT §1.9).
 */
function offerLine(input: MissRecoveryInput, minutes: number, lead: NextWorkoutExercise): string {
  return fill(LINES.reEntryOffer.text, {
    reEntryDay: input.reEntryDay,
    minutes: String(minutes),
    exercise: lead.name,
    loadClause: loadClause(lead),
  });
}

function maintenanceLine(minutes: number, lead: NextWorkoutExercise): string {
  return fill(LINES.holdingMaintenance.text, {
    minutes: String(minutes),
    exercise: lead.name,
    loadClause: loadClause(lead),
  });
}

/**
 * Copy rule 4, with the RP S5 tier reversal applied: the offer re-architects
 * within the same number of days and never below it.
 */
function reArchitectLine(slots: readonly PlannedSlot[]): string {
  return fill(LINES.reArchitect.text, {
    days: numberWord(slots.length),
    dayList: joinNames(slots.map((slot) => slot.day)),
  });
}

function askLine(slots: readonly PlannedSlot[]): string {
  return fill(LINES.ask.text, { dayList: joinNames(slots.map((slot) => slot.day)) });
}

function leadExercise(nextWorkout: NextWorkoutRead): NextWorkoutExercise {
  const lead = nextWorkout.exercises[0];
  if (lead === undefined) {
    throw new Error(
      'coach copy: the next workout has no exercises, so there is no reduced-scope re-entry to offer',
    );
  }
  return lead;
}

export function composeSundayAnchor(input: SundayAnchorInput): ComposedMessage {
  return {
    kind: 'sunday_anchor',
    text: render(SUNDAY_ANCHOR, {
      lifterName: input.lifterName,
      adherenceLine: adherenceLine(input.adherence),
      rollingLine: rollingLine(input.rolling28DayTrainingDays),
      nextUpLine: nextUpLine(input.nextWorkout),
      planningLine: planningLine(input.planning ?? null),
      slotsLine: slotsLine(input.slots),
      ifThenLine: ifThenLine(input.ifThenPlan),
      commitmentLine: commitmentLine(input),
      silenceLine: SILENCE_MEANS_ON_TRACK_LINE,
    }),
  };
}

function composeHoldingAcknowledgement(input: MissRecoveryInput): ComposedMessage {
  const minutes = input.reducedScopeMinutes ?? DEFAULT_REDUCED_SCOPE_MINUTES;
  const endDate = input.holding.endDate;
  return {
    kind: 'holding_acknowledgement',
    text: render(HOLDING_ACKNOWLEDGEMENT, {
      lifterName: input.lifterName,
      throughClause: endDate === undefined ? '' : fill(LINES.holdingThrough.text, { endDate }),
      plannedDay: input.missed.plannedDay,
      maintenanceLine: maintenanceLine(minutes, leadExercise(input.nextWorkout)),
    }),
  };
}

/**
 * The miss-recovery prompt, or the holding acknowledgement when a hold is
 * running. A hold suppresses miss detection and every adherence-failure frame
 * (plan §2), so the same missed day renders as two different messages.
 */
export function composeMissRecovery(input: MissRecoveryInput): ComposedMessage {
  if (input.holding.active) return composeHoldingAcknowledgement(input);
  const minutes = input.reducedScopeMinutes ?? DEFAULT_REDUCED_SCOPE_MINUTES;
  return {
    kind: 'miss_recovery',
    text: render(MISS_RECOVERY, {
      lifterName: input.lifterName,
      plannedDay: input.missed.plannedDay,
      missedExercises: joinNames(input.missed.exerciseNames),
      fallbackDay: input.missed.fallbackDay,
      nonJudgmentLine: NON_JUDGMENT_LINE,
      operationalHonestyLine: OPERATIONAL_HONESTY_LINE,
      offerLine: offerLine(input, minutes, leadExercise(input.nextWorkout)),
      bookingLine: fill(LINES.booking.text, { reEntryDay: input.reEntryDay }),
    }),
  };
}

/** Nudge 2 is not a follow-up to nudge 1: each reads as a first contact (copy rule 2). */
export function composeGhostNudge(n: 1 | 2, input: GhostNudgeInput): ComposedMessage {
  if (n === 1) {
    return {
      kind: 'ghost_nudge_1',
      text: render(GHOST_NUDGE_1, {
        lifterName: input.lifterName,
        nextUpLine: nextUpLine(input.nextWorkout),
      }),
    };
  }
  return {
    kind: 'ghost_nudge_2',
    text: render(GHOST_NUDGE_2, {
      lifterName: input.lifterName,
      nextUpLine: nextUpLine(input.nextWorkout),
      minutes: String(input.reducedScopeMinutes ?? DEFAULT_REDUCED_SCOPE_MINUTES),
    }),
  };
}

export function composeRealignOpener(input: RealignOpenerInput): ComposedMessage {
  return {
    kind: 'realign_opener',
    text: render(REALIGN_OPENER, {
      lifterName: input.lifterName,
      nonJudgmentLine: NON_JUDGMENT_LINE,
      operationalHonestyLine: OPERATIONAL_HONESTY_LINE,
      adherenceLine: adherenceLine(input.adherence),
      rollingLine: rollingLine(input.rolling28DayTrainingDays),
      reArchitectLine: reArchitectLine(input.slots),
      askLine: askLine(input.slots),
    }),
  };
}
