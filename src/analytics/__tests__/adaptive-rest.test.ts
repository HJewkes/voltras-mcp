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

import { addDays } from '../../plan/block-calendar.js';
import {
  ADAPTIVE_REST_POLICY,
  arrivals,
  evaluateExerciseDay,
  intentDefaultSec,
  nextState,
  pairsForExerciseDay,
  recoveryRatio,
  restConflictFor,
  seedRest,
  settledValue,
  signalForIntent,
  sortPair,
  stepDirections,
  type Arrival,
  type EvidencePair,
  type IgnoredPairs,
  type LearnedRecordSummary,
  type RestPair,
  type RestSetInput,
  type RestStep,
  type StepDirection,
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

  // Boundaries. Each rule admits its own limit, so a value sitting exactly on a
  // threshold is INSIDE it. Nine mutants survived the first round of these
  // tests without a single assertion failing; these are the assertions.

  it('admits a load exactly at the tolerance', () => {
    const tolerance = ADAPTIVE_REST_POLICY.sameLoadToleranceLbs.value;
    const day = twoSetDay({ second: { weightLbs: 100 + tolerance } });
    expect(pairsForExerciseDay(day).valid).toHaveLength(1);
  });

  it('rejects a load one step past the tolerance', () => {
    const tolerance = ADAPTIVE_REST_POLICY.sameLoadToleranceLbs.value;
    const day = twoSetDay({ second: { weightLbs: 100 + tolerance + 0.01 } });
    expect(pairsForExerciseDay(day).rejected[0].reason).toBe('load_differs');
  });

  /**
   * The depth gate's exact tie cannot be exercised: a set built to land on
   * exactly 10% loss computes to 9.999999999999998 in binary floating point and
   * is rejected. That is immaterial for a gate written in whole percent, but it
   * is what the code does, so it is what these two pin -- the nearest
   * representable value on each side rather than a tie that does not exist.
   */
  it('rejects an earlier set that computes a hair under the depth gate', () => {
    const day = twoSetDay({ first: { velocities: [1.0, 0.97, 0.94, 0.92, 0.9] } });
    expect(pairsForExerciseDay(day).rejected[0].reason).toBe('too_shallow');
  });

  it('admits an earlier set that computes just over the depth gate', () => {
    const day = twoSetDay({ first: { velocities: [1.0, 0.97, 0.94, 0.92, 0.89] } });
    expect(pairsForExerciseDay(day).valid).toHaveLength(1);
  });

  it('admits a rest exactly at the short-rest floor', () => {
    const floor = ADAPTIVE_REST_POLICY.minActualRestSec.value;
    const day = twoSetDay({ second: { startSec: 40 + floor, endSec: 40 + floor + 40 } });
    expect(pairsForExerciseDay(day).valid[0].actualRestSec).toBe(floor);
  });

  it('rejects a rest one second under the short-rest floor', () => {
    const floor = ADAPTIVE_REST_POLICY.minActualRestSec.value;
    const day = twoSetDay({ second: { startSec: 40 + floor - 1, endSec: 40 + floor + 40 } });
    expect(pairsForExerciseDay(day).rejected[0].reason).toBe('rest_too_short');
  });

  it('rejects a negative rest from clock skew rather than reading it as a rest', () => {
    // The later set's first rep timestamped BEFORE the earlier set closed.
    const day = twoSetDay({ second: { workStartedAt: at(20) } });
    expect(pairsForExerciseDay(day).rejected[0].reason).toBe('rest_too_short');
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

  /**
   * Amendment s.2. These two used to be informative, and counting them was a
   * one-way ratchet: a loiterer's only class is `missed`, so every step was
   * `up` forever, and a rusher's only class is `recovered`, so every step was
   * `down`. They are kept, marked out of window, and may only veto.
   */
  it('does not count a SHORT rest that recovered anyway; it is out of window', () => {
    const sort = sortPair(pairWithRatio(0.96, T - TOL - 30), T, 'opening_velocity');
    expect(sort.verdict).toBe('recovered');
    expect(sort.inWindow).toBe(false);
    expect(sort.informative).toBe(false);
  });

  it('does not count a LONG rest that missed anyway; it is out of window', () => {
    const sort = sortPair(pairWithRatio(0.9, T + TOL + 30), T, 'opening_velocity');
    expect(sort.verdict).toBe('missed');
    expect(sort.inWindow).toBe(false);
    expect(sort.informative).toBe(false);
  });

  it('marks a pair inside the window as in window', () => {
    expect(sortPair(pairWithRatio(0.96, T), T, 'opening_velocity').inWindow).toBe(true);
    expect(sortPair(pairWithRatio(0.96, T + TOL), T, 'opening_velocity').inWindow).toBe(true);
    expect(sortPair(pairWithRatio(0.9, T - TOL), T, 'opening_velocity').inWindow).toBe(true);
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

  it('counts a ratio exactly at the target as meeting it', () => {
    const target = ADAPTIVE_REST_POLICY.openingVelocityTarget.value;
    expect(sortPair(pairWithRatio(target, T), T, 'opening_velocity').verdict).toBe('recovered');
  });

  it('counts a ratio a hair under the target as missing it', () => {
    const target = ADAPTIVE_REST_POLICY.openingVelocityTarget.value;
    expect(sortPair(pairWithRatio(target - 0.001, T), T, 'opening_velocity').verdict).toBe(
      'missed',
    );
  });

  it('calls a rest exactly at the top of the window recovered, not long', () => {
    expect(sortPair(pairWithRatio(0.96, T + TOL), T, 'opening_velocity').verdict).toBe('recovered');
  });

  it('calls a rest one second past the window long', () => {
    expect(sortPair(pairWithRatio(0.96, T + TOL + 1), T, 'opening_velocity').verdict).toBe('long');
  });

  it('calls a rest exactly at the bottom of the window missed, not rushed', () => {
    expect(sortPair(pairWithRatio(0.9, T - TOL), T, 'opening_velocity').verdict).toBe('missed');
  });

  it('calls a rest one second below the window rushed', () => {
    expect(sortPair(pairWithRatio(0.9, T - TOL - 1), T, 'opening_velocity').verdict).toBe('rushed');
  });
});

describe('evaluateExerciseDay: the step (design s.4.6)', () => {
  function evidenceOf(ratios: readonly number[], weight = 1): EvidencePair[] {
    return ratios.map((r) => ({
      on: DAY,
      r,
      weight,
      verdict: 'recovered' as const,
      inWindow: true,
    }));
  }

  /** A pair that sat outside the window, which can only veto. */
  function outOfWindow(verdict: 'missed' | 'recovered'): EvidencePair {
    return { on: DAY, r: verdict === 'missed' ? 0.5 : 1, weight: 1, verdict, inWindow: false };
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

  // Boundaries of the step rule. The design's words are "at or above target +
  // 0.02: down" and "below target - 0.02: up", so the upper limit steps and the
  // lower limit holds. The asymmetry is deliberate and is pinned here.

  it('steps down at exactly one dead band above the target', () => {
    const target = ADAPTIVE_REST_POLICY.openingVelocityTarget.value;
    const band = ADAPTIVE_REST_POLICY.deadBand.value;
    const { step } = evaluate({ evidence: evidenceOf([target + band, target + band]) });
    expect(step.decision).toBe('down');
  });

  it('holds a hair below one dead band above the target', () => {
    const target = ADAPTIVE_REST_POLICY.openingVelocityTarget.value;
    const band = ADAPTIVE_REST_POLICY.deadBand.value;
    const { step } = evaluate({
      evidence: evidenceOf([target + band - 0.001, target + band - 0.001]),
    });
    expect(step.decision).toBe('hold');
  });

  it('steps up a hair below one dead band under the target', () => {
    const target = ADAPTIVE_REST_POLICY.openingVelocityTarget.value;
    const band = ADAPTIVE_REST_POLICY.deadBand.value;
    const { step } = evaluate({
      evidence: evidenceOf([target - band - 0.001, target - band - 0.001]),
    });
    expect(step.decision).toBe('up');
  });

  it('keeps a pair dated exactly on the window boundary', () => {
    const on = '2026-09-19';
    const window = ADAPTIVE_REST_POLICY.evidenceWindowDays.value;
    const oldest = addDays(on, -window);
    const evidence = evidenceOf([0.99, 0.99]).map((pair) => ({ ...pair, on: oldest }));
    expect(evaluate({ on, runStartedOn: '2026-01-01', evidence }).step.decision).toBe('down');
  });

  it('drops a pair one day older than the window', () => {
    const on = '2026-09-19';
    const window = ADAPTIVE_REST_POLICY.evidenceWindowDays.value;
    const tooOld = addDays(on, -window - 1);
    const evidence = evidenceOf([0.99, 0.99]).map((pair) => ({ ...pair, on: tooOld }));
    expect(evaluate({ on, runStartedOn: '2026-01-01', evidence }).step.decision).toBe(
      'no_evidence',
    );
  });

  it('keeps a pair dated on the day of the newest step, which came before the sets', () => {
    const evidence = evidenceOf([0.99, 0.99]).map((pair) => ({ ...pair, on: '2026-09-15' }));
    const input = { evidence, lastStepOn: '2026-09-15' };
    expect(evaluate(input).step.decision).toBe('down');
  });

  describe('the two-day rule once learned, in both directions', () => {
    it('holds the first qualifying day rather than shortening straight away', () => {
      const { step, clearsWindow, pendingDirection } = evaluate({ state: 'learned' });
      expect(step.decision).toBe('hold');
      expect(step.reason).toBe('recovered');
      expect(clearsWindow).toBe(false);
      expect(pendingDirection).toBe('down');
    });

    it('shortens on the second consecutive qualifying day', () => {
      const input = { state: 'learned' as const, pendingDirection: 'down' as const };
      const { step, pendingDirection } = evaluate(input);
      expect(step.decision).toBe('down');
      expect(step.toSec).toBe(120 - STEP);
      expect(pendingDirection).toBeNull();
    });

    it('holds the first qualifying day rather than lengthening straight away', () => {
      const input = { state: 'learned' as const, evidence: evidenceOf([0.8, 0.8]) };
      const { step, pendingDirection } = evaluate(input);
      expect(step.decision).toBe('hold');
      expect(step.reason).toBe('missed');
      expect(pendingDirection).toBe('up');
    });

    it('lengthens on the second consecutive qualifying day', () => {
      const { step } = evaluate({
        state: 'learned',
        evidence: evidenceOf([0.8, 0.8]),
        pendingDirection: 'up',
      });
      expect(step.decision).toBe('up');
      expect(step.toSec).toBe(120 + STEP);
    });

    it('does not carry a pending direction across a change of mind', () => {
      const input = { state: 'learned' as const, pendingDirection: 'up' as const };
      expect(evaluate(input).step.decision).toBe('hold');
      expect(evaluate(input).pendingDirection).toBe('down');
    });

    it('does not hold a calibrating run: it steps on the first qualifying day', () => {
      expect(evaluate().step.decision).toBe('down');
      expect(evaluate({ evidence: evidenceOf([0.8, 0.8]) }).step.decision).toBe('up');
    });
  });

  describe('out-of-window pairs veto but never cause a step (amendment s.2)', () => {
    it('a long rest that still missed vetoes a step down', () => {
      const evidence = [...evidenceOf([0.99, 0.99]), outOfWindow('missed')];
      const { step, clearsWindow } = evaluate({ evidence });
      expect(step.decision).toBe('hold');
      expect(step.reason).toBe('vetoed');
      expect(step.toSec).toBe(step.fromSec);
      expect(clearsWindow).toBe(false);
    });

    it('a short rest that recovered anyway vetoes a step up', () => {
      const evidence = [...evidenceOf([0.8, 0.8]), outOfWindow('recovered')];
      const { step } = evaluate({ evidence });
      expect(step.decision).toBe('hold');
      expect(step.reason).toBe('vetoed');
    });

    it('does not veto the step it agrees with', () => {
      const down = [...evidenceOf([0.99, 0.99]), outOfWindow('recovered')];
      expect(evaluate({ evidence: down }).step.decision).toBe('down');
      const up = [...evidenceOf([0.8, 0.8]), outOfWindow('missed')];
      expect(evaluate({ evidence: up }).step.decision).toBe('up');
    });

    it('never counts an out-of-window pair towards the evidence weight', () => {
      const evidence = [...evidenceOf([0.99]), outOfWindow('recovered'), outOfWindow('recovered')];
      const { step } = evaluate({ evidence });
      expect(step.decision).toBe('no_evidence');
      expect(step.informativePairs).toBe(1);
    });
  });
});

describe('arrivals (amendment s.3.1)', () => {
  function step(over: Partial<RestStep>): RestStep {
    return {
      on: DAY,
      fromSec: 120,
      toSec: 105,
      decision: 'down',
      reason: 'recovered',
      signal: 'opening_velocity',
      rMedian: 0.99,
      informativePairs: 2,
      ignoredPairs: NO_IGNORED,
      ...over,
    };
  }

  const down = (on: string, fromSec: number) =>
    step({ on, fromSec, toSec: fromSec - STEP, decision: 'down', reason: 'recovered' });
  const up = (on: string, fromSec: number) =>
    step({ on, fromSec, toSec: fromSec + STEP, decision: 'up', reason: 'missed' });
  const holdFor = (on: string, at: number, reason: RestStep['reason']) =>
    step({ on, fromSec: at, toSec: at, decision: 'hold', reason });

  it('finds no arrival in a march that never turns', () => {
    const march = [down('d1', 150), down('d2', 135), down('d3', 120), down('d4', 105)];
    expect(arrivals(march)).toHaveLength(0);
  });

  it('reads a reversal as an arrival at the value the staircase turned at', () => {
    const history = [down('d1', 150), down('d2', 135), up('d3', 120)];
    expect(arrivals(history)).toEqual([{ on: 'd3', kind: 'reversal', valueSec: 120 }]);
  });

  it('reads a dead-band hold as an arrival at the held value', () => {
    const history = [down('d1', 150), holdFor('d2', 135, 'dead_band')];
    expect(arrivals(history)).toEqual([{ on: 'd2', kind: 'dead_band', valueSec: 135 }]);
  });

  it('does not read a no-evidence day, a vetoed hold or a two-day hold as an arrival', () => {
    const history = [
      down('d1', 150),
      step({
        on: 'd2',
        fromSec: 135,
        toSec: 135,
        decision: 'no_evidence',
        reason: 'too_few_pairs',
      }),
      holdFor('d3', 135, 'vetoed'),
      holdFor('d4', 135, 'recovered'),
      holdFor('d5', 135, 'missed'),
    ];
    expect(arrivals(history)).toHaveLength(0);
  });

  it('ignores holds between two steps when it looks for a reversal', () => {
    const history = [
      down('d1', 150),
      holdFor('d2', 135, 'vetoed'),
      step({
        on: 'd3',
        fromSec: 135,
        toSec: 135,
        decision: 'no_evidence',
        reason: 'too_few_pairs',
      }),
      up('d4', 135),
    ];
    expect(arrivals(history)).toEqual([{ on: 'd4', kind: 'reversal', valueSec: 135 }]);
  });

  it('counts each turn of a bracketing sequence', () => {
    const history = [down('d1', 120), up('d2', 105), down('d3', 120), up('d4', 105)];
    expect(arrivals(history).map((a) => a.valueSec)).toEqual([105, 120, 105]);
  });
});

describe('stepDirections', () => {
  const step = (on: string, decision: RestStep['decision']): RestStep => ({
    on,
    fromSec: 120,
    toSec: decision === 'down' ? 105 : decision === 'up' ? 135 : 120,
    decision,
    reason: 'recovered',
    signal: 'opening_velocity',
    rMedian: 0.99,
    informativePairs: 2,
    ignoredPairs: NO_IGNORED,
  });

  const history = [
    step('2026-09-01', 'down'),
    step('2026-09-02', 'down'),
    step('2026-09-03', 'hold'),
    step('2026-09-04', 'up'),
  ];

  it('keeps only the steps that moved the value', () => {
    expect(stepDirections(history)).toEqual(['down', 'down', 'up']);
  });

  it('takes only the steps on or after a date, which is how a settled run is judged', () => {
    expect(stepDirections(history, '2026-09-03')).toEqual(['up']);
    expect(stepDirections(history, '2026-09-05')).toEqual([]);
  });
});

describe('settledValue (amendment s.3.2)', () => {
  const arrival = (valueSec: number): Arrival => ({ on: DAY, kind: 'reversal', valueSec });

  it('takes the longer of the last two arrival values', () => {
    expect(settledValue([arrival(150), arrival(105), arrival(120)])).toBe(120);
    expect(settledValue([arrival(150), arrival(120), arrival(105)])).toBe(120);
  });

  it('ignores arrivals before the last two', () => {
    expect(settledValue([arrival(300), arrival(105), arrival(90)])).toBe(105);
  });

  it('takes the only arrival when there is one, and null when there are none', () => {
    expect(settledValue([arrival(135)])).toBe(135);
    expect(settledValue([])).toBeNull();
  });
});

describe('nextState (amendment s.3.2)', () => {
  const READY = {
    current: 'calibrating' as const,
    daysEvaluated: ADAPTIVE_REST_POLICY.learnedMinDaysEvaluated.value,
    informativePairs: ADAPTIVE_REST_POLICY.learnedMinInformativePairs.value,
    arrivals: threeArrivals(),
    stepsSinceLearned: [] as StepDirection[],
  };

  function threeArrivals(): Arrival[] {
    return [120, 105, 120].map((valueSec) => ({ on: DAY, kind: 'reversal' as const, valueSec }));
  }

  it('reads learned at the third arrival, with the day and pair minimums met', () => {
    expect(nextState(READY)).toBe('learned');
  });

  it('keeps calibrating on two arrivals, however many days and pairs are in', () => {
    const arrivals = threeArrivals().slice(0, 2);
    expect(nextState({ ...READY, arrivals, daysEvaluated: 40, informativePairs: 99 })).toBe(
      'calibrating',
    );
  });

  it('keeps calibrating with no arrival at all', () => {
    expect(nextState({ ...READY, arrivals: [] })).toBe('calibrating');
  });

  it('keeps calibrating on too few exercise-days', () => {
    expect(nextState({ ...READY, daysEvaluated: 2 })).toBe('calibrating');
  });

  it('keeps calibrating on too few informative pairs', () => {
    expect(nextState({ ...READY, informativePairs: 5 })).toBe('calibrating');
  });

  it('no longer treats a reversal as a reason to wait: it is what grants the state', () => {
    const marching: StepDirection[] = ['down', 'down'];
    expect(nextState({ ...READY, stepsSinceLearned: marching })).toBe('learned');
  });

  it('returns a learned run to calibrating after three steps one way', () => {
    const learned = { ...READY, current: 'learned' as const };
    expect(nextState({ ...learned, stepsSinceLearned: ['down', 'down', 'down'] })).toBe(
      'calibrating',
    );
    expect(nextState({ ...learned, stepsSinceLearned: ['up', 'up', 'up'] })).toBe('calibrating');
  });

  it('keeps a learned run learned while its steps still turn', () => {
    const learned = { ...READY, current: 'learned' as const };
    expect(nextState({ ...learned, stepsSinceLearned: ['down', 'down', 'up'] })).toBe('learned');
    expect(nextState({ ...learned, stepsSinceLearned: ['down', 'up', 'down'] })).toBe('learned');
    expect(nextState({ ...learned, stepsSinceLearned: ['down', 'down'] })).toBe('learned');
  });

  it('counts only steps taken SINCE the run settled, never the march that got it there', () => {
    const learned = { ...READY, current: 'learned' as const };
    // The run marched three times on its way to learned; nothing since.
    expect(nextState({ ...learned, stepsSinceLearned: [] })).toBe('learned');
  });

  it('reads only the newest steps, so an old march does not demote a settled run', () => {
    const learned = { ...READY, current: 'learned' as const };
    const directions: StepDirection[] = ['up', 'up', 'up', 'down'];
    expect(nextState({ ...learned, stepsSinceLearned: directions })).toBe('learned');
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

  it('treats another row exactly one step away as a disagreement', () => {
    const flag = restConflictFor({
      exerciseId: 'bench',
      plannedRestSec: 180,
      restLearning: true,
      record,
      otherRows: [{ plannedExerciseId: 'pe-tuesday', restSec: 180 - STEP }],
    });
    expect(flag?.kind).toBe('conflicting_plan_rows');
  });

  it('ignores another row a hair inside one step', () => {
    const flag = restConflictFor({
      exerciseId: 'bench',
      plannedRestSec: 180,
      restLearning: true,
      record,
      otherRows: [{ plannedExerciseId: 'pe-tuesday', restSec: 180 - STEP + 0.01 }],
    });
    expect(flag?.kind).toBe('differs_from_learned');
  });

  /**
   * The owner's 2026-09-20 ruling: "Force one to be set, if learned is false
   * then a rest value is required. If both are null due to data quality issue,
   * seed rest time from learned value but then leave learning false (equates to
   * recommendation)."
   *
   * The plan-write validator refuses that row; that is a later task. What the
   * PURE module owes the ruling is the data-quality fallback: silence. No
   * conflict, and a seed that never claims the plan supplied it, so learning
   * stays off and the resolver is free to serve the frozen learned value.
   */
  it('is silent for the data-quality row: learning off with no rest', () => {
    expect(restConflictFor({ exerciseId: 'bench', restLearning: false, record })).toBeNull();
    const seed = seedRest({ intent: 'strength', restLearning: false });
    expect(seed.baseSource).toBe('intent_default');
    expect(seed.seconds).toBe(intentDefaultSec('strength'));
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
    expect(ADAPTIVE_REST_POLICY.floorSec.value).toBe(45);
    expect(ADAPTIVE_REST_POLICY.floorSec.status).toBe('OWNER');
    expect(ADAPTIVE_REST_POLICY.ceilingSec.value).toBe(300);
    expect(ADAPTIVE_REST_POLICY.signalByIntent.status).toBe('OWNER');
  });

  /**
   * The step and the exercise-day unit are NOT rulings. The owner fixed 15 s as
   * a starting value and said "one step per session per exercise"; the
   * exercise-day is the designer's reading of that. The step still sets how
   * much rest a lifter gets, so it carries the same sign-off the two targets do.
   */
  it('marks the step and the two targets as dose: recommend only', () => {
    expect(ADAPTIVE_REST_POLICY.stepSec.status).toBe('ENGINEERING DEFAULT');
    expect(ADAPTIVE_REST_POLICY.stepSec.ownerSignOff).toBe(true);
    expect(ADAPTIVE_REST_POLICY.openingVelocityTarget.ownerSignOff).toBe(true);
    expect(ADAPTIVE_REST_POLICY.repsPreservedTarget.ownerSignOff).toBe(true);
  });

  it("marks the exercise-day unit as the designer's reading, not a ruling", () => {
    expect(ADAPTIVE_REST_POLICY.maxStepsPerExerciseDay.status).toBe('ENGINEERING DEFAULT');
  });

  it('marks the ceiling as an engineering default: the owner ruled the floor and not this', () => {
    expect(ADAPTIVE_REST_POLICY.ceilingSec.status).toBe('ENGINEERING DEFAULT');
  });

  it('carries the amended version and every key the amendment adds', () => {
    expect(ADAPTIVE_REST_POLICY.policyVersion).toBe('adaptive-rest@1.1.0');
    expect(ADAPTIVE_REST_POLICY.learnedMinArrivals.value).toBe(3);
    expect(ADAPTIVE_REST_POLICY.learnedValueRule.value).toBe('longer_of_last_two_arrivals');
    expect(ADAPTIVE_REST_POLICY.relearnAfterSameDirectionSteps.value).toBe(3);
    expect(ADAPTIVE_REST_POLICY.stepDaysRequiredWhenLearned.value).toBe(2);
    expect(ADAPTIVE_REST_POLICY.outOfWindowPairs.value).toBe('veto_only');
  });

  it('no longer carries the down-only rule the amendment replaced', () => {
    expect(ADAPTIVE_REST_POLICY).not.toHaveProperty('downDaysRequiredWhenLearned');
  });
});

/**
 * The amendment's acceptance tests, driven end to end: `sortPair` sorts the
 * day's pairs, `evaluateExerciseDay` judges them, `arrivals` reads the history
 * and `nextState` decides the state, exactly as the store task will compose
 * them. Nothing here reimplements a rule.
 */
describe('the staircase over many exercise-days (amendment s.3)', () => {
  interface Run {
    valueSec: number;
    state: LearnedRestState;
    history: RestStep[];
    evidence: EvidencePair[];
    pendingDirection: StepDirection | null;
    daysEvaluated: number;
    informativePairs: number;
    learnedOn?: string;
  }

  function newRun(valueSec: number): Run {
    return {
      valueSec,
      state: 'calibrating',
      history: [],
      evidence: [],
      pendingDirection: null,
      daysEvaluated: 0,
      informativePairs: 0,
    };
  }

  /** A pair with a chosen ratio, rested `actualRestSec` after the previous set. */
  function pairAt(ratio: number, actualRestSec: number): RestPair {
    const earlier = makeSet({ id: 'a', startSec: 0, endSec: 40, velocities: [1.0, 1.0, 0.8] });
    const later = makeSet({ id: 'b', startSec: 200, endSec: 240, velocities: [ratio, ratio, 0.5] });
    return { earlier, later, reference: earlier, actualRestSec, laterSetIndex: 2, weight: 1 };
  }

  /** Run one exercise-day of `pairs` through the real rules and fold the result in. */
  function runDay(run: Run, on: string, pairs: readonly RestPair[]): Run {
    for (const pair of pairs) {
      const sort = sortPair(pair, run.valueSec, 'opening_velocity');
      if (sort.r === null) continue;
      run.evidence.push({
        on,
        r: sort.r,
        weight: sort.weight,
        verdict: sort.verdict,
        inWindow: sort.inWindow,
      });
      if (sort.informative) run.informativePairs += 1;
    }
    const evaluation = evaluateExerciseDay({
      on,
      valueSec: run.valueSec,
      state: run.state,
      signal: 'opening_velocity',
      runStartedOn: RUN_START,
      pendingDirection: run.pendingDirection,
      evidence: run.evidence,
      ignoredPairs: NO_IGNORED,
    });
    run.history.push(evaluation.step);
    run.valueSec = evaluation.step.toSec;
    run.pendingDirection = evaluation.pendingDirection;
    run.daysEvaluated += 1;
    if (evaluation.clearsWindow) run.evidence = [];
    const wasLearned = run.state === 'learned';
    run.state = nextState({
      current: run.state,
      daysEvaluated: run.daysEvaluated,
      informativePairs: run.informativePairs,
      arrivals: arrivals(run.history),
      stepsSinceLearned: stepDirections(run.history, run.learnedOn ?? on),
    });
    if (!wasLearned && run.state === 'learned') run.learnedOn = addDays(on, 1);
    return run;
  }

  const RUN_START = '2026-09-01';
  /** The nth exercise-day of the run, as a real local date. */
  const dayOf = (n: number) => addDays(RUN_START, n);

  /** Two in-window pairs that both say "recovered", which qualifies a step down. */
  const recoveredDay = (at: number) => [pairAt(0.99, at), pairAt(0.99, at)];
  /** Two in-window pairs that both say "missed", which qualifies a step up. */
  const missedDay = (at: number) => [pairAt(0.8, at), pairAt(0.8, at)];
  /** Two in-window pairs sitting exactly on the target, which holds in the dead band. */
  const deadBandDay = (at: number) => [pairAt(0.95, at), pairAt(0.95, at)];

  it('keeps calibrating through a seven-day march, whatever the day and pair counts', () => {
    let run = newRun(180);
    const seen: LearnedRestState[] = [];
    for (let day = 1; day <= 7; day += 1) {
      run = runDay(run, dayOf(day), recoveredDay(run.valueSec));
      seen.push(run.state);
    }
    expect(seen).toEqual(Array<LearnedRestState>(7).fill('calibrating'));
    expect(run.daysEvaluated).toBe(7);
    expect(run.valueSec).toBe(180 - 7 * STEP);
    expect(arrivals(run.history)).toHaveLength(0);
  });

  it('reads learned on the day of the third arrival, settling on the longer bracket value', () => {
    let run = newRun(150);
    run = runDay(run, dayOf(1), recoveredDay(run.valueSec));
    run = runDay(run, dayOf(2), recoveredDay(run.valueSec));
    expect(run.valueSec).toBe(120);
    run = runDay(run, dayOf(3), missedDay(run.valueSec));
    run = runDay(run, dayOf(4), recoveredDay(run.valueSec));
    expect(run.state).toBe('calibrating');
    run = runDay(run, dayOf(5), missedDay(run.valueSec));
    expect(arrivals(run.history)).toHaveLength(3);
    expect(run.state).toBe('learned');
    expect(settledValue(arrivals(run.history))).toBe(135);
  });

  it('stays calibrating when one noisy day makes two reversals at the same spot', () => {
    let run = newRun(180);
    run = runDay(run, dayOf(1), recoveredDay(run.valueSec));
    run = runDay(run, dayOf(2), missedDay(run.valueSec));
    run = runDay(run, dayOf(3), recoveredDay(run.valueSec));
    expect(arrivals(run.history)).toHaveLength(2);
    expect(run.state).toBe('calibrating');
  });

  it('never moves a loiterer, whose every rest sits past the window', () => {
    let run = newRun(120);
    for (let day = 1; day <= 10; day += 1) {
      const late = run.valueSec + ADAPTIVE_REST_POLICY.toleranceSec.value + 40;
      run = runDay(run, dayOf(day), [pairAt(0.99, late), pairAt(0.8, late)]);
    }
    expect(run.valueSec).toBe(120);
    expect(run.history.every((step) => step.toSec === step.fromSec)).toBe(true);
  });

  it('never moves a rusher, whose every rest starts before the window', () => {
    let run = newRun(120);
    for (let day = 1; day <= 10; day += 1) {
      const early = run.valueSec - ADAPTIVE_REST_POLICY.toleranceSec.value - 40;
      run = runDay(run, dayOf(day), [pairAt(0.99, early), pairAt(0.8, early)]);
    }
    expect(run.valueSec).toBe(120);
    expect(run.history.every((step) => step.toSec === step.fromSec)).toBe(true);
  });

  it('keeps a run learned while it only holds, however it marched before', () => {
    let run = newRun(150);
    // Three steps down, then a dead-band hold on each of three exercise-days.
    run = runDay(run, dayOf(1), recoveredDay(run.valueSec));
    run = runDay(run, dayOf(2), recoveredDay(run.valueSec));
    run = runDay(run, dayOf(3), recoveredDay(run.valueSec));
    expect(stepDirections(run.history)).toEqual(['down', 'down', 'down']);
    for (const day of [4, 5, 6]) {
      run = runDay(run, dayOf(day), deadBandDay(run.valueSec));
    }
    expect(arrivals(run.history)).toHaveLength(3);
    expect(run.state).toBe('learned');

    // Nothing has STEPPED since it settled, so nothing may un-settle it.
    const settled: LearnedRestState[] = [];
    for (const day of [7, 8, 9]) {
      run = runDay(run, dayOf(day), deadBandDay(run.valueSec));
      settled.push(run.state);
    }
    expect(settled).toEqual(['learned', 'learned', 'learned']);
  });

  it('returns a learned run to calibrating after three steps one way, restarting its arrivals', () => {
    let run = newRun(150);
    for (const [day, pairs] of [
      [dayOf(1), recoveredDay(150)],
      [dayOf(2), recoveredDay(135)],
      [dayOf(3), missedDay(120)],
      [dayOf(4), recoveredDay(135)],
      [dayOf(5), missedDay(120)],
    ] as const) {
      run = runDay(run, day, pairs);
    }
    expect(run.state).toBe('learned');
    const learnedAt = run.history.length;

    // Once learned, each step needs two consecutive qualifying days.
    for (let day = 6; day <= 11; day += 1) {
      run = runDay(run, dayOf(day), recoveredDay(run.valueSec));
    }
    expect(stepDirections(run.history).slice(-3)).toEqual(['down', 'down', 'down']);
    expect(run.state).toBe('calibrating');
    expect(arrivals(run.history.slice(learnedAt))).toHaveLength(0);
  });
});
