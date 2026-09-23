// Stage 2 (VW-516, design s.10.3): run the PRODUCTION staircase on simulated
// lifters and measure what it does.
//
// Everything that decides anything here is imported from
// `src/analytics/adaptive-rest.ts`. This file simulates a lifter, hands the
// module sets, and records what the module decided. It re-implements no rule,
// so a default changed in the module is the default these numbers describe.
//
// One ordering note: the design evaluates an exercise-day at the first set
// start of the NEXT day. This runs the evaluation at the end of the day
// instead, which leaves exactly the same value in place for the next day's
// sets and saves carrying a day of pending pairs.

import { EMPTY_PHASE, type Rep } from '@voltras/workout-analytics';

import { addDays } from '../../src/plan/block-calendar.js';

import {
  ADAPTIVE_REST_POLICY,
  arrivals,
  evaluateExerciseDay,
  intentDefaultSec,
  nextState,
  pairsForExerciseDay,
  recoveryRatio,
  seedRest,
  settledValue,
  signalForIntent,
  sortPair,
  stepDirections,
  targetFor,
  type EvidencePair,
  type IgnoredPairs,
  type LearnedRecordSummary,
  type LearnedRestState,
  type RestBaseSource,
  type RestIntentKey,
  type RestSeed,
  type RestSetInput,
  type RestSignal,
  type RestStep,
  type StepDecision,
  type StepDirection,
} from '../../src/analytics/adaptive-rest.js';
import {
  afterRest,
  makeRng,
  performSet,
  type LifterParams,
  type SimulatedSet,
} from './lifter-model.js';

const STEP = ADAPTIVE_REST_POLICY.stepSec.value;

/**
 * How far below the target a pair must fall to count as under-recovered.
 *
 * The measurement CV, so "under-recovered" means a set the lifter would notice
 * rather than a ratio a hair under target. A staircase that converges ON the
 * target leaves about half its pairs a hair under it by construction, so
 * counting those would make the comparison against a long fixed rest
 * meaningless: the fixed rest wins simply by being too long.
 */
const UNDER_RECOVERED_MARGIN = 0.045;
const FLOOR = ADAPTIVE_REST_POLICY.floorSec.value;
const CEILING = ADAPTIVE_REST_POLICY.ceilingSec.value;

/** How a lifter deviates from the rest the wall asked for. */
export type Behaviour =
  | 'compliant'
  | 'rusher'
  | 'loiterer'
  | 'two_set'
  | 'load_ramp'
  | 'depth_jump'
  | 'plan_restart';

export interface SimLifter {
  readonly name: string;
  readonly params: LifterParams;
}

export interface Stage2Config {
  readonly lifter: SimLifter;
  readonly behaviour: Behaviour;
  readonly intent: RestIntentKey;
  readonly exerciseDays: number;
  readonly seed: number;
  /**
   * The lifter's other keys that have already settled, so `seedRest` can take
   * its lifter-factor path. Empty means the run starts from the population
   * default, which is every run the earlier stage 2 ever measured.
   */
  readonly otherRecords?: readonly LearnedRecordSummary[];
}

/** What one simulated run of the staircase produced. */
export interface Stage2Result {
  readonly lifter: string;
  readonly behaviour: Behaviour;
  readonly intent: RestIntentKey;
  readonly trueRestSec: number;
  readonly finalSec: number;
  readonly daysToLearned: number | null;
  readonly errorAtLearnedSec: number | null;
  readonly errorAtDay12Sec: number | null;
  readonly falseLearned: boolean;
  readonly bounceAfterLearned: number;
  readonly underRecoveredShare: number;
  readonly underRecoveredShareOnDefault: number;
  readonly restMinutesPerSession: number;
  readonly restMinutesPerSessionOnDefault: number;
  readonly upSteps: number;
  readonly downSteps: number;
  /** Arrivals this run reached, and the exercise-day each landed on. */
  readonly arrivalCount: number;
  readonly arrivalDays: readonly number[];
  readonly seedSec: number;
  readonly seedSource: RestBaseSource;
}

const BASE_DATE = Date.UTC(2026, 0, 5);
const DAY_MS = 24 * 60 * 60 * 1000;
const SETS_PER_DAY = 4;
const REP_TARGET = 8;
const DEEP_REP_TARGET = 11;
const WORKING_LOAD_LBS = 100;
const RAMP_LOAD_LBS = 80;

function localDate(day: number): string {
  return new Date(BASE_DATE + day * DAY_MS).toISOString().slice(0, 10);
}

function instant(day: number, secondsIntoDay: number): string {
  return new Date(BASE_DATE + day * DAY_MS + secondsIntoDay * 1000).toISOString();
}

function repsFrom(velocities: readonly number[]): Rep[] {
  return velocities.map((velocity, index) => ({
    repNumber: index + 1,
    concentric: {
      ...EMPTY_PHASE,
      peakVelocity: velocity,
      _totalVelocity: velocity,
      _movementSampleCount: 1,
    },
    eccentric: { ...EMPTY_PHASE },
  }));
}

/** The rest this lifter actually takes when the wall asks for `prescribedSec`. */
function actualRestFor(behaviour: Behaviour, prescribedSec: number, rng: () => number): number {
  if (behaviour === 'rusher') return prescribedSec * (1 - (0.2 + 0.2 * rng()));
  if (behaviour === 'loiterer') return prescribedSec + 30 + 30 * rng();
  return prescribedSec;
}

/** Was this pair's later set meaningfully short of recovered? */
function isUnderRecovered(ratio: number | null, signal: RestSignal): boolean {
  return ratio !== null && ratio < targetFor(signal) - UNDER_RECOVERED_MARGIN;
}

function setsPerDayFor(behaviour: Behaviour): number {
  return behaviour === 'two_set' ? 2 : SETS_PER_DAY;
}

function repTargetFor(behaviour: Behaviour, day: number): number {
  return behaviour === 'depth_jump' && day >= 6 ? DEEP_REP_TARGET : REP_TARGET;
}

function loadFor(behaviour: Behaviour, setIndex: number): number {
  return behaviour === 'load_ramp' && setIndex === 1 ? RAMP_LOAD_LBS : WORKING_LOAD_LBS;
}

interface DaySet {
  readonly input: RestSetInput;
  readonly simulated: SimulatedSet;
}

/** Perform one exercise-day at `prescribedSec` and return the sets as the module sees them. */
function performDay(
  config: Stage2Config,
  day: number,
  prescribedSec: number,
  rng: () => number,
): DaySet[] {
  const { params } = config.lifter;
  const sets: DaySet[] = [];
  let fatigue = 0;
  let clock = 0;
  for (let index = 1; index <= setsPerDayFor(config.behaviour); index += 1) {
    const targetReps = repTargetFor(config.behaviour, day);
    const done = performSet(params, fatigue, { targetReps }, rng);
    const duration = Math.max(1, done.repsDone * 4);
    sets.push({
      input: buildSetInput(config, day, index, clock, duration, done),
      simulated: done,
    });
    const rest = actualRestFor(config.behaviour, prescribedSec, rng);
    fatigue = afterRest(params, done.fatigueAfter, rest);
    clock += duration + rest;
  }
  return sets;
}

function buildSetInput(
  config: Stage2Config,
  day: number,
  index: number,
  startSec: number,
  duration: number,
  done: SimulatedSet,
): RestSetInput {
  return {
    id: `d${day}s${index}`,
    exerciseId: 'sim-exercise',
    startedAt: instant(day, startSec),
    endedAt: instant(day, startSec + duration),
    reps: repsFrom(done.velocities),
    weightLbs: loadFor(config.behaviour, index),
    slot: 'primary',
    kind: 'training',
    constantLoad: true,
    velocitySignalValid: true,
  };
}

/** The record the store will hold, kept here so the pure functions can be driven. */
interface SimRecord {
  valueSec: number;
  state: LearnedRestState;
  runStartedOn: string;
  lastStepOn?: string;
  daysEvaluated: number;
  /** Informative pairs since the run started. A step empties the window, never this. */
  informativePairs: number;
  pendingDirection: StepDirection | null;
  evidence: EvidencePair[];
  lastStepDecision?: StepDecision;
  history: RestStep[];
  /** Local date the run became `learned`, so only later steps can un-settle it. */
  learnedOn?: string;
}

/** Sort one day's pairs and fold them into the record's evidence. */
function collectEvidence(
  sets: readonly DaySet[],
  record: SimRecord,
  signal: RestSignal,
  on: string,
): { ignored: IgnoredPairs; underRecovered: number; sets: number } {
  const { valid, rejected } = pairsForExerciseDay({
    exerciseId: 'sim-exercise',
    daySets: sets.map((entry) => entry.input),
  });
  const ignored = { rushed: 0, long: 0, invalid: rejected.length };
  let underRecovered = 0;
  for (const pair of valid) {
    const sort = sortPair(pair, record.valueSec, signal);
    if (isUnderRecovered(sort.r, signal)) underRecovered += 1;
    if (sort.r !== null) {
      record.evidence.push({
        on,
        r: sort.r,
        weight: sort.weight,
        verdict: sort.verdict,
        inWindow: sort.inWindow,
      });
    }
    if (sort.informative) {
      record.informativePairs += 1;
    } else if (sort.verdict === 'rushed') ignored.rushed += 1;
    else if (sort.verdict === 'long') ignored.long += 1;
    else ignored.invalid += 1;
  }
  return { ignored, underRecovered, sets: valid.length };
}

/** Apply one evaluation to the record, exactly as the store task will. */
function applyEvaluation(record: SimRecord, signal: RestSignal, on: string): StepDecision {
  const evaluation = evaluateExerciseDay({
    on,
    valueSec: record.valueSec,
    state: record.state,
    signal,
    runStartedOn: record.runStartedOn,
    ...(record.lastStepOn !== undefined ? { lastStepOn: record.lastStepOn } : {}),
    pendingDirection: record.pendingDirection,
    evidence: record.evidence,
    ignoredPairs: { rushed: 0, long: 0, invalid: 0 },
  });
  const { step } = evaluation;
  record.history.push(step);
  record.daysEvaluated += 1;
  record.pendingDirection = evaluation.pendingDirection;
  if (evaluation.clearsWindow) {
    record.evidence = [];
    record.lastStepOn = on;
    record.lastStepDecision = step.decision;
  }
  record.valueSec = step.toSec;
  advanceState(record, on);
  return step.decision;
}

/**
 * Move the record's state, and do what each transition obliges the caller to
 * do: settle on the bracketed value when a run becomes learned, and start a new
 * run when a learned one goes back to calibrating.
 */
function advanceState(record: SimRecord, on: string): void {
  const found = arrivals(record.history);
  const wasLearned = record.state === 'learned';
  record.state = nextState({
    current: record.state,
    daysEvaluated: record.daysEvaluated,
    informativePairs: record.informativePairs,
    arrivals: found,
    stepsSinceLearned: stepDirections(record.history, record.learnedOn ?? on),
  });
  if (!wasLearned && record.state === 'learned') {
    record.valueSec = settledValue(found) ?? record.valueSec;
    record.learnedOn = addDays(on, 1);
  }
  if (wasLearned && record.state === 'calibrating') restartRun(record, on);
}

/**
 * The rest at which this lifter's expected recovery ratio just reaches the
 * target: the number the staircase is trying to find. Measured on a noiseless
 * copy of the lifter, by bisection.
 */
export function trueRestFor(lifter: SimLifter, signal: RestSignal): number {
  const quiet: LifterParams = { ...lifter.params, cv: 0 };
  let low = 5;
  let high = 900;
  for (let i = 0; i < 40; i += 1) {
    const mid = (low + high) / 2;
    if (ratioAtRest(quiet, mid, signal) >= targetFor(signal)) high = mid;
    else low = mid;
  }
  return high;
}

function ratioAtRest(params: LifterParams, restSec: number, signal: RestSignal): number {
  const rng = makeRng(7);
  const first = performSet(params, 0, { targetReps: REP_TARGET }, rng);
  const fatigue = afterRest(params, first.fatigueAfter, restSec);
  const second = performSet(params, fatigue, { targetReps: REP_TARGET }, rng);
  const pair = {
    earlier: syntheticSet(first, 'a'),
    later: syntheticSet(second, 'b'),
    reference: syntheticSet(first, 'a'),
    actualRestSec: restSec,
    laterSetIndex: 2,
    weight: 1,
  };
  return recoveryRatio(pair, signal) ?? 0;
}

function syntheticSet(done: SimulatedSet, id: string): RestSetInput {
  return {
    id,
    exerciseId: 'sim-exercise',
    startedAt: instant(0, 0),
    endedAt: instant(0, 60),
    reps: repsFrom(done.velocities),
    weightLbs: WORKING_LOAD_LBS,
    slot: 'primary',
    kind: 'training',
    constantLoad: true,
    velocitySignalValid: true,
  };
}

/** The comparison arm: the same lifter, same days, on the fixed intent default. */
function runOnFixedRest(config: Stage2Config, restSec: number) {
  const rng = makeRng(config.seed);
  const signal = signalForIntent(config.intent);
  let underRecovered = 0;
  let totalRestSec = 0;
  let pairs = 0;
  for (let day = 0; day < config.exerciseDays; day += 1) {
    const sets = performDay(config, day, restSec, rng);
    const { valid } = pairsForExerciseDay({
      exerciseId: 'sim-exercise',
      daySets: sets.map((entry) => entry.input),
    });
    pairs += valid.length;
    for (const pair of valid) {
      if (isUnderRecovered(recoveryRatio(pair, signal), signal)) underRecovered += 1;
    }
    totalRestSec += restSec * Math.max(0, setsPerDayFor(config.behaviour) - 1);
  }
  return { underRecovered, totalRestSec, pairs };
}

const PLAN_RESTART_DAY = 6;
const PLAN_RESTART_SEC = 210;

/** Run the staircase for one lifter, behaviour and intent. */
export function runStage2(config: Stage2Config): Stage2Result {
  const signal = signalForIntent(config.intent);
  const rng = makeRng(config.seed);
  const seeded = seedRest({
    intent: config.intent,
    restLearning: true,
    ...(config.otherRecords !== undefined ? { otherRecords: config.otherRecords } : {}),
  });
  const record = newRecord(seeded.seconds);
  const tally = newTally();
  for (let day = 0; day < config.exerciseDays; day += 1) {
    const on = localDate(day);
    maybeRestart(config, day, on, record);
    const before = record.valueSec;
    const sets = performDay(config, day, before, rng);
    const collected = collectEvidence(sets, record, signal, on);
    tally.underRecovered += collected.underRecovered;
    tally.pairs += collected.sets;
    tally.restSec += before * Math.max(0, setsPerDayFor(config.behaviour) - 1);
    const decision = applyEvaluation(record, signal, on);
    recordStep(tally, record, decision, day, before);
  }
  return summarise(config, record, tally, signal, seeded);
}

function newRecord(valueSec: number): SimRecord {
  return {
    valueSec,
    state: 'calibrating',
    runStartedOn: localDate(0),
    daysEvaluated: 0,
    informativePairs: 0,
    pendingDirection: null,
    evidence: [],
    history: [],
  };
}

interface Tally {
  underRecovered: number;
  pairs: number;
  restSec: number;
  upSteps: number;
  downSteps: number;
  arrivalDays: number[];
  daysToLearned: number | null;
  valueAtLearned: number | null;
  valueAtDay12: number | null;
  daysAfterLearned: number;
  movesAfterLearned: number;
}

function newTally(): Tally {
  return {
    underRecovered: 0,
    pairs: 0,
    restSec: 0,
    upSteps: 0,
    downSteps: 0,
    arrivalDays: [],
    daysToLearned: null,
    valueAtLearned: null,
    valueAtDay12: null,
    daysAfterLearned: 0,
    movesAfterLearned: 0,
  };
}

function recordStep(
  tally: Tally,
  record: SimRecord,
  decision: StepDecision,
  day: number,
  before: number,
): void {
  if (decision === 'up') tally.upSteps += 1;
  if (decision === 'down') tally.downSteps += 1;
  const reached = arrivals(record.history).length;
  while (tally.arrivalDays.length < reached) tally.arrivalDays.push(day + 1);
  if (record.state === 'learned' && tally.daysToLearned === null) {
    tally.daysToLearned = day + 1;
    tally.valueAtLearned = record.valueSec;
  }
  if (record.state === 'learned' && tally.daysToLearned !== null && day + 1 > tally.daysToLearned) {
    tally.daysAfterLearned += 1;
    if (record.valueSec !== before) tally.movesAfterLearned += 1;
  }
  if (day === 11) tally.valueAtDay12 = record.valueSec;
}

/** The plan-restart behaviour: a planner writes a differing rest, and first use restarts. */
function maybeRestart(config: Stage2Config, day: number, on: string, record: SimRecord): void {
  if (config.behaviour !== 'plan_restart' || day !== PLAN_RESTART_DAY) return;
  record.valueSec = PLAN_RESTART_SEC;
  restartRun(record, on);
}

/** Start a new run at the current value: the arrival count restarts with it. */
function restartRun(record: SimRecord, on: string): void {
  record.state = 'calibrating';
  record.runStartedOn = on;
  record.daysEvaluated = 0;
  record.informativePairs = 0;
  record.pendingDirection = null;
  record.evidence = [];
  record.history = [];
  delete record.lastStepOn;
  delete record.lastStepDecision;
  delete record.learnedOn;
}

const FALSE_LEARNED_STEPS = 2;

function summarise(
  config: Stage2Config,
  record: SimRecord,
  tally: Tally,
  signal: RestSignal,
  seeded: RestSeed,
): Stage2Result {
  const trueRest = trueRestFor(config.lifter, signal);
  const fixed = runOnFixedRest(config, intentDefaultSec(config.intent));
  const sessions = config.exerciseDays;
  const atLearned = tally.valueAtLearned;
  const target = clampTrue(trueRest);
  return {
    lifter: config.lifter.name,
    behaviour: config.behaviour,
    intent: config.intent,
    trueRestSec: Math.round(trueRest),
    finalSec: record.valueSec,
    daysToLearned: tally.daysToLearned,
    errorAtLearnedSec: atLearned === null ? null : Math.round(atLearned - target),
    errorAtDay12Sec: tally.valueAtDay12 === null ? null : Math.round(tally.valueAtDay12 - target),
    falseLearned: atLearned !== null && Math.abs(atLearned - target) > FALSE_LEARNED_STEPS * STEP,
    bounceAfterLearned:
      tally.daysAfterLearned === 0 ? 0 : tally.movesAfterLearned / tally.daysAfterLearned,
    ...restShares(tally, fixed, sessions),
    upSteps: tally.upSteps,
    downSteps: tally.downSteps,
    arrivalCount: tally.arrivalDays.length,
    arrivalDays: tally.arrivalDays,
    seedSec: seeded.seconds,
    seedSource: seeded.baseSource,
  };
}

/** The two rest-volume figures and the two under-recovered shares, as one block. */
function restShares(tally: Tally, fixed: FixedArm, sessions: number) {
  return {
    underRecoveredShare: tally.pairs === 0 ? 0 : tally.underRecovered / tally.pairs,
    underRecoveredShareOnDefault: fixed.pairs === 0 ? 0 : fixed.underRecovered / fixed.pairs,
    restMinutesPerSession: tally.restSec / 60 / sessions,
    restMinutesPerSessionOnDefault: fixed.totalRestSec / 60 / sessions,
  };
}

type FixedArm = ReturnType<typeof runOnFixedRest>;

/** The staircase can only ever report a value inside its own floor and ceiling. */
function clampTrue(trueRest: number): number {
  return Math.min(CEILING, Math.max(FLOOR, trueRest));
}

/**
 * How often a lifter who is still MARCHING reads a false arrival.
 *
 * This is the number that decides between two arrivals and three (amendment
 * s.3.2). A marching staircase should turn only when it reaches the lifter's
 * rest; a turn while it is still travelling is noise reading as arrival. The
 * run is set up so the true rest is far below the seed, which means every
 * reversal before the staircase gets there is false by construction.
 */
export interface FalseArrivalResult {
  readonly runs: number;
  readonly days: number;
  /** Runs that produced at least one arrival while still more than two steps from the rest. */
  readonly runsWithFalseArrival: number;
  /** Runs that reached the arrival minimum while still that far away. */
  readonly runsFalselyLearned: number;
  readonly falseArrivalsPerRun: number;
}

const FALSE_ARRIVAL_MARGIN_STEPS = 2;

export function falseArrivalRate(
  lifter: SimLifter,
  intent: RestIntentKey,
  runs: number,
  exerciseDays: number,
): FalseArrivalResult {
  const signal = signalForIntent(intent);
  const trueRest = trueRestFor(lifter, signal);
  let withFalse = 0;
  let falselyLearned = 0;
  let arrivalTotal = 0;
  for (let run = 0; run < runs; run += 1) {
    const result = runStage2({
      lifter,
      behaviour: 'compliant',
      intent,
      exerciseDays,
      seed: 7000 + run,
    });
    const far = Math.abs(result.finalSec - trueRest) > FALSE_ARRIVAL_MARGIN_STEPS * STEP;
    arrivalTotal += result.arrivalCount;
    if (far && result.arrivalCount > 0) withFalse += 1;
    if (far && result.daysToLearned !== null) falselyLearned += 1;
  }
  return {
    runs,
    days: exerciseDays,
    runsWithFalseArrival: withFalse,
    runsFalselyLearned: falselyLearned,
    falseArrivalsPerRun: arrivalTotal / runs,
  };
}
