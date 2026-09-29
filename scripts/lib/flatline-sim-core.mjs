// flatline-sim core (VW-458): seeded lifters, candidate input smoothers and the
// run search they plug into. PURE and deterministic: same seed, same numbers.
// The one exception is `loadRetro`, which reads the `--retro` file (VW-672).
//
// The series a lifter produces mirrors what `computeHistoryTrend` hands to
// `flatline()`: one point per ISO week, carrying the week's TOP load, stamped
// on the Monday. Sessions inside a week share one true load and differ by noise.

import { readFileSync } from 'node:fs';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;
export const FLAT_FRACTION = 0.25;
export const WA_THRESHOLD_PCT = 5;
export const MIN_DAYS = 14;
/** VW-490 R7c: a rule step under this many lb a week counts as a light lift. */
export const LIGHT_STEP_LBS = 2;

const FIRST_MONDAY_MS = Date.parse('2026-01-05T00:00:00.000Z');

/** mulberry32: a small seeded generator, so every table is reproducible. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 1831565813) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** `uniform`: flat on ±amplitude. `gaussian`: sigma = amplitude / 2, so ±amplitude is the 2-sigma band. */
export function noiseSampler(kind, amplitudeLbs, random) {
  if (kind === 'uniform') return () => (random() * 2 - 1) * amplitudeLbs;
  return () => {
    const radius = Math.sqrt(-2 * Math.log(1 - random()));
    return radius * Math.cos(2 * Math.PI * random()) * (amplitudeLbs / 2);
  };
}

/**
 * The lifter's true top load for each week. `rampFractions[w]` is the share of
 * the programmed step added going INTO week w+1, recomputed at the current load
 * the way the coach's ramp is.
 */
export function trueLoads(startLbs, rampFractions, stepAt) {
  const loads = [startLbs];
  for (const fraction of rampFractions) {
    const current = loads[loads.length - 1];
    loads.push(current + fraction * stepAt(current));
  }
  return loads;
}

export const LIFTERS = {
  full_ramp: (weeks) => Array(weeks - 1).fill(1),
  half_ramp: (weeks) => Array(weeks - 1).fill(0.5),
  quarter_ramp: (weeks) => Array(weeks - 1).fill(0.25),
  flat: (weeks) => Array(weeks - 1).fill(0),
  falling: (weeks) => Array(weeks - 1).fill(-0.5),
};

/** Full ramp for `climbWeeks` steps, then no step at all: the genuine late flatline. */
export function lateFlatlineFractions(climbWeeks, weeks) {
  return Array.from({ length: weeks - 1 }, (_, week) => (week < climbWeeks ? 1 : 0));
}

/** Weekly top-load points: the max of `sessionsPerWeek` noisy sessions, stamped on the Monday. */
export function weeklyTopLoads(loads, sessionsPerWeek, noise) {
  return loads.map((load, week) => {
    let top = -Infinity;
    for (let session = 0; session < sessionsPerWeek; session++) top = Math.max(top, load + noise());
    return { t: FIRST_MONDAY_MS + week * WEEK_MS, v: top };
  });
}

// ---------------------------------------------------------------------------
// Smoothers: same length and timestamps out as in.
// ---------------------------------------------------------------------------

function trailing(points, index, windowDays) {
  const from = points[index].t - windowDays * DAY_MS;
  const values = [];
  for (let j = index; j >= 0 && points[j].t > from; j--) values.push(points[j].v);
  return values;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export const smoothers = {
  none: (points) => points,
  rollingMax: (windowDays) => (points) =>
    points.map((p, i) => ({ t: p.t, v: Math.max(...trailing(points, i, windowDays)) })),
  rollingMedian: (windowDays) => (points) =>
    points.map((p, i) => ({ t: p.t, v: median(trailing(points, i, windowDays)) })),
  rollingMean: (windowDays) => (points) =>
    points.map((p, i) => {
      const window = trailing(points, i, windowDays);
      return { t: p.t, v: window.reduce((sum, v) => sum + v, 0) / window.length };
    }),
};

// ---------------------------------------------------------------------------
// Slopes over points[start..], in lb per week.
// ---------------------------------------------------------------------------

export function olsSlope(points, start = 0) {
  const count = points.length - start;
  let meanX = 0;
  let meanY = 0;
  for (let i = start; i < points.length; i++) {
    meanX += points[i].t / WEEK_MS / count;
    meanY += points[i].v / count;
  }
  let covariance = 0;
  let varianceX = 0;
  for (let i = start; i < points.length; i++) {
    const dx = points[i].t / WEEK_MS - meanX;
    covariance += dx * (points[i].v - meanY);
    varianceX += dx * dx;
  }
  return varianceX === 0 ? 0 : covariance / varianceX;
}

/** Theil-Sen: the median of every pairwise slope. */
export function theilSenSlope(points, start = 0) {
  const slopes = [];
  for (let i = start; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      slopes.push(((points[j].v - points[i].v) / (points[j].t - points[i].t)) * WEEK_MS);
    }
  }
  return slopes.length === 0 ? 0 : median(slopes);
}

// ---------------------------------------------------------------------------
// The run search every candidate shares.
// ---------------------------------------------------------------------------

/** WA's verdict on a WHOLE run: every value inside ±5% of the run's median. Checked against `detectPlateau` in the CLI. */
export function isWholePlateau(points, start = 0) {
  const values = [];
  for (let i = start; i < points.length; i++) values.push(points[i].v);
  const mid = median(values);
  const threshold = Math.abs(mid) * (WA_THRESHOLD_PCT / 100);
  return values.every((v) => Math.abs(v - mid) <= threshold);
}

/**
 * The series' week-to-week scatter in lb, read off its BENDS (the change in
 * rate at each interior point) so a steady climb contributes nothing and one
 * climb-to-flat corner is a lone outlier the median ignores.
 */
export function scatterLbs(points) {
  const bends = [];
  for (let i = 1; i < points.length - 1; i++) {
    const left = (points[i].t - points[i - 1].t) / WEEK_MS;
    const right = (points[i + 1].t - points[i].t) / WEEK_MS;
    const bend = (points[i + 1].v - points[i].v) / right - (points[i].v - points[i - 1].v) / left;
    bends.push(
      Math.abs(bend) / Math.sqrt(1 / right ** 2 + (1 / left + 1 / right) ** 2 + 1 / left ** 2),
    );
  }
  return bends.length === 0 ? 0 : 1.4826 * median(bends);
}

function spreadWeeks(points, start) {
  let mean = 0;
  for (let i = start; i < points.length; i++)
    mean += points[i].t / WEEK_MS / (points.length - start);
  let spread = 0;
  for (let i = start; i < points.length; i++) spread += (points[i].t / WEEK_MS - mean) ** 2;
  return Math.sqrt(spread);
}

/** Rule on a run only when its slope is resolved to within `kappa` flatline thresholds. */
const resolvedWithin = (kappa) => (points, start, flatBelow) =>
  scatterLbs(points) / spreadWeeks(points, start) <= kappa * flatBelow;

/** WA's whole-run verdict for every trailing run, computed once per read and shared by every candidate. */
export function plateauGate(points) {
  return points.map((_, start) => isWholePlateau(points, start));
}

/**
 * Longest trailing run first. WA judges the RAW run, so no candidate can ever
 * add a plateau WA did not find; only the slope reads the smoothed values.
 */
export function readsFlat(points, expectedStep, strategy, gate = plateauGate(points)) {
  const smoothed = strategy.smooth(points);
  const flatBelow = expectedStep * FLAT_FRACTION;
  const last = points[points.length - 1].t;
  for (let start = 0; start < points.length - 1; start++) {
    const days = (last - points[start].t) / DAY_MS;
    if (days < MIN_DAYS) return false;
    const minRunDays = minRunDaysFor(strategy, expectedStep);
    if (!gate[start] || !longEnough(points, start, days, minRunDays, flatBelow, strategy)) continue;
    if (strategy.slope(smoothed, start) >= flatBelow) continue;
    if (strategy.trusts === undefined || strategy.trusts(points, start, flatBelow)) return true;
  }
  return false;
}

/** `lightMinRunDays` replaces `minRunDays` when the rule step is a light lift's. */
function minRunDaysFor(strategy, expectedStep) {
  if (strategy.lightMinRunDays !== undefined && expectedStep < LIGHT_STEP_LBS)
    return strategy.lightMinRunDays;
  return strategy.minRunDays ?? 0;
}

/** `settledWeeks` lets a run under the floor through when its whole range is within that many weeks of flatline-rate movement. */
function longEnough(points, start, days, minRunDays, flatBelow, strategy) {
  if (days >= minRunDays) return true;
  if (strategy.settledWeeks === undefined) return false;
  let low = Infinity;
  let high = -Infinity;
  for (let i = start; i < points.length; i++) {
    low = Math.min(low, points[i].v);
    high = Math.max(high, points[i].v);
  }
  return high - low <= flatBelow * strategy.settledWeeks;
}

/** `gates[back]` is the gate for the series with its last `back` points dropped. */
export function readGates(points, deepestConfirm) {
  return Array.from({ length: deepestConfirm }, (_, back) =>
    plateauGate(points.slice(0, points.length - back)),
  );
}

/** `confirm: n` asks for the same verdict at each of the last n weekly reads. */
export function verdict(
  points,
  stepAt,
  strategy,
  gates = readGates(points, strategy.confirm ?? 1),
) {
  const reads = strategy.confirm ?? 1;
  for (let back = 0; back < reads; back++) {
    const upTo = points.slice(0, points.length - back);
    if (upTo.length < 2) return false;
    if (!readsFlat(upTo, stepAt(upTo[upTo.length - 1].v), strategy, gates[back])) return false;
  }
  return true;
}

export const STRATEGIES = {
  baseline: { smooth: smoothers.none, slope: olsSlope },
  rolling_top_2wk: { smooth: smoothers.rollingMax(14), slope: olsSlope },
  rolling_top_3wk: { smooth: smoothers.rollingMax(21), slope: olsSlope },
  rolling_median_3wk: { smooth: smoothers.rollingMedian(21), slope: olsSlope },
  rolling_mean_2wk: { smooth: smoothers.rollingMean(14), slope: olsSlope },
  theil_sen: { smooth: smoothers.none, slope: theilSenSlope },
  rolling_top_2wk_theil_sen: { smooth: smoothers.rollingMax(14), slope: theilSenSlope },
  min_run_21d: { smooth: smoothers.none, slope: olsSlope, minRunDays: 21 },
  min_run_28d: { smooth: smoothers.none, slope: olsSlope, minRunDays: 28 },
  confirm_2_reads: { smooth: smoothers.none, slope: olsSlope, confirm: 2 },
  resolved_within_1_5: { smooth: smoothers.none, slope: olsSlope, trusts: resolvedWithin(1.5) },
  resolved_within_1: { smooth: smoothers.none, slope: olsSlope, trusts: resolvedWithin(1) },
  rolling_top_2wk_min_21d: { smooth: smoothers.rollingMax(14), slope: olsSlope, minRunDays: 21 },
  min_run_21d_settled_2: {
    smooth: smoothers.none,
    slope: olsSlope,
    minRunDays: 21,
    settledWeeks: 2,
  },
  min_run_21d_settled_1: {
    smooth: smoothers.none,
    slope: olsSlope,
    minRunDays: 21,
    settledWeeks: 1,
  },
  rolling_top_2wk_min_21d_settled_1: {
    smooth: smoothers.rollingMax(14),
    slope: olsSlope,
    minRunDays: 21,
    settledWeeks: 1,
  },
  light_min_35d: {
    smooth: smoothers.rollingMax(14),
    slope: olsSlope,
    minRunDays: 21,
    settledWeeks: 1,
    lightMinRunDays: 35,
  },
};

// ---------------------------------------------------------------------------
// Historical recall (VW-672): the retro file's flatline windows, re-read by a rule.
// Errors name a field by its index and never echo a value from the file.
// ---------------------------------------------------------------------------

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const PLATEAU_RULES = new Set(['flatline', 'wa_window']);
const LOWER_FAMILIES = new Set(['squat', 'deadlift']);

/** The same family-to-class map as `sim:goal-ramp --retro`: squat and deadlift are lower, the rest upper. */
export const retroRampClass = (family) =>
  LOWER_FAMILIES.has(family) ? 'lower_compound' : 'upper_compound';

function malformed(where, what) {
  return new Error(`retro file: ${where} ${what}`);
}

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isDay = (value) =>
  typeof value === 'string' && ISO_DAY.test(value) && Number.isFinite(Date.parse(value));

function checkSession(session, where, previousDate) {
  if (!isRecord(session)) throw malformed(where, 'must be an object');
  if (!isDay(session.date)) throw malformed(`${where}.date`, 'must be a YYYY-MM-DD day');
  if (previousDate !== null && session.date <= previousDate)
    throw malformed(`${where}.date`, 'must come after the session before it');
  if (!Number.isFinite(session.topLoad)) throw malformed(`${where}.topLoad`, 'must be a number');
  if (session.e1rm !== null && !Number.isFinite(session.e1rm))
    throw malformed(`${where}.e1rm`, 'must be a number or null');
}

function checkPlateau(plateau, where) {
  if (!isRecord(plateau)) throw malformed(where, 'must be an object');
  if (!isDay(plateau.start) || !isDay(plateau.end) || plateau.end < plateau.start)
    throw malformed(where, 'needs YYYY-MM-DD start and end, start first');
  if (!PLATEAU_RULES.has(plateau.rule))
    throw malformed(`${where}.rule`, 'must be flatline or wa_window');
}

function checkLift(lift, where) {
  if (!isRecord(lift)) throw malformed(where, 'must be an object');
  if (typeof lift.family !== 'string') throw malformed(`${where}.family`, 'must be a string');
  if (!Array.isArray(lift.sessions)) throw malformed(`${where}.sessions`, 'must be an array');
  if (!Array.isArray(lift.plateaus)) throw malformed(`${where}.plateaus`, 'must be an array');
  lift.sessions.forEach((session, index) =>
    checkSession(session, `${where}.sessions[${index}]`, lift.sessions[index - 1]?.date ?? null),
  );
  lift.plateaus.forEach((plateau, index) => checkPlateau(plateau, `${where}.plateaus[${index}]`));
}

const noonMs = (day) => Date.parse(`${day}T12:00:00.000Z`);

/**
 * One case per flatline window. Like the retro tool, a read is the lift's whole e1RM history up
 * to one session inside the window, and the step reads the median top load of every valued session.
 */
function liftCases(lift, where) {
  const valued = lift.sessions.filter((session) => session.e1rm !== null);
  const flatlines = lift.plateaus.filter((plateau) => plateau.rule === 'flatline');
  if (flatlines.length > 0 && valued.length === 0)
    throw malformed(`${where}.sessions`, 'hold no e1rm for a flatline window to read');
  const points = valued.map((session) => ({ t: noonMs(session.date), v: session.e1rm }));
  const loadLbs = median(valued.map((session) => session.topLoad));
  return flatlines.map((window, index) => {
    const ends = valued.flatMap((s, i) =>
      s.date >= window.start && s.date <= window.end ? [i] : [],
    );
    if (ends.length === 0)
      throw malformed(`${where}.plateaus`, `flatline window ${index} covers no valued session`);
    const reads = ends.map((end) => points.slice(0, end + 1));
    return { rampClass: retroRampClass(lift.family), loadLbs, reads };
  });
}

/** The retro-data JSON (`npm run retro:truecoach -- ... --json`), read fail-closed. */
export function parseRetro(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('retro file: not valid JSON');
  }
  if (!isRecord(data) || !Array.isArray(data.lifts)) throw malformed('lifts', 'must be an array');
  data.lifts.forEach((lift, index) => checkLift(lift, `lifts[${index}]`));
  const cases = data.lifts.flatMap((lift, index) => liftCases(lift, `lifts[${index}]`));
  if (cases.length === 0) throw malformed('lifts[].plateaus', 'hold no flatline window');
  return cases;
}

/** The path is the caller's own, so the error names only the failure code. */
export function loadRetro(path, read = readFileSync) {
  let text;
  try {
    text = read(path, 'utf8');
  } catch (error) {
    throw new Error(`retro file: cannot read the --retro path (${error?.code ?? 'unreadable'})`);
  }
  return parseRetro(text);
}

/** A window fires when `fires` reads any of its sessions flat, the way the retro tool labelled it. */
export function retroRecall(cases, fires) {
  const fired = cases.filter((retroCase) =>
    retroCase.reads.some((points) => fires(points, retroCase)),
  ).length;
  return { fired, total: cases.length };
}

export const recallLine = ({ fired, total }, rule) =>
  `${fired} of ${total} historical flatlines fire (--rule ${rule})`;
