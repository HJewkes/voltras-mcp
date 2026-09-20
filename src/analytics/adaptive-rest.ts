// Adaptive rest (VW-445 / VW-515): the pure rules behind a rest length that is
// LEARNED per lifter, exercise and intent by an up/down staircase, instead of
// read from a population table.
//
// The owner's rulings, which nothing here may move:
//
//   * The staircase probes DOWNWARD to find the limit, and never below the
//     45 s floor. Three things nearby are NOT rulings and sit in the policy
//     object as engineering defaults: the 300 s ceiling (the owner ruled the
//     floor and never this; it comes from Janicijevic 2023), the 15 s step
//     (fixed by the owner as a STARTING value), and the exercise-day as the
//     unit (the owner said "one step per session per exercise"). The step
//     still needs the owner's sign-off to move, because it sets how much rest
//     a lifter gets.
//   * The signal is reps preserved for hypertrophy and opening velocity for
//     strength. Power follows strength; an exercise with no stated intent
//     follows hypertrophy.
//   * A planned exercise carries an optional rest plus a learning flag. No
//     rest means the learned value. A rest with learning on is the BASE the
//     staircase starts from. Learning off means no probing.
//
// Everything else is an engineering default, and every number of either kind
// sits in {@link ADAPTIVE_REST_POLICY} with its status, so the simulation
// (VW-516) can read what it is allowed to move rather than being told.
//
// THIS MODULE IS PURE. No store, no clock, no I/O. Dates arrive as local
// 'YYYY-MM-DD' strings and instants as ISO timestamps; nothing here reads
// `Date.now()`. Two predicates it must not re-derive are imported rather than
// copied: `countsAsTraining` (VW-489) decides test versus training, and
// `selectEligibleReps` (VW-168) decides which reps are work.
//
// Citations for the two literature-backed numbers are on the policy entries
// that carry them. Both signals read MEAN concentric velocity, the measure the
// stop gate and the wall use, so no surface disagrees about what a velocity is.

import { getRepMeanVelocity, type Rep } from '@voltras/workout-analytics';

import { addDays } from '../plan/block-calendar.js';
import { selectEligibleReps } from '../state/rep-eligibility.js';
import { countsAsTraining, type SessionKind } from '../store/session-kind.js';
import { setPurposeOf } from '../store/set-purpose.js';
import type {
  LearnedRestBaseSourceValue,
  LearnedRestStateValue,
  SetPurpose,
} from '../store/types.js';
import { defaultRestSeconds } from './rest-defaults.js';
import type { TrainingIntent } from '../schemas/set.js';

/** Whose number it is. `OWNER` values are rulings; the simulation may not move them. */
export type PolicyStatus = 'OWNER' | 'ENGINEERING DEFAULT';

/**
 * One tunable, with who owns it and why it is what it is.
 *
 * `ownerSignOff` marks an engineering default that nonetheless sets how much
 * rest a lifter gets — dose. The simulation may RECOMMEND a change to it and
 * may not make one (design s.10.1).
 */
export interface PolicyValue<T = number> {
  readonly value: T;
  readonly status: PolicyStatus;
  readonly ownerSignOff?: true;
  readonly note: string;
}

/** The intent a learned rest is keyed by. `'none'` is a real key, not a gap. */
export type RestIntentKey = TrainingIntent | 'none';

/** Which recovery signal an intent is judged on (OWNER). */
export type RestSignal = 'opening_velocity' | 'reps_preserved';

/** How a pair of sets sorts against the rest being probed (design s.4.4). */
export type PairClass = 'recovered' | 'missed' | 'rushed' | 'long';

/** A pair's sort, plus the one outcome that is not a sort: no ratio could be computed. */
export type PairVerdict = PairClass | 'invalid';

/** What one exercise-day's evaluation did to the learned value. */
export type StepDecision = 'down' | 'up' | 'hold' | 'no_evidence' | 'restart';

/** The machine word for why (design s.3.2, amendment s.2). */
export type StepReason =
  | 'recovered'
  | 'missed'
  | 'dead_band'
  | 'too_few_pairs'
  | 'superseded_by_plan'
  | 'floor'
  | 'ceiling'
  | 'vetoed';

/**
 * How far a run has got. A learned record returns to calibrating only through a restart.
 * Aliased to the store's vocabulary rather than restated, so the words this module decides
 * with and the words `learned_rest.state` admits cannot drift apart (VW-517).
 */
export type LearnedRestState = LearnedRestStateValue;

/** The two ways the staircase can move. */
export type StepDirection = 'down' | 'up';

/** What a run started from. Same aliasing as the state above. */
export type RestBaseSource = LearnedRestBaseSourceValue;

/** Every number the staircase turns on, with its provenance. */
export const ADAPTIVE_REST_POLICY = {
  policyVersion: 'adaptive-rest@1.1.0',

  /** Which signal each intent is judged on. */
  signalByIntent: {
    value: {
      strength: 'opening_velocity',
      power: 'opening_velocity',
      hypertrophy: 'reps_preserved',
      none: 'reps_preserved',
    } as Readonly<Record<RestIntentKey, RestSignal>>,
    status: 'OWNER',
    note: 'Reps preserved for hypertrophy, opening velocity for strength; power follows strength and no stated intent follows hypertrophy.',
  },

  // ── s.4.1 what makes a pair evidence ──────────────────────────────────

  minEligibleRepsPerSet: {
    value: 3,
    status: 'ENGINEERING DEFAULT',
    note: 'Fewer than three eligible reps carries no within-set velocity trend to read recovery from.',
  },
  sameLoadToleranceLbs: {
    value: 1,
    status: 'ENGINEERING DEFAULT',
    note: 'Two sets are the same load within this; anything wider is a different stimulus, not a repeat.',
  },
  minVelocityLossPct: {
    value: 10,
    status: 'ENGINEERING DEFAULT',
    note: 'The earlier set must have gone this deep to say anything about recovery. A set that caused no fatigue tests no rest (Janicijevic 2023).',
  },
  minActualRestSec: {
    value: 30,
    status: 'ENGINEERING DEFAULT',
    note: 'A shorter gap is a myo-rep, cluster or drop set in practice, whatever it was called. No set-structure tag exists to ask instead.',
  },

  // ── s.4.2 / s.4.3 the ratio and its target ────────────────────────────

  openingVelocityReps: {
    value: 2,
    status: 'ENGINEERING DEFAULT',
    note: "Opening velocity is the higher mean velocity of a set's first two eligible reps, so one slow opener does not read as fatigue.",
  },
  openingVelocityTarget: {
    value: 0.95,
    status: 'ENGINEERING DEFAULT',
    ownerSignOff: true,
    note: 'About one noise CV below full recovery; the literature names no threshold. Dose: the simulation may recommend, the owner decides.',
  },
  repsPreservedTarget: {
    value: 0.9,
    status: 'ENGINEERING DEFAULT',
    ownerSignOff: true,
    note: 'Singer 2024 and Zhang 2026 tie the benefit to preserved volume; neither names a threshold. Dose: recommend only.',
  },

  // ── s.4.4 / s.4.5 sorting and weighting a pair ────────────────────────

  toleranceSec: {
    value: 15,
    status: 'ENGINEERING DEFAULT',
    note: 'One step. Inside this window of the probed rest a pair is informative whichever way the ratio falls.',
  },
  earlyPairWeight: {
    value: 1,
    status: 'ENGINEERING DEFAULT',
    note: 'A pair ending at set 2 or 3 of the exercise-day carries full weight.',
  },
  latePairWeight: {
    value: 0.5,
    status: 'ENGINEERING DEFAULT',
    note: 'Cumulative fatigue lowers the ratio at set 4 and later whatever the rest was, so those pairs count half.',
  },
  latePairFromSetIndex: {
    value: 4,
    status: 'ENGINEERING DEFAULT',
    note: 'Where the half weight starts, counting the later set of the pair.',
  },

  // ── s.4.6 the step ────────────────────────────────────────────────────

  stepSec: {
    value: 15,
    status: 'ENGINEERING DEFAULT',
    ownerSignOff: true,
    note: "The owner's brief fixes 15 s as the STARTING value, which makes it a default with an origin rather than a ruling. It also sets how much rest a lifter gets, so it is dose: the simulation may recommend, the owner decides.",
  },
  maxStepsPerExerciseDay: {
    value: 1,
    status: 'ENGINEERING DEFAULT',
    note: "The owner ruled one step per SESSION per exercise. The exercise-day is the designer's reading of that, because a session row holds one exercise and one side and an exercise often spans several rows in one visit.",
  },
  floorSec: {
    value: 45,
    status: 'OWNER',
    note: 'The owner set the floor. A planned rest under it is served as written and never learned from.',
  },
  ceilingSec: {
    value: 300,
    status: 'ENGINEERING DEFAULT',
    note: 'The owner ruled the 45 s floor and never this. It comes from Janicijevic 2023 (5 min when sets end near failure) and happens to match the passive rest registry cap.',
  },
  minInformativeWeight: {
    value: 2,
    status: 'ENGINEERING DEFAULT',
    note: 'Below this the day decides nothing, so a single pair can never move the rest.',
  },
  evidenceWindowDays: {
    value: 28,
    status: 'ENGINEERING DEFAULT',
    note: 'Evidence carries across days so a two-set exercise still learns, but not across a training block.',
  },
  deadBand: {
    value: 0.02,
    status: 'ENGINEERING DEFAULT',
    note: 'A median this close to target holds. Narrower than the measurement noise would bounce the rest every visit.',
  },
  stepDaysRequiredWhenLearned: {
    value: 2,
    status: 'ENGINEERING DEFAULT',
    note: 'Once learned, a step in EITHER direction needs two consecutive qualifying days. The valve covers a single bad day, so one day of evidence should not move a rest the staircase has already found.',
  },
  outOfWindowPairs: {
    value: 'veto_only' as const,
    status: 'ENGINEERING DEFAULT',
    note: 'A pair whose actual rest sits outside the tolerance window never enters the median and can never cause a step. It may only veto the opposite step. Counting such pairs selected evidence on its outcome, which ratcheted a loiterer up and a rusher down forever.',
  },

  // ── s.4.7 the seed ────────────────────────────────────────────────────

  minLearnedRecordsForLifterFactor: {
    value: 2,
    status: 'ENGINEERING DEFAULT',
    note: 'Below this the lifter has no personal ratio to generalise from and the population default is the honest start.',
  },
  firstSessionClampLow: {
    value: 0.5,
    status: 'ENGINEERING DEFAULT',
    note: 'A seed from the lifter factor is held to at least this multiple of the intent default.',
  },
  firstSessionClampHigh: {
    value: 1.5,
    status: 'ENGINEERING DEFAULT',
    note: 'And to at most this multiple, so one long-resting exercise cannot seed every other one long.',
  },
  seedRoundingSec: {
    value: 15,
    status: 'ENGINEERING DEFAULT',
    note: 'A seed is rounded to the step, so the first countdown reads like a rest and not like a computation.',
  },

  // ── s.4.8 the state, and s.5.3 the restart guard ──────────────────────

  learnedMinArrivals: {
    value: 3,
    status: 'ENGINEERING DEFAULT',
    note: 'Arrivals before a run may call itself learned. Two are too easy to fake: one noisy day in the middle of a march produces an up then a down, which is two reversals at one spot. A third needs a second noisy day at the same spot.',
  },
  learnedValueRule: {
    value: 'longer_of_last_two_arrivals' as const,
    status: 'ENGINEERING DEFAULT',
    note: 'A 15 s staircase brackets the lifter’s rest between two neighbouring values. Settling on the longer one protects the training; the shorter one only saves time.',
  },
  learnedMinDaysEvaluated: {
    value: 3,
    status: 'ENGINEERING DEFAULT',
    note: 'Exercise-days judged before a run may call itself learned. NECESSARY ONLY since the arrival rule: on its own it granted learned after at most three steps, whatever the lifter.',
  },
  learnedMinInformativePairs: {
    value: 6,
    status: 'ENGINEERING DEFAULT',
    note: 'Informative pairs in the run before it may call itself learned. Necessary only, for the same reason.',
  },
  relearnAfterSameDirectionSteps: {
    value: 3,
    status: 'ENGINEERING DEFAULT',
    note: 'A learned run that marches this far in one direction goes back to calibrating: the lifter has changed, or the sets have.',
  },
  restartCooldownDays: {
    value: 7,
    status: 'ENGINEERING DEFAULT',
    note: 'A key restarts at most once this often, so two live plan rows that disagree cannot restart each other every visit.',
  },
  historyCapEntries: {
    value: 50,
    status: 'ENGINEERING DEFAULT',
    note: 'How many steps a record keeps. Older ones answer nothing a reader asks.',
  },
} as const satisfies Record<string, PolicyValue<unknown> | string>;

/** The signal an intent is judged on (OWNER ruling, read from the policy). */
export function signalForIntent(intent: RestIntentKey): RestSignal {
  return ADAPTIVE_REST_POLICY.signalByIntent.value[intent];
}

/** The recovery target a signal is judged against. */
export function targetFor(signal: RestSignal): number {
  return signal === 'opening_velocity'
    ? ADAPTIVE_REST_POLICY.openingVelocityTarget.value
    : ADAPTIVE_REST_POLICY.repsPreservedTarget.value;
}

/** The intent default this module seeds and clamps against. `'none'` takes the no-intent default. */
export function intentDefaultSec(intent: RestIntentKey): number {
  return defaultRestSeconds(intent === 'none' ? undefined : intent);
}

/**
 * One recorded set, as far as the staircase is concerned. The caller maps a
 * stored row onto this; nothing here reads the store.
 *
 * `constantLoad` and `velocitySignalValid` are the two facts the effort
 * resolver pins at set start (VW-448). They are REQUIRED rather than defaulted:
 * neither exists on a stored row today, and a module that guessed them would
 * read an isokinetic set as a constant-load one.
 */
export interface RestSetInput {
  readonly id: string;
  readonly exerciseId: string;
  /** ISO instant the set was opened. */
  readonly startedAt: string;
  /** ISO instant the set was closed. */
  readonly endedAt: string;
  /** ISO instant of the first rep, when the store holds one. Falls back to {@link startedAt}. */
  readonly workStartedAt?: string;
  readonly reps: readonly Rep[];
  readonly weightLbs?: number;
  readonly setPurpose?: SetPurpose;
  /** Present means a guest performed it (VW-169). A guest never learns and is never learned from. */
  readonly lifter?: string;
  /** VW-489. Only `'training'` is the lifter's history. */
  readonly kind?: SessionKind;
  readonly source?: 'local' | 'imported' | 'mock';
  readonly slot?: string;
  readonly constantLoad: boolean;
  readonly velocitySignalValid: boolean;
}

/** Why a candidate pair is not evidence (design s.4.1). */
export type PairInvalidReason =
  | 'too_few_reps'
  | 'load_differs'
  | 'not_constant_load'
  | 'no_velocity_signal'
  | 'slot_differs'
  | 'interleaved'
  | 'too_shallow'
  | 'rest_too_short';

/** Two consecutive working sets of one exercise, and the rest between them. */
export interface RestPair {
  readonly earlier: RestSetInput;
  readonly later: RestSetInput;
  /** The first working set of the day at this load: the opening-velocity reference. */
  readonly reference: RestSetInput;
  readonly actualRestSec: number;
  /** 1-based position of {@link later} among the day's working sets of this exercise. */
  readonly laterSetIndex: number;
  readonly weight: number;
}

export interface RejectedPair {
  readonly earlier: RestSetInput;
  readonly later: RestSetInput;
  readonly reason: PairInvalidReason;
}

export interface ExerciseDayPairs {
  readonly valid: readonly RestPair[];
  readonly rejected: readonly RejectedPair[];
}

export interface ExerciseDayPairsInput {
  readonly exerciseId: string;
  /** EVERY set the day holds, any exercise, so the interleave rule can see across them. */
  readonly daySets: readonly RestSetInput[];
}

/**
 * The pairs of one exercise-day that are evidence, and the ones that are not.
 *
 * Candidates are the OWNER's training, non-mock, WORKING sets of the exercise,
 * in start order. A guest's set, a mock set and a warm-up are not candidates
 * rather than rejected pairs, so one of them landing between two working sets
 * does not cost the lifter the pair those two sets make.
 */
export function pairsForExerciseDay(input: ExerciseDayPairsInput): ExerciseDayPairs {
  const candidates = candidateSets(input.daySets, input.exerciseId);
  const valid: RestPair[] = [];
  const rejected: RejectedPair[] = [];
  for (let i = 1; i < candidates.length; i += 1) {
    const earlier = candidates[i - 1];
    const later = candidates[i];
    const reason = pairInvalidReason(earlier, later, input.daySets);
    if (reason !== null) {
      rejected.push({ earlier, later, reason });
      continue;
    }
    valid.push(buildPair(earlier, later, i + 1, candidates));
  }
  return { valid, rejected };
}

/**
 * How recovered the later set of a pair was, 0 to 1, or `null` when the pair
 * carries no usable velocity. Capped at 1: recovering MORE than the reference
 * is not extra evidence about the rest.
 */
export function recoveryRatio(pair: RestPair, signal: RestSignal): number | null {
  return signal === 'opening_velocity' ? openingVelocityRatio(pair) : repsPreservedRatio(pair);
}

/** A pair's sort against the rest being probed, and whether it says anything. */
export interface PairSort {
  readonly verdict: PairVerdict;
  readonly r: number | null;
  /** Actual rest sat within one tolerance of the probed rest. Only these can cause a step. */
  readonly inWindow: boolean;
  readonly informative: boolean;
  readonly weight: number;
}

/**
 * Sort one pair against `valueSec`, the rest being probed on that date.
 *
 * ONLY PAIRS INSIDE THE WINDOW ARE INFORMATIVE (amendment s.2). Counting the
 * two monotone cases outside it selected evidence on its outcome and was a
 * one-way ratchet: a loiterer rests past the window, so their only class is
 * `missed` and every step is `up` forever; a rusher's only class is `recovered`
 * and every step is `down`. Neither ever catches up, because both rest relative
 * to the value the staircase just moved.
 *
 * Those two classes are still recorded, and {@link evaluateExerciseDay} lets
 * them VETO the opposite step. A long rest that still missed is a reason not to
 * shorten. It is not a reason to lengthen.
 */
export function sortPair(pair: RestPair, valueSec: number, signal: RestSignal): PairSort {
  const r = recoveryRatio(pair, signal);
  if (r === null) {
    return { verdict: 'invalid', r: null, inWindow: false, informative: false, weight: 0 };
  }
  const tol = ADAPTIVE_REST_POLICY.toleranceSec.value;
  const inWindow = pair.actualRestSec >= valueSec - tol && pair.actualRestSec <= valueSec + tol;
  const meets = r >= targetFor(signal);
  const verdict = meets
    ? pair.actualRestSec <= valueSec + tol
      ? 'recovered'
      : 'long'
    : pair.actualRestSec >= valueSec - tol
      ? 'missed'
      : 'rushed';
  const informative = inWindow && (verdict === 'recovered' || verdict === 'missed');
  return { verdict, r, inWindow, informative, weight: pair.weight };
}

/**
 * One pair as the evidence window holds it.
 *
 * Out-of-window pairs are kept here too: they never enter the median, and they
 * are what the veto reads (amendment s.2).
 */
export interface EvidencePair {
  /** Local date of the exercise-day it came from. */
  readonly on: string;
  readonly r: number;
  readonly weight: number;
  readonly verdict: PairVerdict;
  /** Actual rest sat within one tolerance of the value being probed that day. */
  readonly inWindow: boolean;
}

/** Pairs a day saw and ignored, carried onto the history entry. */
export interface IgnoredPairs {
  readonly rushed: number;
  readonly long: number;
  readonly invalid: number;
}

/** One entry of a record's history (design s.3.2). */
export interface RestStep {
  readonly on: string;
  readonly fromSec: number;
  readonly toSec: number;
  readonly decision: StepDecision;
  readonly reason: StepReason;
  readonly signal: RestSignal;
  readonly rMedian: number | null;
  readonly informativePairs: number;
  readonly ignoredPairs: IgnoredPairs;
}

export interface EvaluateExerciseDayInput {
  /** Local date of the exercise-day being judged. */
  readonly on: string;
  /** T on that date. */
  readonly valueSec: number;
  readonly state: LearnedRestState;
  readonly signal: RestSignal;
  readonly runStartedOn: string;
  readonly lastStepOn?: string;
  /** The direction the previous evaluated day qualified for, when the two-day rule held it. */
  readonly pendingDirection?: StepDirection | null;
  /** Every pair of the run, this day's included, newest last. In and out of window alike. */
  readonly evidence: readonly EvidencePair[];
  readonly ignoredPairs: IgnoredPairs;
}

export interface ExerciseDayEvaluation {
  readonly step: RestStep;
  /** The evidence was about the old value, so a caller that steps empties the window. */
  readonly clearsWindow: boolean;
  /** Carried to the next evaluation for the two-day rule, in either direction. */
  readonly pendingDirection: StepDirection | null;
}

/**
 * Judge one exercise-day and say what it does to the learned value. At most one
 * step per day, and never a step the clamp would have to undo.
 *
 * Three things can stop a step the median asked for: the dead band, a veto from
 * an out-of-window pair (amendment s.2), and, once the run is `learned`, the
 * two-day rule. That rule now applies in BOTH directions: a rest the staircase
 * has already found should not move on one day's evidence, whichever way it
 * points, and the valve covers the single bad day.
 */
export function evaluateExerciseDay(input: EvaluateExerciseDayInput): ExerciseDayEvaluation {
  const dated = evidenceWindow(input);
  const window = dated.filter((pair) => pair.inWindow && isInformativeVerdict(pair.verdict));
  const weight = window.reduce((sum, pair) => sum + pair.weight, 0);
  if (weight < ADAPTIVE_REST_POLICY.minInformativeWeight.value) {
    return held(input, 'no_evidence', 'too_few_pairs', null, window.length, null);
  }
  const median = weightedMedian(window);
  const band = ADAPTIVE_REST_POLICY.deadBand.value;
  const target = targetFor(input.signal);
  if (median >= target - band && median < target + band) {
    return held(input, 'hold', 'dead_band', median, window.length, null);
  }
  const direction: StepDirection = median < target - band ? 'up' : 'down';
  if (isVetoed(direction, dated)) {
    return held(input, 'hold', 'vetoed', median, window.length, null);
  }
  if (input.state === 'learned' && input.pendingDirection !== direction) {
    return held(input, 'hold', reasonFor(direction), median, window.length, direction);
  }
  return stepped(input, direction, reasonFor(direction), median, window.length);
}

/** A step down is a claim the lifter recovered; a step up, that they did not. */
function reasonFor(direction: StepDirection): StepReason {
  return direction === 'down' ? 'recovered' : 'missed';
}

function isInformativeVerdict(verdict: PairVerdict): boolean {
  return verdict === 'recovered' || verdict === 'missed';
}

/**
 * Does an out-of-window pair forbid this step? A long rest that still missed
 * forbids shortening; a short rest that recovered anyway forbids lengthening.
 * Neither can cause a step of its own.
 */
function isVetoed(direction: StepDirection, dated: readonly EvidencePair[]): boolean {
  const blocking = direction === 'down' ? 'missed' : 'recovered';
  return dated.some((pair) => !pair.inWindow && pair.verdict === blocking);
}

/**
 * An exercise-day on which the staircase showed it is AT the lifter's rest
 * (amendment s.3.1).
 *
 * Two kinds, and they mean the same thing. A REVERSAL is the staircase turning
 * round: it went one step too far and came back. A DEAD-BAND HOLD is it
 * arriving and staying. A march in one direction is neither: it is the
 * staircase still travelling, which is exactly what the old rule mistook for
 * having learned.
 */
export interface Arrival {
  readonly on: string;
  readonly kind: 'reversal' | 'dead_band';
  /** Where the staircase turned, or the value it held. */
  readonly valueSec: number;
}

/**
 * Every arrival in a run's history, oldest first.
 *
 * Holds between two steps are IGNORED when looking for a reversal: a day with
 * no evidence, or a vetoed day, does not break the chain from one step to the
 * next. Only a step that moved the value changes the direction under test.
 */
export function arrivals(history: readonly RestStep[]): Arrival[] {
  const found: Arrival[] = [];
  let lastDirection: StepDirection | null = null;
  for (const step of history) {
    if (step.decision === 'hold' && step.reason === 'dead_band') {
      found.push({ on: step.on, kind: 'dead_band', valueSec: step.toSec });
      continue;
    }
    if (step.decision !== 'down' && step.decision !== 'up') continue;
    if (lastDirection !== null && lastDirection !== step.decision) {
      found.push({ on: step.on, kind: 'reversal', valueSec: step.fromSec });
    }
    lastDirection = step.decision;
  }
  return found;
}

/**
 * The value a run settles on when it becomes learned: the longer of its last
 * two arrival values (amendment s.3.2). A 15 s staircase brackets the lifter's
 * rest between two neighbouring values, and the longer one protects the
 * training while the shorter one only saves time.
 *
 * `null` when there is no arrival to settle on.
 */
export function settledValue(found: readonly Arrival[]): number | null {
  if (found.length === 0) return null;
  const lastTwo = found.slice(-2);
  return Math.max(...lastTwo.map((arrival) => arrival.valueSec));
}

/**
 * The directions of the steps that actually moved the value, oldest first.
 *
 * `since` is a local date: pass the day a run became `learned` to get only the
 * steps it has taken since settling. That is what {@link NextStateInput}'s
 * `stepsSinceLearned` wants, and passing the whole run instead is the easy
 * mistake — a run that marched three times on its way to `learned` would
 * un-settle itself on its very next evaluated day without having stepped at all.
 */
export function stepDirections(history: readonly RestStep[], since?: string): StepDirection[] {
  return history
    .filter((step) => step.decision === 'down' || step.decision === 'up')
    .filter((step) => since === undefined || step.on >= since)
    .map((step) => step.decision as StepDirection);
}

export interface NextStateInput {
  readonly current: LearnedRestState;
  readonly daysEvaluated: number;
  readonly informativePairs: number;
  /** Arrivals in this run, oldest first. The caller slices the history at the run's start. */
  readonly arrivals: readonly Arrival[];
  /**
   * Directions of the steps taken SINCE the run became `learned`, oldest first.
   * Empty while the run is still calibrating, and empty on the day it settles.
   *
   * It is not the whole run's steps. A run that marched three times on its way
   * to `learned` must not un-settle itself the next day without having moved:
   * only steps taken since it settled can undo it. Build it with
   * {@link stepDirections} and the date the run became `learned`.
   */
  readonly stepsSinceLearned: readonly StepDirection[];
}

/**
 * Whether a run may call itself learned (amendment s.3.2).
 *
 * The day and pair counts are NECESSARY and no longer sufficient. On their own
 * they granted `learned` after at most three steps, which is 45 s of travel, so
 * any lifter further than that from the population seed was a false `learned`
 * by construction. What earns the word now is arriving three times.
 *
 * A learned run goes back to calibrating when it marches
 * `relearnAfterSameDirectionSteps` in one direction SINCE IT SETTLED: the
 * lifter has changed, or the sets have. Steps it took on the way to `learned`
 * do not count, or a run that marched into its arrivals would un-settle itself
 * the next day without having moved. The caller then starts a new run, so the
 * arrival count restarts with it.
 */
export function nextState(input: NextStateInput): LearnedRestState {
  if (input.current === 'learned') {
    return isMarching(input.stepsSinceLearned) ? 'calibrating' : 'learned';
  }
  const enough =
    input.arrivals.length >= ADAPTIVE_REST_POLICY.learnedMinArrivals.value &&
    input.daysEvaluated >= ADAPTIVE_REST_POLICY.learnedMinDaysEvaluated.value &&
    input.informativePairs >= ADAPTIVE_REST_POLICY.learnedMinInformativePairs.value;
  return enough ? 'learned' : 'calibrating';
}

/** Has the staircase taken its relearn quota of steps in one direction? */
function isMarching(directions: readonly StepDirection[]): boolean {
  const needed = ADAPTIVE_REST_POLICY.relearnAfterSameDirectionSteps.value;
  if (directions.length < needed) return false;
  const recent = directions.slice(-needed);
  return recent.every((direction) => direction === recent[0]);
}

/** One of the lifter's other learned records, read for the lifter factor. */
export interface LearnedRecordSummary {
  readonly intent: RestIntentKey;
  readonly valueSec: number;
  readonly state: LearnedRestState;
}

export interface SeedRestInput {
  readonly intent: RestIntentKey;
  readonly plannedRestSec?: number;
  readonly restLearning: boolean;
  /** The lifter's records for OTHER keys. Only the learned ones count. */
  readonly otherRecords?: readonly LearnedRecordSummary[];
}

export interface RestSeed {
  readonly seconds: number;
  readonly baseSource: RestBaseSource;
}

/**
 * What a run starts from: the plan's rest when it is usable, else this lifter's
 * own ratio of learned rest to population default, else the population default.
 */
export function seedRest(input: SeedRestInput): RestSeed {
  const planned = input.plannedRestSec;
  const defaultSec = intentDefaultSec(input.intent);
  if (input.restLearning && planned !== undefined && planned >= floorSec()) {
    return { seconds: Math.min(planned, ceilingSec()), baseSource: 'plan' };
  }
  const factor = lifterFactor(input.otherRecords ?? []);
  if (factor === null) return { seconds: defaultSec, baseSource: 'intent_default' };
  const clamped = clamp(
    factor * defaultSec,
    ADAPTIVE_REST_POLICY.firstSessionClampLow.value * defaultSec,
    ADAPTIVE_REST_POLICY.firstSessionClampHigh.value * defaultSec,
  );
  const rounding = ADAPTIVE_REST_POLICY.seedRoundingSec.value;
  const rounded = Math.round(clamped / rounding) * rounding;
  return { seconds: clamp(rounded, floorSec(), ceilingSec()), baseSource: 'lifter_factor' };
}

/** What a plan write is told when its rest disagrees with what the lifter has learned. */
export interface RestConflict {
  readonly kind: 'differs_from_learned' | 'conflicting_plan_rows';
  readonly exerciseId: string;
  readonly plannedSec: number;
  readonly learnedSec: number;
  readonly learnedState: LearnedRestState;
  readonly daysEvaluated: number;
  /** True when the first use of this row will restart learning from `plannedSec`. */
  readonly willRestartOnUse: boolean;
  /** Filled for `'conflicting_plan_rows'`: the other live rows and their rests. */
  readonly otherRows?: readonly { readonly plannedExerciseId: string; readonly restSec: number }[];
}

/** The record as the conflict check reads it. */
export interface LearnedRestRecordView {
  readonly valueSec: number;
  readonly state: LearnedRestState;
  readonly daysEvaluated: number;
  /** The plan rest this run started from, when it started from one. */
  readonly planBaseSec?: number;
  /** Local date of the newest restart, for the cooldown. */
  readonly lastRestartOn?: string;
}

export interface RestConflictInput {
  readonly exerciseId: string;
  readonly plannedRestSec?: number;
  readonly restLearning: boolean;
  readonly record?: LearnedRestRecordView;
  /** Other live planned rows for the same exercise, with their rests. */
  readonly otherRows?: readonly { readonly plannedExerciseId: string; readonly restSec: number }[];
  /** Local date the write happens on, for the restart cooldown. */
  readonly on?: string;
}

/**
 * The flag a plan write returns, or `null` when there is nothing to say. It is
 * COMPUTED, never stored: it is true exactly while the planned rest and the
 * learned value disagree, and it stops being true the moment either changes.
 *
 * The write always succeeds. This only tells the planner what their number will
 * do to a run that already exists.
 *
 * LEARNING OFF WITH NO REST is not a row a planner can write any more. The
 * owner's 2026-09-20 ruling: "Force one to be set, if learned is false then a
 * rest value is required. If both are null due to data quality issue, seed rest
 * time from learned value but then leave learning false (equates to
 * recommendation)". Refusing that write belongs to the plan-write validator, a
 * later task. Here the combination survives only as the data-quality fallback
 * the ruling's second sentence describes, and this function is silent about it:
 * nothing is written, nothing is probed, and there is no conflict to report.
 */
export function restConflictFor(input: RestConflictInput): RestConflict | null {
  const planned = input.plannedRestSec;
  const record = input.record;
  if (planned === undefined || !input.restLearning || record === undefined) return null;
  if (planned < floorSec()) return null;
  if (record.planBaseSec === planned) return null;
  const step = ADAPTIVE_REST_POLICY.stepSec.value;
  if (Math.abs(planned - record.valueSec) < step) return null;
  const disagreeing = (input.otherRows ?? []).filter(
    (row) => Math.abs(row.restSec - planned) >= step,
  );
  const common = {
    exerciseId: input.exerciseId,
    plannedSec: planned,
    learnedSec: record.valueSec,
    learnedState: record.state,
    daysEvaluated: record.daysEvaluated,
  };
  if (disagreeing.length > 0) {
    return {
      ...common,
      kind: 'conflicting_plan_rows',
      willRestartOnUse: false,
      otherRows: disagreeing,
    };
  }
  return { ...common, kind: 'differs_from_learned', willRestartOnUse: !inRestartCooldown(input) };
}

// ── internals ───────────────────────────────────────────────────────────

function floorSec(): number {
  return ADAPTIVE_REST_POLICY.floorSec.value;
}

function ceilingSec(): number {
  return ADAPTIVE_REST_POLICY.ceilingSec.value;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Sets that could pair: the owner's training, non-mock, working sets of this exercise. */
function candidateSets(
  daySets: readonly RestSetInput[],
  exerciseId: string,
): readonly RestSetInput[] {
  return daySets
    .filter((set) => set.exerciseId === exerciseId && setPurposeOf(set) === 'working')
    .filter(isOwnerTrainingSet)
    .slice()
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function isOwnerTrainingSet(set: RestSetInput): boolean {
  return set.lifter === undefined && set.source !== 'mock' && countsAsTraining(set);
}

function pairInvalidReason(
  earlier: RestSetInput,
  later: RestSetInput,
  daySets: readonly RestSetInput[],
): PairInvalidReason | null {
  const minReps = ADAPTIVE_REST_POLICY.minEligibleRepsPerSet.value;
  if (eligibleRepsOf(earlier).length < minReps || eligibleRepsOf(later).length < minReps) {
    return 'too_few_reps';
  }
  if (!earlier.constantLoad || !later.constantLoad) return 'not_constant_load';
  if (!earlier.velocitySignalValid || !later.velocitySignalValid) return 'no_velocity_signal';
  if (!sameLoad(earlier, later)) return 'load_differs';
  if (earlier.slot !== later.slot) return 'slot_differs';
  if (achievedVelocityLossPct(earlier) < ADAPTIVE_REST_POLICY.minVelocityLossPct.value) {
    return 'too_shallow';
  }
  if (actualRestSeconds(earlier, later) < ADAPTIVE_REST_POLICY.minActualRestSec.value) {
    return 'rest_too_short';
  }
  return isInterleaved(earlier, later, daySets) ? 'interleaved' : null;
}

/**
 * Did the lifter do other work inside this rest? Any of their own training sets
 * starting in the gap counts, including a warm-up of this same exercise: a rest
 * that contains work is not the rest the staircase is probing.
 */
function isInterleaved(
  earlier: RestSetInput,
  later: RestSetInput,
  daySets: readonly RestSetInput[],
): boolean {
  const from = earlier.endedAt;
  const to = workStartOf(later);
  return daySets.some(
    (set) =>
      set.id !== earlier.id &&
      set.id !== later.id &&
      isOwnerTrainingSet(set) &&
      set.startedAt > from &&
      set.startedAt < to,
  );
}

function buildPair(
  earlier: RestSetInput,
  later: RestSetInput,
  laterSetIndex: number,
  candidates: readonly RestSetInput[],
): RestPair {
  const reference = candidates.find((set) => sameLoad(set, later)) ?? earlier;
  const lateFrom = ADAPTIVE_REST_POLICY.latePairFromSetIndex.value;
  return {
    earlier,
    later,
    reference,
    actualRestSec: actualRestSeconds(earlier, later),
    laterSetIndex,
    weight:
      laterSetIndex >= lateFrom
        ? ADAPTIVE_REST_POLICY.latePairWeight.value
        : ADAPTIVE_REST_POLICY.earlyPairWeight.value,
  };
}

/** Rest as the lifter experienced it: the earlier close to the later set's first rep. */
function actualRestSeconds(earlier: RestSetInput, later: RestSetInput): number {
  return (Date.parse(workStartOf(later)) - Date.parse(earlier.endedAt)) / 1000;
}

function workStartOf(set: RestSetInput): string {
  return set.workStartedAt ?? set.startedAt;
}

function sameLoad(a: RestSetInput, b: RestSetInput): boolean {
  if (a.weightLbs === undefined || b.weightLbs === undefined) return false;
  return Math.abs(a.weightLbs - b.weightLbs) <= ADAPTIVE_REST_POLICY.sameLoadToleranceLbs.value;
}

function eligibleRepsOf(set: RestSetInput): readonly Rep[] {
  return set.reps.length === 0 ? [] : selectEligibleReps(set.reps);
}

/** How far the set's mean velocity fell from its own best, in percent. */
function achievedVelocityLossPct(set: RestSetInput): number {
  const velocities = eligibleRepsOf(set).map((rep) => getRepMeanVelocity(rep));
  if (velocities.length === 0) return 0;
  const best = Math.max(...velocities);
  if (!(best > 0)) return 0;
  return ((best - velocities[velocities.length - 1]) / best) * 100;
}

/** The higher mean velocity of a set's first eligible reps (design s.4.2). */
function openingVelocity(set: RestSetInput): number | null {
  const opening = eligibleRepsOf(set)
    .slice(0, ADAPTIVE_REST_POLICY.openingVelocityReps.value)
    .map((rep) => getRepMeanVelocity(rep));
  if (opening.length === 0) return null;
  const best = Math.max(...opening);
  return best > 0 ? best : null;
}

function openingVelocityRatio(pair: RestPair): number | null {
  const reference = openingVelocity(pair.reference);
  const observed = openingVelocity(pair.later);
  if (reference === null || observed === null) return null;
  return Math.min(1, observed / reference);
}

/**
 * Reps preserved at a MATCHED velocity: how far into each set the lifter first
 * reached the slower of the two sets' finishing velocities. Equal rep counts
 * with a slower finish still read as under-recovered, which a plain rep count
 * cannot see.
 */
function repsPreservedRatio(pair: RestPair): number | null {
  const earlier = eligibleVelocities(pair.earlier);
  const later = eligibleVelocities(pair.later);
  if (earlier.length === 0 || later.length === 0) return null;
  const matched = Math.max(earlier[earlier.length - 1], later[later.length - 1]);
  const earlierReps = repsToVelocity(earlier, matched);
  const laterReps = repsToVelocity(later, matched);
  if (earlierReps === null || laterReps === null) return null;
  return Math.min(1, laterReps / earlierReps);
}

function eligibleVelocities(set: RestSetInput): number[] {
  return eligibleRepsOf(set).map((rep) => getRepMeanVelocity(rep));
}

/** 1-based position of the first rep at or below `velocity`, or `null` if none reached it. */
function repsToVelocity(velocities: readonly number[], velocity: number): number | null {
  const index = velocities.findIndex((value) => value <= velocity);
  return index === -1 ? null : index + 1;
}

/**
 * This lifter's own ratio of learned rest to the population default, or `null`
 * when too few of their keys have finished calibrating to generalise from.
 */
function lifterFactor(records: readonly LearnedRecordSummary[]): number | null {
  const learned = records.filter((record) => record.state === 'learned');
  if (learned.length < ADAPTIVE_REST_POLICY.minLearnedRecordsForLifterFactor.value) return null;
  const ratios = learned
    .map((record) => record.valueSec / intentDefaultSec(record.intent))
    .sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  return ratios.length % 2 === 1 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
}

function evidenceWindow(input: EvaluateExerciseDayInput): readonly EvidencePair[] {
  const cutoffs = [
    input.runStartedOn,
    input.lastStepOn ?? '',
    addDays(input.on, -ADAPTIVE_REST_POLICY.evidenceWindowDays.value),
  ];
  const start = cutoffs.reduce((newest, date) => (date > newest ? date : newest), '');
  return input.evidence.filter((pair) => pair.on >= start && isInformativeVerdict(pair.verdict));
}

/** The ratio at which half the window's weight sits below and half above. */
function weightedMedian(window: readonly EvidencePair[]): number {
  const sorted = [...window].sort((a, b) => a.r - b.r);
  const half = sorted.reduce((sum, pair) => sum + pair.weight, 0) / 2;
  let running = 0;
  for (const pair of sorted) {
    running += pair.weight;
    if (running >= half) return pair.r;
  }
  return sorted[sorted.length - 1].r;
}

function held(
  input: EvaluateExerciseDayInput,
  decision: StepDecision,
  reason: StepReason,
  rMedian: number | null,
  informativePairs: number,
  pendingDirection: StepDirection | null,
): ExerciseDayEvaluation {
  return {
    step: {
      on: input.on,
      fromSec: input.valueSec,
      toSec: input.valueSec,
      decision,
      reason,
      signal: input.signal,
      rMedian,
      informativePairs,
      ignoredPairs: input.ignoredPairs,
    },
    clearsWindow: false,
    pendingDirection,
  };
}

function stepped(
  input: EvaluateExerciseDayInput,
  decision: StepDirection,
  reason: StepReason,
  rMedian: number,
  informativePairs: number,
): ExerciseDayEvaluation {
  const step = ADAPTIVE_REST_POLICY.stepSec.value;
  const proposed = decision === 'down' ? input.valueSec - step : input.valueSec + step;
  const toSec = clamp(proposed, floorSec(), ceilingSec());
  const clamped = toSec === input.valueSec;
  return {
    step: {
      on: input.on,
      fromSec: input.valueSec,
      toSec,
      decision,
      reason: clamped ? (decision === 'down' ? 'floor' : 'ceiling') : reason,
      signal: input.signal,
      rMedian,
      informativePairs,
      ignoredPairs: input.ignoredPairs,
    },
    clearsWindow: true,
    pendingDirection: null,
  };
}

function inRestartCooldown(input: RestConflictInput): boolean {
  const last = input.record?.lastRestartOn;
  if (last === undefined || input.on === undefined) return false;
  return input.on < addDays(last, ADAPTIVE_REST_POLICY.restartCooldownDays.value);
}
