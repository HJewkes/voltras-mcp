// Stage 1 (VW-516, design s.10.2): does the lifter model reproduce published
// rest results? Until it does, stage 2 says nothing about the staircase, only
// about the model's own arithmetic.
//
// One model is fitted JOINTLY to all three baselines rather than one model per
// baseline. The fatigue parameters are shared and only the time constant varies
// by population, which is what makes baseline B a test and not a restatement:
// its two groups differ in tau alone, and their very different spreads have to
// fall out of that.
//
// Every published figure below is quoted from
// `sources/research/2026-09-19-vw-445-adaptive-rest-research.md` s.2.2 and
// s.2.4. No paper was re-read here.

import {
  afterRest,
  completedTarget,
  gaussian,
  makeRng,
  mean,
  performSet,
  relativeError,
  stdDev,
  type LifterParams,
} from './lifter-model.js';

/**
 * Janicijevic 2024 ran an unstated number of sets. Five is this simulation's
 * ASSUMPTION, chosen because it puts the published totals at 5.7 to 8.2 reps
 * per set, which is the range a bench pull at that cut-off plausibly gives.
 * Every baseline-A figure depends on it.
 */
export const BASELINE_A_SETS = 5;

/** Published: reps before the 0.55 m/s cut-off at 1, 3 and 5 min rest. */
export const BASELINE_A_TARGETS = { rest60: 28.4, rest180: 36.4, rest300: 41.1 } as const;

/** Published: total reps to failure, sets of 5 at 75% 1RM on 90 s rest. */
export const BASELINE_B_TARGETS = {
  womenMean: 58.3,
  womenSd: 27.3,
  menMean: 29.6,
  menSd: 10.6,
} as const;

/** Published: self-selected rest after set 1, back squat. */
export const BASELINE_C_FIRST_REST_SEC = 97;

/**
 * Alonso-Aubin 2024 does not state a rep target this simulation can read, so
 * eight reps at 75% 1RM, with ten reps to failure at that load, are ASSUMPTIONS.
 * Baseline C's numbers depend on both.
 */
const BASELINE_C_REPS = 8;
const BASELINE_C_N0 = 10;

const BASELINE_A_CUTOFF = 0.55;
const BASELINE_B_TARGET_REPS = 5;
const BASELINE_B_REST_SEC = 90;
/** Population used while searching. Small enough to search, large enough to rank candidates. */
const POPULATION_FIT = 150;

/** Population the chosen fit is finally measured on. */
const POPULATION_REPORT = 600;

/**
 * Between-session velocity CV, from the 2.6 to 6.9% range the research note
 * reports (search snippet only). Held at the midpoint and NOT fitted, so the
 * fit cannot hide a bad model behind convenient noise.
 */
const MEASUREMENT_CV = 0.045;

/** The recovery target baseline C's self-selecting lifter waits for. Mirrors the module's own. */
const OPENING_VELOCITY_TARGET = 0.95;

/** The free parameters of the joint fit. */
export interface FitParams {
  readonly fatigueCost: number;
  readonly repsPenalty: number;
  readonly velocityPenalty: number;
  readonly tauASec: number;
  readonly tauMenSec: number;
  readonly tauWomenSec: number;
  /**
   * Relative spread of tau within baseline B's women's group.
   *
   * Each group gets its OWN spread (amendment s.6.1). One shared spread cannot
   * hold two groups whose published relative spreads differ, and this is the
   * fix. The cost is stated wherever the result is: baseline B then has four
   * published numbers and four free parameters, so it stops being a test of the
   * model and becomes a CALIBRATION of the population spread.
   */
  readonly tauSpreadWomen: number;
  /** Relative spread of tau within baseline B's men's group. Free for the same reason. */
  readonly tauSpreadMen: number;
  /** Relative spread of tau in baseline A's population, which is a different study. */
  readonly tauSpreadA: number;
  /** Reps to failure at baseline A's load. */
  readonly n0A: number;
  /** Reps to failure at baseline B's load. An exercise property, not a fatigue one. */
  readonly n0B: number;
  /** Time constant of baseline C's self-selecting squatters. */
  readonly tauCSec: number;
}

/** Exercise constants each baseline holds fixed. */
const BENCH_PULL = { v0: 1.0, vFail: 0.4 } as const;
const BENCH_PRESS_75 = { v0: 0.5, vFail: 0.17 } as const;
const BACK_SQUAT_75 = { v0: 0.6, vFail: 0.24 } as const;

function lifter(
  exercise: { v0: number; vFail: number; n0: number },
  tauSec: number,
  fit: FitParams,
): LifterParams {
  return {
    v0: exercise.v0,
    vFail: exercise.vFail,
    n0: exercise.n0,
    tauSec,
    fatigueCost: fit.fatigueCost,
    repsPenalty: fit.repsPenalty,
    velocityPenalty: fit.velocityPenalty,
    cv: MEASUREMENT_CV,
  };
}

/** Draw one lifter's tau around a population mean. */
function drawTau(meanTau: number, spread: number, rng: () => number): number {
  return Math.max(10, meanTau * (1 + spread * gaussian(rng)));
}

/** One baseline-A protocol run: reps at or above the cut-off, and the opening-velocity drop. */
function runBaselineA(
  params: LifterParams,
  restSec: number,
  rng: () => number,
): { reps: number; openingDrop: number } {
  let fatigue = 0;
  let reps = 0;
  const openings: number[] = [];
  for (let set = 1; set <= BASELINE_A_SETS; set += 1) {
    const done = performSet(params, fatigue, { velocityCutoff: BASELINE_A_CUTOFF }, rng);
    reps += done.velocities.filter((velocity) => velocity >= BASELINE_A_CUTOFF).length;
    openings.push(Math.max(...done.velocities));
    fatigue = afterRest(params, done.fatigueAfter, restSec);
  }
  const first = openings[0];
  return { reps, openingDrop: (first - openings[openings.length - 1]) / first };
}

/** Mean reps and mean opening-velocity drop over a simulated population at one rest. */
function baselineAAt(fit: FitParams, restSec: number, seed: number, population: number) {
  const rng = makeRng(seed);
  const runs = Array.from({ length: population }, () => {
    const tau = drawTau(fit.tauASec, fit.tauSpreadA, rng);
    return runBaselineA(lifter({ ...BENCH_PULL, n0: fit.n0A }, tau, fit), restSec, rng);
  });
  return {
    reps: mean(runs.map((run) => run.reps)),
    openingDrop: mean(runs.map((run) => run.openingDrop)),
  };
}

const MAX_SETS_B = 40;

/** One baseline-B protocol run: sets of 5 to failure on 90 s rest; total reps completed. */
function runBaselineB(params: LifterParams, rng: () => number): number {
  let fatigue = 0;
  let reps = 0;
  for (let set = 1; set <= MAX_SETS_B; set += 1) {
    const done = performSet(params, fatigue, { targetReps: BASELINE_B_TARGET_REPS }, rng);
    reps += done.repsDone;
    if (!completedTarget(done, BASELINE_B_TARGET_REPS)) break;
    fatigue = afterRest(params, done.fatigueAfter, BASELINE_B_REST_SEC);
  }
  return reps;
}

/** Mean and SD of total reps for one baseline-B group. */
function baselineBGroup(
  fit: FitParams,
  meanTau: number,
  spread: number,
  seed: number,
  population: number,
) {
  const rng = makeRng(seed);
  const totals = Array.from({ length: population }, () => {
    const tau = drawTau(meanTau, spread, rng);
    return runBaselineB(lifter({ ...BENCH_PRESS_75, n0: fit.n0B }, tau, fit), rng);
  });
  return { mean: mean(totals), sd: stdDev(totals) };
}

/** Rest a self-selecting lifter takes to fall back to `targetFatigue`. */
function restToRecover(params: LifterParams, fatigue: number, targetFatigue: number): number {
  if (fatigue <= targetFatigue) return 0;
  return params.tauSec * Math.log(fatigue / targetFatigue);
}

/**
 * Baseline C: a lifter who starts the next set once their opening velocity is
 * back within the design's own recovery target. The level is therefore the
 * staircase's definition of recovered, not a number tuned to hit 97 s, so the
 * first rest is an observation about the model and not a fit to the paper.
 */
export function runBaselineC(fit: FitParams, sets = 5): number[] {
  const params = lifter({ ...BACK_SQUAT_75, n0: BASELINE_C_N0 }, fit.tauCSec, fit);
  const rng = makeRng(90210);
  const recovered = (1 - OPENING_VELOCITY_TARGET) / params.velocityPenalty;
  let fatigue = 0;
  const rests: number[] = [];
  for (let set = 1; set <= sets; set += 1) {
    const done = performSet(params, fatigue, { targetReps: BASELINE_C_REPS }, rng);
    const rest = restToRecover(params, done.fatigueAfter, recovered);
    rests.push(Math.round(rest));
    fatigue = afterRest(params, done.fatigueAfter, rest);
  }
  return rests;
}

/** What one candidate parameter set scores against all three baselines. */
export interface FitScore {
  readonly params: FitParams;
  readonly error: number;
  readonly baselineA: { rest60: number; rest180: number; rest300: number };
  readonly openingDrop: { rest60: number; rest180: number; rest300: number };
  readonly baselineB: {
    womenMean: number;
    womenSd: number;
    menMean: number;
    menSd: number;
  };
  /** Baseline C's self-selected rests, set by set. */
  readonly baselineCRests: readonly number[];
}

/** Score a candidate: squared relative error on every published figure, plus the pattern. */
export function scoreFit(params: FitParams, seed = 4242, population = POPULATION_FIT): FitScore {
  const a60 = baselineAAt(params, 60, seed, population);
  const a180 = baselineAAt(params, 180, seed + 1, population);
  const a300 = baselineAAt(params, 300, seed + 2, population);
  const women = baselineBGroup(
    params,
    params.tauWomenSec,
    params.tauSpreadWomen,
    seed + 3,
    population,
  );
  const men = baselineBGroup(params, params.tauMenSec, params.tauSpreadMen, seed + 4, population);
  const rests = runBaselineC(params);
  const errors = publishedErrors(a60.reps, a180.reps, a300.reps, women, men, rests[0]);
  const pattern =
    patternPenalty(a60.openingDrop, a180.openingDrop, a300.openingDrop) + growthPenalty(rests);
  return {
    params,
    baselineCRests: rests,
    error: errors.reduce((sum, value) => sum + value * value, 0) + pattern,
    baselineA: { rest60: a60.reps, rest180: a180.reps, rest300: a300.reps },
    openingDrop: {
      rest60: a60.openingDrop,
      rest180: a180.openingDrop,
      rest300: a300.openingDrop,
    },
    baselineB: {
      womenMean: women.mean,
      womenSd: women.sd,
      menMean: men.mean,
      menSd: men.sd,
    },
  };
}

/**
 * Janicijevic's qualitative finding: the fastest rep falls set to set at 1 min
 * and not at 3 or 5.
 *
 * THE STABILITY CEILING IS UNVERIFIED AND STILL THE SIMULATION'S OWN NUMBER.
 * The amendment (s.6.1) asked for it to be set from the paper's set-by-set
 * velocities and their spread. Those figures are not in the research note,
 * which reports only the rep totals and the word "stable", and the paper itself
 * was not read for this work. So it is left at the measurement CV, with the
 * reasoning that a ceiling tighter than the instrument's own noise asks the
 * model to be steadier than the thing the paper measured with.
 *
 * What would settle it: the set-by-set fastest-rep velocities at 3 and 5 min
 * from https://pmc.ncbi.nlm.nih.gov/articles/PMC11812172/, and their
 * between-set spread. Until someone reads them, this check passing or failing
 * says as much about the ceiling as about the model. DO NOT loosen it to pass.
 */
export const DECLINE_AT_60_MIN = 0.03;
export const STABLE_AT_LONG_MAX = MEASUREMENT_CV;
export const STABILITY_CEILING_IS_SOURCED = false;

/** Relative error against every published figure the fit is scored on. */
function publishedErrors(
  a60: number,
  a180: number,
  a300: number,
  women: { mean: number; sd: number },
  men: { mean: number; sd: number },
  firstRest: number,
): number[] {
  return [
    relativeError(a60, BASELINE_A_TARGETS.rest60),
    relativeError(a180, BASELINE_A_TARGETS.rest180),
    relativeError(a300, BASELINE_A_TARGETS.rest300),
    relativeError(women.mean, BASELINE_B_TARGETS.womenMean),
    relativeError(men.mean, BASELINE_B_TARGETS.menMean),
    relativeError(women.sd, BASELINE_B_TARGETS.womenSd),
    relativeError(men.sd, BASELINE_B_TARGETS.menSd),
    relativeError(firstRest, BASELINE_C_FIRST_REST_SEC),
  ];
}

/** Alonso-Aubin's qualitative finding: a self-selecting lifter lengthens rest set by set. */
function growthPenalty(rests: readonly number[]): number {
  const falls = rests.filter((rest, index) => index > 0 && rest < rests[index - 1]).length;
  return falls * 0.25;
}

function patternPenalty(drop60: number, drop180: number, drop300: number): number {
  const shortfall = Math.max(0, DECLINE_AT_60_MIN - drop60);
  const excess180 = Math.max(0, drop180 - STABLE_AT_LONG_MAX);
  const excess300 = Math.max(0, drop300 - STABLE_AT_LONG_MAX);
  return 25 * (shortfall * shortfall + excess180 * excess180 + excess300 * excess300);
}

/** The search space. Every bound is a modelling choice, stated so it can be argued with. */
const SEARCH_BOUNDS = {
  fatigueCost: [0.1, 1.5],
  repsPenalty: [0.2, 1.0],
  velocityPenalty: [0.05, 0.6],
  tauASec: [30, 400],
  tauMenSec: [30, 600],
  tauWomenSec: [30, 600],
  tauSpreadWomen: [0.05, 0.9],
  tauSpreadMen: [0.05, 0.9],
  tauSpreadA: [0.05, 0.6],
  n0A: [6, 16],
  n0B: [6, 16],
  tauCSec: [30, 400],
} as const satisfies Record<keyof FitParams, readonly [number, number]>;

const PARAM_KEYS = Object.keys(SEARCH_BOUNDS) as (keyof FitParams)[];

/** Build a parameter set by asking `pick` for each key, so no key can be forgotten. */
function buildParams(pick: (key: keyof FitParams) => number): FitParams {
  const out = {} as Record<keyof FitParams, number>;
  for (const key of PARAM_KEYS) out[key] = pick(key);
  return out as FitParams;
}

function sample(rng: () => number): FitParams {
  return buildParams((key) => {
    const [low, high] = SEARCH_BOUNDS[key];
    return low + rng() * (high - low);
  });
}

/** Narrow a candidate around `best` as the search proceeds. */
function perturb(best: FitParams, scale: number, rng: () => number): FitParams {
  return buildParams((key) => {
    const [low, high] = SEARCH_BOUNDS[key];
    const moved = best[key] + (high - low) * scale * gaussian(rng);
    return Math.min(high, Math.max(low, moved));
  });
}

/**
 * Seeded random search, then a narrowing hill climb. Not an optimiser worth the
 * name; it only has to show the model CAN sit on the published numbers, and a
 * seeded search that anyone can re-run says that without a dependency.
 */
export function fitModel(restarts = 40, climbSteps = 120, seed = 11): FitScore {
  const rng = makeRng(seed);
  let best: FitScore | null = null;
  for (let restart = 0; restart < restarts; restart += 1) {
    const climbed = hillClimb(scoreFit(sample(rng)), climbSteps, rng);
    if (best === null || climbed.error < best.error) best = climbed;
  }
  return scoreFit((best as FitScore).params, 4242, POPULATION_REPORT);
}

/** Narrowing hill climb from one starting point, finished by a coordinate sweep. */
function hillClimb(start: FitScore, steps: number, rng: () => number): FitScore {
  let best = start;
  for (let step = 0; step < steps; step += 1) {
    const scale = 0.25 * (1 - step / steps) + 0.01;
    const scored = scoreFit(perturb(best.params, scale, rng));
    if (scored.error < best.error) best = scored;
  }
  return coordinateSweep(best);
}

const SWEEP_SCALES = [0.16, 0.08, 0.04, 0.02, 0.01];

/**
 * Move one parameter at a time. A random walk wanders in nine dimensions; a
 * coordinate sweep is what actually closes the last few percent of the fit.
 */
function coordinateSweep(start: FitScore): FitScore {
  let best = start;
  for (const scale of SWEEP_SCALES) {
    for (const key of PARAM_KEYS) {
      for (const direction of [1, -1]) {
        const [low, high] = SEARCH_BOUNDS[key];
        const moved = best.params[key] + direction * (high - low) * scale;
        if (moved < low || moved > high) continue;
        const scored = scoreFit({ ...best.params, [key]: moved });
        if (scored.error < best.error) best = scored;
      }
    }
  }
  return best;
}

/** Whether a fit clears every published tolerance the design set (s.10.2). */
export interface Stage1Verdict {
  readonly passed: boolean;
  readonly checks: readonly {
    name: string;
    observed: number;
    expected: number;
    tolerance: number;
    passed: boolean;
  }[];
  readonly baselineCRests: readonly number[];
  readonly baselineCGrows: boolean;
}

const A_TOLERANCE = 0.1;
const B_TOLERANCE = 0.15;

/**
 * Baseline C's tolerance. Wider than A's and B's because the rep target and the
 * reps-to-failure behind it are this simulation's assumptions, not the paper's.
 */
const C_TOLERANCE = 0.2;

export function judgeStage1(fit: FitScore): Stage1Verdict {
  const checks: ReturnType<typeof check>[] = [
    check('A: reps at 1 min rest', fit.baselineA.rest60, BASELINE_A_TARGETS.rest60, A_TOLERANCE),
    check('A: reps at 3 min rest', fit.baselineA.rest180, BASELINE_A_TARGETS.rest180, A_TOLERANCE),
    check('A: reps at 5 min rest', fit.baselineA.rest300, BASELINE_A_TARGETS.rest300, A_TOLERANCE),
    check(
      'B: women total reps',
      fit.baselineB.womenMean,
      BASELINE_B_TARGETS.womenMean,
      B_TOLERANCE,
    ),
    check('B: men total reps', fit.baselineB.menMean, BASELINE_B_TARGETS.menMean, B_TOLERANCE),
    check('B: women spread', fit.baselineB.womenSd, BASELINE_B_TARGETS.womenSd, B_TOLERANCE),
    check('B: men spread', fit.baselineB.menSd, BASELINE_B_TARGETS.menSd, B_TOLERANCE),
  ];
  const rests = fit.baselineCRests;
  const grows = rests.every((rest, index) => index === 0 || rest >= rests[index - 1]);
  checks.push(check('C: rest after set 1', rests[0], BASELINE_C_FIRST_REST_SEC, C_TOLERANCE));
  checks.push(
    atLeast('A: opening velocity falls at 1 min', fit.openingDrop.rest60, DECLINE_AT_60_MIN),
    atMost('A: opening velocity holds at 3 min', fit.openingDrop.rest180, STABLE_AT_LONG_MAX),
    atMost('A: opening velocity holds at 5 min', fit.openingDrop.rest300, STABLE_AT_LONG_MAX),
  );
  return {
    passed: checks.every((entry) => entry.passed) && grows,
    checks,
    baselineCRests: rests,
    baselineCGrows: grows,
  };
}

/** A one-sided check: the observation must reach at least `floor`. */
function atLeast(name: string, observed: number, floor: number) {
  return { name, observed, expected: floor, tolerance: 0, passed: observed >= floor };
}

/** A one-sided check: the observation must stay at or under `ceiling`. */
function atMost(name: string, observed: number, ceiling: number) {
  return { name, observed, expected: ceiling, tolerance: 0, passed: observed <= ceiling };
}

function check(name: string, observed: number, expected: number, tolerance: number) {
  return {
    name,
    observed,
    expected,
    tolerance,
    passed: relativeError(observed, expected) <= tolerance,
  };
}
