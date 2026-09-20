// The adaptive-rest staircase (VW-445 / VW-515), rule by rule.
//
// Nothing here is wired to a caller yet, so these tests ARE the specification:
// every validity rule, both recovery ratios, the pair sort, the step, the
// clamps, the state rule, the seed order and the plan-versus-learned table are
// pinned against the design (2026-09-19-vw-445-adaptive-rest-design.md).
//
// Rep fixtures carry `_movementSampleCount: 1`, which is below
// `selectEligibleReps`' 2-sample floor, so the eligibility filter falls back to
// the untouched list and these tests exercise the staircase rather than the
// outlier gate. Mean and peak velocity are the same number on such a rep, which
// keeps the fixtures readable while the module reads MEAN throughout.

import { describe, expect, it } from 'vitest';
import { EMPTY_PHASE, type Rep } from '@voltras/workout-analytics';

import {
  ADAPTIVE_REST_POLICY,
  evaluateExerciseDay,
  intentDefaultSec,
  nextState,
  pairsForExerciseDay,
  recoveryRatio,
  restConflictFor,
  seedRest,
  signalForIntent,
  sortPair,
  type EvidencePair,
  type IgnoredPairs,
  type LearnedRecordSummary,
  type RestPair,
  type RestSetInput,
} from '../adaptive-rest.js';

const DAY = '2026-09-19';
const STEP = ADAPTIVE_REST_POLICY.stepSec.value;
const NO_IGNORED: IgnoredPairs = { rushed: 0, long: 0, invalid: 0 };

/** An instant `seconds` after noon on {@link DAY}, so a fixture reads as a clock. */
function at(seconds: number): string {
  return new Date(Date.parse(`${DAY}T12:00:00.000Z`) + seconds * 1000).toISOString();
}

function makeRep(repNumber: number, velocity: number): Rep {
  return {
    repNumber,
    concentric: {
      ...EMPTY_PHASE,
      peakVelocity: velocity,
      _totalVelocity: velocity,
      _movementSampleCount: 1,
    },
    eccentric: { ...EMPTY_PHASE },
  };
}

function repsOf(velocities: readonly number[]): Rep[] {
  return velocities.map((velocity, index) => makeRep(index + 1, velocity));
}

/** A 20%-loss working set: deep enough to be evidence, five reps, one load. */
const DEEP = [1.0, 0.95, 0.9, 0.85, 0.8] as const;

interface SetSpec extends Partial<RestSetInput> {
  readonly id: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly velocities?: readonly number[];
}

function makeSet(spec: SetSpec): RestSetInput {
  const { startSec, endSec, velocities, ...rest } = spec;
  return {
    exerciseId: 'bench',
    startedAt: at(startSec),
    endedAt: at(endSec),
    reps: repsOf(velocities ?? DEEP),
    weightLbs: 100,
    slot: 'primary',
    kind: 'training',
    constantLoad: true,
    velocitySignalValid: true,
    ...rest,
  };
}

/** Two sets 120 s apart: the ordinary straight-set day the rules are written for. */
function twoSetDay(overrides: { first?: Partial<SetSpec>; second?: Partial<SetSpec> } = {}): {
  readonly exerciseId: string;
  readonly daySets: RestSetInput[];
} {
  return {
    exerciseId: 'bench',
    daySets: [
      makeSet({ id: 's1', startSec: 0, endSec: 40, ...overrides.first }),
      makeSet({ id: 's2', startSec: 160, endSec: 200, ...overrides.second }),
    ],
  };
}

describe('pairsForExerciseDay: what counts as evidence (design s.4.1)', () => {
  it('pairs two consecutive working sets and measures the rest between them', () => {
    const { valid, rejected } = pairsForExerciseDay(twoSetDay());
    expect(rejected).toHaveLength(0);
    expect(valid).toHaveLength(1);
    expect(valid[0].actualRestSec).toBe(120);
    expect(valid[0].laterSetIndex).toBe(2);
  });

  it('measures the rest to the first rep when the store holds one', () => {
    const day = twoSetDay({ second: { workStartedAt: at(175) } });
    expect(pairsForExerciseDay(day).valid[0].actualRestSec).toBe(135);
  });

  it('rejects a pair whose sets do not both carry enough eligible reps', () => {
    const day = twoSetDay({ second: { velocities: [1.0, 0.8] } });
    expect(pairsForExerciseDay(day).rejected[0].reason).toBe('too_few_reps');
  });

  it('rejects a pair across two loads', () => {
    const day = twoSetDay({ second: { weightLbs: 110 } });
    expect(pairsForExerciseDay(day).rejected[0].reason).toBe('load_differs');
  });

  it('allows a load that moved by less than the tolerance', () => {
    const day = twoSetDay({ second: { weightLbs: 100.5 } });
    expect(pairsForExerciseDay(day).valid).toHaveLength(1);
  });

  it('rejects a pair with an unknown load rather than assuming it held', () => {
    const day = twoSetDay({ second: { weightLbs: undefined } });
    expect(pairsForExerciseDay(day).rejected[0].reason).toBe('load_differs');
  });

  it('rejects a pair recorded in a non-constant-load mode', () => {
    const day = twoSetDay({ second: { constantLoad: false } });
    expect(pairsForExerciseDay(day).rejected[0].reason).toBe('not_constant_load');
  });

  it('rejects a pair with no valid velocity signal', () => {
    const day = twoSetDay({ second: { velocitySignalValid: false } });
    expect(pairsForExerciseDay(day).rejected[0].reason).toBe('no_velocity_signal');
  });

  it('rejects a pair recorded on two different sides', () => {
    const day = twoSetDay({ second: { slot: 'left' } });
    expect(pairsForExerciseDay(day).rejected[0].reason).toBe('slot_differs');
  });

  it('rejects a pair whose earlier set did no real work', () => {
    const day = twoSetDay({ first: { velocities: [1.0, 1.0, 0.98, 0.97, 0.95] } });
    expect(pairsForExerciseDay(day).rejected[0].reason).toBe('too_shallow');
  });

  it('rejects a rest too short to be a rest', () => {
    const day = twoSetDay({ second: { startSec: 60, endSec: 100 } });
    expect(pairsForExerciseDay(day).rejected[0].reason).toBe('rest_too_short');
  });

  it("rejects a pair with another exercise's set inside the rest", () => {
    const day = twoSetDay();
    day.daySets.push(makeSet({ id: 'row', exerciseId: 'row', startSec: 60, endSec: 100 }));
    expect(pairsForExerciseDay(day).rejected[0].reason).toBe('interleaved');
  });

  it('rejects a pair with a warm-up of the same exercise inside the rest', () => {
    const day = twoSetDay();
    day.daySets.push(makeSet({ id: 'w', startSec: 60, endSec: 100, setPurpose: 'warmup' }));
    expect(pairsForExerciseDay(day).rejected[0].reason).toBe('interleaved');
  });

  it('never pairs a warm-up, probe or technique set', () => {
    for (const setPurpose of ['warmup', 'probe', 'technique'] as const) {
      const day = twoSetDay({ second: { setPurpose } });
      expect(pairsForExerciseDay(day).valid).toHaveLength(0);
      expect(pairsForExerciseDay(day).rejected).toHaveLength(0);
    }
  });

  it('never pairs an unreviewed or test session (VW-489)', () => {
    for (const kind of [undefined, 'test' as const]) {
      const day = twoSetDay({ second: { kind } });
      expect(pairsForExerciseDay(day).valid).toHaveLength(0);
    }
  });

  it('never pairs a mock-adapter set', () => {
    const day = twoSetDay({ second: { source: 'mock' } });
    expect(pairsForExerciseDay(day).valid).toHaveLength(0);
  });

  it("never pairs a guest's set", () => {
    const day = twoSetDay({ second: { lifter: 'Jordan' } });
    expect(pairsForExerciseDay(day).valid).toHaveLength(0);
  });

  it("a guest's set inside the rest does not cost the owner the pair", () => {
    const day = twoSetDay();
    day.daySets.push(makeSet({ id: 'g', startSec: 60, endSec: 100, lifter: 'Jordan' }));
    expect(pairsForExerciseDay(day).valid).toHaveLength(1);
  });
});

describe('pairsForExerciseDay: weights (design s.4.5)', () => {
  it('weighs sets 2 and 3 full and set 4 onward half', () => {
    const daySets = [0, 1, 2, 3, 4].map((index) =>
      makeSet({ id: `s${index}`, startSec: index * 200, endSec: index * 200 + 40 }),
    );
    const { valid } = pairsForExerciseDay({ exerciseId: 'bench', daySets });
    expect(valid.map((pair) => pair.laterSetIndex)).toEqual([2, 3, 4, 5]);
    expect(valid.map((pair) => pair.weight)).toEqual([1, 1, 0.5, 0.5]);
  });
});

describe('recoveryRatio (design s.4.2)', () => {
  function pairOf(earlier: RestSetInput, later: RestSetInput, actualRestSec = 120): RestPair {
    return { earlier, later, reference: earlier, actualRestSec, laterSetIndex: 2, weight: 1 };
  }

  it('reads opening velocity as the better of the first two eligible reps', () => {
    const earlier = makeSet({ id: 'a', startSec: 0, endSec: 40, velocities: [0.9, 1.0, 0.8] });
    const later = makeSet({ id: 'b', startSec: 160, endSec: 200, velocities: [0.8, 0.9, 0.7] });
    expect(recoveryRatio(pairOf(earlier, later), 'opening_velocity')).toBeCloseTo(0.9, 5);
  });

  it('caps opening velocity at 1: opening faster than the reference is not extra evidence', () => {
    const earlier = makeSet({ id: 'a', startSec: 0, endSec: 40, velocities: [1.0, 0.9, 0.8] });
    const later = makeSet({ id: 'b', startSec: 160, endSec: 200, velocities: [1.2, 1.1, 1.0] });
    expect(recoveryRatio(pairOf(earlier, later), 'opening_velocity')).toBe(1);
  });

  it('reads opening velocity against the reference set, not the previous one', () => {
    const reference = makeSet({ id: 'r', startSec: 0, endSec: 40, velocities: [1.0, 0.9, 0.8] });
    const earlier = makeSet({ id: 'a', startSec: 200, endSec: 240, velocities: [0.9, 0.8, 0.7] });
    const later = makeSet({ id: 'b', startSec: 400, endSec: 440, velocities: [0.8, 0.7, 0.6] });
    const pair: RestPair = {
      earlier,
      later,
      reference,
      actualRestSec: 160,
      laterSetIndex: 3,
      weight: 1,
    };
    expect(recoveryRatio(pair, 'opening_velocity')).toBeCloseTo(0.8, 5);
  });

  it("reproduces the design's worked reps-preserved example: 12 reps each, R = 0.75", () => {
    const earlier = makeSet({
      id: 'a',
      startSec: 0,
      endSec: 40,
      velocities: [1.0, 0.96, 0.92, 0.88, 0.84, 0.8, 0.7, 0.62, 0.55, 0.5, 0.45, 0.4],
    });
    const later = makeSet({
      id: 'b',
      startSec: 160,
      endSec: 200,
      velocities: [0.95, 0.9, 0.85, 0.75, 0.65, 0.55, 0.48, 0.44, 0.4, 0.37, 0.35, 0.33],
    });
    expect(recoveryRatio(pairOf(earlier, later), 'reps_preserved')).toBeCloseTo(0.75, 5);
  });

  it('is defined for a set that never reaches any velocity-loss threshold', () => {
    const earlier = makeSet({ id: 'a', startSec: 0, endSec: 40, velocities: [1.0, 0.99, 0.98] });
    const later = makeSet({ id: 'b', startSec: 160, endSec: 200, velocities: [1.0, 0.99, 0.97] });
    expect(recoveryRatio(pairOf(earlier, later), 'reps_preserved')).toBeCloseTo(1, 5);
  });

  it('caps reps preserved at 1 when the later set held the velocity longer', () => {
    const earlier = makeSet({ id: 'a', startSec: 0, endSec: 40, velocities: [1.0, 0.7, 0.5] });
    const later = makeSet({ id: 'b', startSec: 160, endSec: 200, velocities: [1.0, 0.9, 0.5] });
    expect(recoveryRatio(pairOf(earlier, later), 'reps_preserved')).toBe(1);
  });

  it('is null when a set carries no reps to read', () => {
    const earlier = makeSet({ id: 'a', startSec: 0, endSec: 40 });
    const later = makeSet({ id: 'b', startSec: 160, endSec: 200, velocities: [] });
    expect(recoveryRatio(pairOf(earlier, later), 'reps_preserved')).toBeNull();
    expect(recoveryRatio(pairOf(earlier, later), 'opening_velocity')).toBeNull();
  });
});

describe('sortPair: the 2x2 against the probed rest (design s.4.4)', () => {
  const TOL = ADAPTIVE_REST_POLICY.toleranceSec.value;
  const T = 120;

  /** A pair whose opening-velocity ratio is exactly `r`, rested `actualRestSec`. */
  function pairWithRatio(r: number, actualRestSec: number): RestPair {
    const earlier = makeSet({ id: 'a', startSec: 0, endSec: 40, velocities: [1.0, 1.0, 0.8] });
    const later = makeSet({ id: 'b', startSec: 160, endSec: 200, velocities: [r, r, 0.5] });
    return { earlier, later, reference: earlier, actualRestSec, laterSetIndex: 2, weight: 1 };
  }

  it('calls a rest inside the window that met the target recovered, and counts it', () => {
    const sort = sortPair(pairWithRatio(0.96, T), T, 'opening_velocity');
    expect(sort.verdict).toBe('recovered');
    expect(sort.informative).toBe(true);
  });

  it('calls a rest inside the window that missed the target missed, and counts it', () => {
    const sort = sortPair(pairWithRatio(0.9, T), T, 'opening_velocity');
    expect(sort.verdict).toBe('missed');
    expect(sort.informative).toBe(true);
  });

  it('counts a SHORT rest that recovered anyway: the monotone case that shortens T', () => {
    const sort = sortPair(pairWithRatio(0.96, T - TOL - 30), T, 'opening_velocity');
    expect(sort.verdict).toBe('recovered');
    expect(sort.informative).toBe(true);
  });

  it('counts a LONG rest that missed anyway: the monotone case that lengthens T', () => {
    const sort = sortPair(pairWithRatio(0.9, T + TOL + 30), T, 'opening_velocity');
    expect(sort.verdict).toBe('missed');
    expect(sort.informative).toBe(true);
  });

  it('ignores a short rest that missed: it says nothing about T', () => {
    const sort = sortPair(pairWithRatio(0.9, T - TOL - 30), T, 'opening_velocity');
    expect(sort.verdict).toBe('rushed');
    expect(sort.informative).toBe(false);
  });

  it('ignores a long rest that recovered: it says nothing about T either', () => {
    const sort = sortPair(pairWithRatio(0.96, T + TOL + 30), T, 'opening_velocity');
    expect(sort.verdict).toBe('long');
    expect(sort.informative).toBe(false);
  });

  it('is invalid, and never informative, when no ratio could be computed', () => {
    const earlier = makeSet({ id: 'a', startSec: 0, endSec: 40 });
    const later = makeSet({ id: 'b', startSec: 160, endSec: 200, velocities: [] });
    const pair: RestPair = {
      earlier,
      later,
      reference: earlier,
      actualRestSec: 120,
      laterSetIndex: 2,
      weight: 1,
    };
    const sort = sortPair(pair, T, 'opening_velocity');
    expect(sort.verdict).toBe('invalid');
    expect(sort.informative).toBe(false);
  });

  it('sorts against T and not against a rest the valve lengthened', () => {
    const sort = sortPair(pairWithRatio(0.9, T + 45), T, 'opening_velocity');
    expect(sort.verdict).toBe('missed');
  });
});

describe('evaluateExerciseDay: the step (design s.4.6)', () => {
  function evidenceOf(ratios: readonly number[], weight = 1): EvidencePair[] {
    return ratios.map((r) => ({ on: DAY, r, weight, verdict: 'recovered' as const }));
  }

  function evaluate(over: Partial<Parameters<typeof evaluateExerciseDay>[0]> = {}) {
    return evaluateExerciseDay({
      on: DAY,
      valueSec: 120,
      state: 'calibrating',
      signal: 'opening_velocity',
      runStartedOn: '2026-09-01',
      evidence: evidenceOf([0.99, 0.99]),
      ignoredPairs: NO_IGNORED,
      ...over,
    });
  }

  it('does nothing on a day whose evidence is too light to decide', () => {
    const { step, clearsWindow } = evaluate({ evidence: evidenceOf([0.99]) });
    expect(step.decision).toBe('no_evidence');
    expect(step.reason).toBe('too_few_pairs');
    expect(step.toSec).toBe(step.fromSec);
    expect(clearsWindow).toBe(false);
  });

  it('steps down when the median clears the target, and empties the window', () => {
    const { step, clearsWindow } = evaluate();
    expect(step.decision).toBe('down');
    expect(step.reason).toBe('recovered');
    expect(step.toSec).toBe(120 - STEP);
    expect(clearsWindow).toBe(true);
  });

  it('steps up when the median falls below the target', () => {
    const { step } = evaluate({ evidence: evidenceOf([0.8, 0.8]) });
    expect(step.decision).toBe('up');
    expect(step.reason).toBe('missed');
    expect(step.toSec).toBe(120 + STEP);
  });

  it('holds inside the dead band and keeps the window', () => {
    const { step, clearsWindow } = evaluate({ evidence: evidenceOf([0.95, 0.95]) });
    expect(step.decision).toBe('hold');
    expect(step.reason).toBe('dead_band');
    expect(step.toSec).toBe(120);
    expect(clearsWindow).toBe(false);
  });

  it('holds at exactly one dead band below the target rather than lengthening', () => {
    const { step } = evaluate({ evidence: evidenceOf([0.93, 0.93]) });
    expect(step.decision).toBe('hold');
  });

  it('records a step the floor cancels as a floor, not as a move', () => {
    const { step } = evaluate({ valueSec: ADAPTIVE_REST_POLICY.floorSec.value });
    expect(step.decision).toBe('down');
    expect(step.reason).toBe('floor');
    expect(step.toSec).toBe(ADAPTIVE_REST_POLICY.floorSec.value);
  });

  it('records a step the ceiling cancels as a ceiling', () => {
    const { step } = evaluate({
      valueSec: ADAPTIVE_REST_POLICY.ceilingSec.value,
      evidence: evidenceOf([0.8, 0.8]),
    });
    expect(step.decision).toBe('up');
    expect(step.reason).toBe('ceiling');
    expect(step.toSec).toBe(ADAPTIVE_REST_POLICY.ceilingSec.value);
  });

  it('reads half-weight pairs as half: four late pairs still decide', () => {
    const { step } = evaluate({ evidence: evidenceOf([0.99, 0.99, 0.99, 0.99], 0.5) });
    expect(step.decision).toBe('down');
  });

  it('two half-weight pairs are too light to decide', () => {
    const { step } = evaluate({ evidence: evidenceOf([0.99, 0.99], 0.5) });
    expect(step.decision).toBe('no_evidence');
  });

  it('ignores evidence older than the window', () => {
    const stale = evidenceOf([0.99, 0.99]).map((pair) => ({ ...pair, on: '2026-08-01' }));
    expect(evaluate({ evidence: stale }).step.decision).toBe('no_evidence');
  });

  it('ignores evidence from before the newest step, which judged the old value', () => {
    const before = evidenceOf([0.99, 0.99]).map((pair) => ({ ...pair, on: '2026-09-10' }));
    const input = { evidence: before, lastStepOn: '2026-09-15' };
    expect(evaluate(input).step.decision).toBe('no_evidence');
  });

  it('counts pairs the window kept and reports the day it ignored', () => {
    const ignored: IgnoredPairs = { rushed: 2, long: 1, invalid: 0 };
    const { step } = evaluate({ ignoredPairs: ignored });
    expect(step.informativePairs).toBe(2);
    expect(step.ignoredPairs).toEqual(ignored);
    expect(step.rMedian).toBeCloseTo(0.99, 5);
  });

  describe('the two-day rule once learned', () => {
    it('holds the first qualifying day rather than shortening straight away', () => {
      const { step, clearsWindow, pendingDown } = evaluate({ state: 'learned' });
      expect(step.decision).toBe('hold');
      expect(step.reason).toBe('recovered');
      expect(clearsWindow).toBe(false);
      expect(pendingDown).toBe(true);
    });

    it('shortens on the second consecutive qualifying day', () => {
      const { step, pendingDown } = evaluate({ state: 'learned', pendingDown: true });
      expect(step.decision).toBe('down');
      expect(step.toSec).toBe(120 - STEP);
      expect(pendingDown).toBe(false);
    });

    it('lengthens on one day, learned or not', () => {
      const { step } = evaluate({ state: 'learned', evidence: evidenceOf([0.8, 0.8]) });
      expect(step.decision).toBe('up');
    });

    it('does not hold a calibrating run: it shortens on the first qualifying day', () => {
      expect(evaluate().step.decision).toBe('down');
    });
  });
});

describe('nextState (design s.4.8)', () => {
  const READY = {
    current: 'calibrating' as const,
    daysEvaluated: ADAPTIVE_REST_POLICY.learnedMinDaysEvaluated.value,
    informativePairs: ADAPTIVE_REST_POLICY.learnedMinInformativePairs.value,
    newestDecision: 'hold' as const,
  };

  it('reads learned once enough days and pairs are in with no reversal', () => {
    expect(nextState(READY)).toBe('learned');
  });

  it('keeps calibrating on too few exercise-days', () => {
    expect(nextState({ ...READY, daysEvaluated: 2 })).toBe('calibrating');
  });

  it('keeps calibrating on too few informative pairs', () => {
    expect(nextState({ ...READY, informativePairs: 5 })).toBe('calibrating');
  });

  it('keeps calibrating when the newest day reversed the previous step', () => {
    expect(nextState({ ...READY, newestDecision: 'down', previousStepDecision: 'up' })).toBe(
      'calibrating',
    );
    expect(nextState({ ...READY, newestDecision: 'up', previousStepDecision: 'down' })).toBe(
      'calibrating',
    );
  });

  it('reads learned when the newest day continued in the same direction', () => {
    expect(nextState({ ...READY, newestDecision: 'down', previousStepDecision: 'down' })).toBe(
      'learned',
    );
  });

  it('never demotes a learned record: only a restart does that', () => {
    const reversing = { ...READY, current: 'learned' as const, newestDecision: 'down' as const };
    expect(nextState({ ...reversing, previousStepDecision: 'up' })).toBe('learned');
  });
});

describe('seedRest: where a run starts (design s.4.7)', () => {
  function learnedRecords(ratio: number): LearnedRecordSummary[] {
    return [
      { intent: 'strength', valueSec: intentDefaultSec('strength') * ratio, state: 'learned' },
      { intent: 'power', valueSec: intentDefaultSec('power') * ratio, state: 'learned' },
    ];
  }

  it('starts from the plan when learning is on and the rest is at or above the floor', () => {
    const seed = seedRest({ intent: 'strength', plannedRestSec: 90, restLearning: true });
    expect(seed).toEqual({ seconds: 90, baseSource: 'plan' });
  });

  it('clamps a plan rest to the ceiling and nothing else', () => {
    const seed = seedRest({ intent: 'strength', plannedRestSec: 400, restLearning: true });
    expect(seed.seconds).toBe(ADAPTIVE_REST_POLICY.ceilingSec.value);
  });

  it('never starts from a plan rest under the floor', () => {
    const seed = seedRest({ intent: 'strength', plannedRestSec: 40, restLearning: true });
    expect(seed.baseSource).toBe('intent_default');
  });

  it("falls to the lifter's own factor when the plan gives nothing", () => {
    const seed = seedRest({
      intent: 'strength',
      restLearning: true,
      otherRecords: learnedRecords(0.8),
    });
    expect(seed).toEqual({ seconds: 120, baseSource: 'lifter_factor' });
  });

  it('holds a lifter factor inside the first-session clamp, above', () => {
    const seed = seedRest({
      intent: 'strength',
      restLearning: true,
      otherRecords: learnedRecords(2),
    });
    const high = ADAPTIVE_REST_POLICY.firstSessionClampHigh.value;
    expect(seed.seconds).toBe(high * intentDefaultSec('strength'));
  });

  it('holds a lifter factor inside the first-session clamp, below', () => {
    const seed = seedRest({
      intent: 'strength',
      restLearning: true,
      otherRecords: learnedRecords(0.3),
    });
    const low = ADAPTIVE_REST_POLICY.firstSessionClampLow.value;
    expect(seed.seconds).toBe(low * intentDefaultSec('strength'));
  });

  it('rounds a lifter-factor seed to the step', () => {
    const seed = seedRest({
      intent: 'hypertrophy',
      restLearning: true,
      otherRecords: learnedRecords(0.8),
    });
    expect(seed.seconds % ADAPTIVE_REST_POLICY.seedRoundingSec.value).toBe(0);
  });

  it('ignores records still calibrating when computing the factor', () => {
    const records = learnedRecords(0.5).map((record) => ({
      ...record,
      state: 'calibrating' as const,
    }));
    const seed = seedRest({ intent: 'strength', restLearning: true, otherRecords: records });
    expect(seed.baseSource).toBe('intent_default');
  });

  it('needs more than one learned record before it generalises', () => {
    const seed = seedRest({
      intent: 'strength',
      restLearning: true,
      otherRecords: learnedRecords(0.8).slice(0, 1),
    });
    expect(seed.baseSource).toBe('intent_default');
  });

  it('falls to the population default for the intent, with no intent taking its own', () => {
    expect(seedRest({ intent: 'strength', restLearning: true }).seconds).toBe(
      intentDefaultSec('strength'),
    );
    expect(seedRest({ intent: 'none', restLearning: true }).seconds).toBe(intentDefaultSec('none'));
  });
});

describe('signalForIntent: the owner ruling', () => {
  it('reads opening velocity for strength, and power follows it', () => {
    expect(signalForIntent('strength')).toBe('opening_velocity');
    expect(signalForIntent('power')).toBe('opening_velocity');
  });

  it('reads reps preserved for hypertrophy, and no stated intent follows it', () => {
    expect(signalForIntent('hypertrophy')).toBe('reps_preserved');
    expect(signalForIntent('none')).toBe('reps_preserved');
  });
});

describe('restConflictFor: the plan-versus-learned table (design s.5.1)', () => {
  const record = { valueSec: 120, state: 'learned' as const, daysEvaluated: 6 };

  it('is silent for every row of the table that has nothing to flag', () => {
    const rows = [
      { row: 1, input: { restLearning: true } },
      { row: 2, input: { restLearning: true, record } },
      { row: 3, input: { plannedRestSec: 90, restLearning: true } },
      {
        row: 4,
        input: { plannedRestSec: 90, restLearning: true, record: { ...record, planBaseSec: 90 } },
      },
      { row: 5, input: { plannedRestSec: 110, restLearning: true, record } },
      { row: 7, input: { plannedRestSec: 90, restLearning: false, record } },
      { row: 8, input: { restLearning: false, record } },
      { row: 9, input: { restLearning: false } },
      { row: 10, input: { plannedRestSec: 40, restLearning: true, record } },
    ];
    for (const { row, input } of rows) {
      expect({ row, flag: restConflictFor({ exerciseId: 'bench', ...input }) }).toEqual({
        row,
        flag: null,
      });
    }
  });

  it('flags row 6: a plan rest that differs from what the lifter learned', () => {
    const flag = restConflictFor({
      exerciseId: 'bench',
      plannedRestSec: 180,
      restLearning: true,
      record,
    });
    expect(flag).toEqual({
      kind: 'differs_from_learned',
      exerciseId: 'bench',
      plannedSec: 180,
      learnedSec: 120,
      learnedState: 'learned',
      daysEvaluated: 6,
      willRestartOnUse: true,
    });
  });

  it('treats a difference of exactly one step as a difference', () => {
    const flag = restConflictFor({
      exerciseId: 'bench',
      plannedRestSec: 120 + STEP,
      restLearning: true,
      record,
    });
    expect(flag?.kind).toBe('differs_from_learned');
  });

  it('flags two live plan rows that disagree, and restarts for neither', () => {
    const flag = restConflictFor({
      exerciseId: 'bench',
      plannedRestSec: 180,
      restLearning: true,
      record,
      otherRows: [
        { plannedExerciseId: 'pe-tuesday', restSec: 90 },
        { plannedExerciseId: 'pe-friday', restSec: 180 },
      ],
    });
    expect(flag?.kind).toBe('conflicting_plan_rows');
    expect(flag?.willRestartOnUse).toBe(false);
    expect(flag?.otherRows).toEqual([{ plannedExerciseId: 'pe-tuesday', restSec: 90 }]);
  });

  it('does not restart a run that restarted inside the cooldown', () => {
    const flag = restConflictFor({
      exerciseId: 'bench',
      plannedRestSec: 180,
      restLearning: true,
      record: { ...record, lastRestartOn: '2026-09-16' },
      on: DAY,
    });
    expect(flag?.kind).toBe('differs_from_learned');
    expect(flag?.willRestartOnUse).toBe(false);
  });

  it('restarts again once the cooldown has passed', () => {
    const flag = restConflictFor({
      exerciseId: 'bench',
      plannedRestSec: 180,
      restLearning: true,
      record: { ...record, lastRestartOn: '2026-09-01' },
      on: DAY,
    });
    expect(flag?.willRestartOnUse).toBe(true);
  });
});

describe('ADAPTIVE_REST_POLICY', () => {
  it("names every number's owner, so the simulation reads what it may move", () => {
    const entries = Object.entries(ADAPTIVE_REST_POLICY).filter(([key]) => key !== 'policyVersion');
    for (const [key, entry] of entries) {
      expect({ key, status: (entry as { status: string }).status }).toEqual({
        key,
        status: expect.stringMatching(/^(OWNER|ENGINEERING DEFAULT)$/),
      });
      expect((entry as { note: string }).note.length).toBeGreaterThan(0);
    }
  });

  it("keeps the owner's rulings out of the simulation's reach", () => {
    expect(ADAPTIVE_REST_POLICY.stepSec.status).toBe('OWNER');
    expect(ADAPTIVE_REST_POLICY.floorSec.value).toBe(45);
    expect(ADAPTIVE_REST_POLICY.floorSec.status).toBe('OWNER');
    expect(ADAPTIVE_REST_POLICY.ceilingSec.value).toBe(300);
    expect(ADAPTIVE_REST_POLICY.signalByIntent.status).toBe('OWNER');
  });

  it('marks the two targets as dose, which the simulation may only recommend moving', () => {
    expect(ADAPTIVE_REST_POLICY.openingVelocityTarget.ownerSignOff).toBe(true);
    expect(ADAPTIVE_REST_POLICY.repsPreservedTarget.ownerSignOff).toBe(true);
  });
});
