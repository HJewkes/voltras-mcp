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

import {
  ADAPTIVE_REST_POLICY,
  evaluateExerciseDay,
  intentDefaultSec,
  nextState,
  pairsForExerciseDay,
  recoveryRatio,
  seedRest,
  signalForIntent,
  sortPair,
  targetFor,
  type EvidencePair,
  type IgnoredPairs,
  type LearnedRestState,
  type RestIntentKey,
  type RestSetInput,
  type RestSignal,
  type StepDecision,
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
  pendingDown: boolean;
  evidence: EvidencePair[];
  lastStepDecision?: StepDecision;
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
    if (sort.informative) {
      record.evidence.push({ on, r: sort.r as number, weight: sort.weight, verdict: sort.verdict });
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
    pendingDown: record.pendingDown,
    evidence: record.evidence,
    ignoredPairs: { rushed: 0, long: 0, invalid: 0 },
  });
  const { step } = evaluation;
  record.daysEvaluated += 1;
  record.pendingDown = evaluation.pendingDown;
  if (evaluation.clearsWindow) {
    record.evidence = [];
    record.lastStepOn = on;
    record.lastStepDecision = step.decision;
  }
  record.valueSec = step.toSec;
  record.state = nextState({
    current: record.state,
    daysEvaluated: record.daysEvaluated,
    informativePairs: record.informativePairs,
    newestDecision: step.decision,
    ...(record.lastStepDecision !== undefined
      ? { previousStepDecision: record.lastStepDecision }
      : {}),
  });
  return step.decision;
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
  const seeded = seedRest({ intent: config.intent, restLearning: true });
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
  return summarise(config, record, tally, signal);
}

function newRecord(valueSec: number): SimRecord {
  return {
    valueSec,
    state: 'calibrating',
    runStartedOn: localDate(0),
    daysEvaluated: 0,
    informativePairs: 0,
    pendingDown: false,
    evidence: [],
  };
}

interface Tally {
  underRecovered: number;
  pairs: number;
  restSec: number;
  upSteps: number;
  downSteps: number;
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
  record.state = 'calibrating';
  record.runStartedOn = on;
  record.daysEvaluated = 0;
  record.informativePairs = 0;
  record.pendingDown = false;
  record.evidence = [];
  delete record.lastStepOn;
  delete record.lastStepDecision;
}

const FALSE_LEARNED_STEPS = 2;

function summarise(
  config: Stage2Config,
  record: SimRecord,
  tally: Tally,
  signal: RestSignal,
): Stage2Result {
  const trueRest = trueRestFor(config.lifter, signal);
  const fixed = runOnFixedRest(config, intentDefaultSec(config.intent));
  const sessions = config.exerciseDays;
  const atLearned = tally.valueAtLearned;
  return {
    lifter: config.lifter.name,
    behaviour: config.behaviour,
    intent: config.intent,
    trueRestSec: Math.round(trueRest),
    finalSec: record.valueSec,
    daysToLearned: tally.daysToLearned,
    errorAtLearnedSec: atLearned === null ? null : Math.round(atLearned - clampTrue(trueRest)),
    errorAtDay12Sec:
      tally.valueAtDay12 === null ? null : Math.round(tally.valueAtDay12 - clampTrue(trueRest)),
    falseLearned:
      atLearned !== null && Math.abs(atLearned - clampTrue(trueRest)) > FALSE_LEARNED_STEPS * STEP,
    bounceAfterLearned:
      tally.daysAfterLearned === 0 ? 0 : tally.movesAfterLearned / tally.daysAfterLearned,
    underRecoveredShare: tally.pairs === 0 ? 0 : tally.underRecovered / tally.pairs,
    underRecoveredShareOnDefault: fixed.pairs === 0 ? 0 : fixed.underRecovered / fixed.pairs,
    restMinutesPerSession: tally.restSec / 60 / sessions,
    restMinutesPerSessionOnDefault: fixed.totalRestSec / 60 / sessions,
    upSteps: tally.upSteps,
    downSteps: tally.downSteps,
  };
}

/** The staircase can only ever report a value inside its own floor and ceiling. */
function clampTrue(trueRest: number): number {
  return Math.min(CEILING, Math.max(FLOOR, trueRest));
}
