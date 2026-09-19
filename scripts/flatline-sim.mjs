#!/usr/bin/env node
// flatline-sim (VW-458): how often does each plateau-input smoother call a noisy
// climber flat, and how many weeks does it take to call a genuine flatline?
//
// Seeded and deterministic. Draws lifters (full, half and quarter ramp, flat,
// falling, and a flatline after a six-week climb) at start loads 40/135/315 lb
// with the real `programmedRampStepLbs`, noise ±1.5/3/5 lb (uniform and
// gaussian) and 1/2/3 sessions a week, then reads every candidate once a week
// the way `history.trend` would: weekly top-load points, 12-week lookback.
//
// Usage:
//   npm run build && node scripts/flatline-sim.mjs            # markdown to stdout
//   node scripts/flatline-sim.mjs --draws 4000 --json out.json
//
// Every row is a candidate defined in scripts/lib/flatline-sim-core.mjs. The
// real `flatline()` from dist/ is checked read for read against the row named
// by `--shipped-as`, on the first 25 draws of every cell, and the run throws on
// a disagreement.

import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectPlateau } from '@voltras/workout-analytics';

import * as core from './lib/flatline-sim-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { flatline } = await import(path.resolve(here, '../dist/analytics/flatline.js'));
const { programmedRampStepLbs } = await import(
  path.resolve(here, '../dist/analytics/goal-band.js')
);

const LOOKBACK_WEEKS = 12;
const CLIMB_WEEKS = 6;
const LATE_HORIZON_WEEKS = 10;
const GRID = {
  lifter: ['full_ramp', 'half_ramp', 'quarter_ramp', 'flat', 'falling', 'late_flatline'],
  noiseKind: ['uniform', 'gaussian'],
  noiseLbs: [1.5, 3, 5],
  sessionsPerWeek: [1, 2, 3],
  startLbs: [40, 135, 315],
};

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function shippedVerdict(points, smoothing) {
  const series = points.map((p) => ({ ts: new Date(p.t).toISOString(), value: p.v }));
  const expectedStepLbsPerWeek = programmedRampStepLbs(points[points.length - 1].v);
  const options = { expectedStepLbsPerWeek, minDays: core.MIN_DAYS, smoothing };
  return flatline(series, options) !== null;
}

const CANDIDATES = Object.fromEntries(
  Object.entries(core.STRATEGIES).map(([name, strategy]) => [
    name,
    (points, gates) => core.verdict(points, programmedRampStepLbs, strategy, gates),
  ]),
);
const DEEPEST_CONFIRM = Math.max(...Object.values(core.STRATEGIES).map((s) => s.confirm ?? 1));

/** The candidates the real `flatline()` must agree with, read for read: its default, and `smoothing: null`. */
const SHIPPED_AS = argument('shipped-as', 'rolling_top_2wk_min_21d_settled_1');
const RAW_AS = 'baseline';
const PARITY_DRAWS_PER_CELL = 25;
const parity = { reads: 0 };

function assertShippedParity(seen, verdicts) {
  parity.reads += 1;
  const agrees =
    shippedVerdict(seen, undefined) === verdicts[SHIPPED_AS] &&
    shippedVerdict(seen, null) === verdicts[RAW_AS];
  if (!agrees)
    throw new Error(`flatline() disagrees with its candidate on ${JSON.stringify(seen)}`);
}

/** One lifter, read weekly: which reads were flat, per candidate. */
function weeklyReads(points, firstRead, checkParity) {
  const reads = Object.fromEntries(Object.keys(CANDIDATES).map((name) => [name, []]));
  for (let week = firstRead; week < points.length; week++) {
    const seen = points.slice(Math.max(0, week + 1 - LOOKBACK_WEEKS), week + 1);
    const gates = core.readGates(seen, DEEPEST_CONFIRM);
    for (const [name, candidate] of Object.entries(CANDIDATES)) {
      reads[name].push(candidate(seen, gates));
    }
    if (checkParity) {
      const latest = Object.entries(reads).map(([name, flags]) => [name, flags[flags.length - 1]]);
      assertShippedParity(seen, Object.fromEntries(latest));
    }
  }
  return reads;
}

function drawPoints(cell, random) {
  const late = cell.lifter === 'late_flatline';
  const weeks = late ? CLIMB_WEEKS + 1 + LATE_HORIZON_WEEKS : LOOKBACK_WEEKS;
  const fractions = late
    ? core.lateFlatlineFractions(CLIMB_WEEKS, weeks)
    : core.LIFTERS[cell.lifter](weeks);
  const loads = core.trueLoads(cell.startLbs, fractions, programmedRampStepLbs);
  const noise = core.noiseSampler(cell.noiseKind, cell.noiseLbs, random);
  return core.weeklyTopLoads(loads, cell.sessionsPerWeek, noise);
}

function emptyTally() {
  return { draws: 0, reads: 0, flatReads: 0, everFlat: 0, firstFlatRead: [] };
}

/** `firstFlatRead` counts weekly reads from the first one taken: for the late flatline that is weeks after the last step. */
function tallyCell(cell, draws, seed) {
  const random = core.seededRandom(seed);
  const tallies = Object.fromEntries(Object.keys(CANDIDATES).map((name) => [name, emptyTally()]));
  const firstRead = cell.lifter === 'late_flatline' ? CLIMB_WEEKS + 1 : 2;
  for (let draw = 0; draw < draws; draw++) {
    const reads = weeklyReads(drawPoints(cell, random), firstRead, draw < PARITY_DRAWS_PER_CELL);
    for (const [name, flags] of Object.entries(reads)) {
      const tally = tallies[name];
      const first = flags.indexOf(true);
      tally.draws += 1;
      tally.reads += flags.length;
      tally.flatReads += flags.filter(Boolean).length;
      if (first !== -1) tally.everFlat += 1;
      tally.firstFlatRead.push(first === -1 ? null : first + 1);
    }
  }
  return tallies;
}

function* cells() {
  for (const lifter of GRID.lifter)
    for (const noiseKind of GRID.noiseKind)
      for (const noiseLbs of GRID.noiseLbs)
        for (const sessionsPerWeek of GRID.sessionsPerWeek)
          for (const startLbs of GRID.startLbs)
            yield { lifter, noiseKind, noiseLbs, sessionsPerWeek, startLbs };
}

function runGrid(draws) {
  const results = [];
  let seed = 458;
  for (const cell of cells()) results.push({ cell, tallies: tallyCell(cell, draws, seed++) });
  return results;
}

/** Pool every cell matching `filter` into one tally per candidate. */
function pooled(results, filter) {
  const pool = Object.fromEntries(Object.keys(CANDIDATES).map((name) => [name, emptyTally()]));
  for (const { cell, tallies } of results) {
    if (!Object.entries(filter).every(([key, value]) => cell[key] === value)) continue;
    for (const [name, tally] of Object.entries(tallies)) {
      pool[name].draws += tally.draws;
      pool[name].reads += tally.reads;
      pool[name].flatReads += tally.flatReads;
      pool[name].everFlat += tally.everFlat;
      pool[name].firstFlatRead.push(...tally.firstFlatRead);
    }
  }
  return pool;
}

const label = (name) => (name === SHIPPED_AS ? `**${name} (shipped)**` : name);
const pct = (part, whole) => `${((100 * part) / whole).toFixed(1)}%`;

function delayStats(tally) {
  const fired = tally.firstFlatRead.filter((week) => week !== null).sort((a, b) => a - b);
  if (fired.length === 0) return { mean: 'n/a', median: 'n/a', p90: 'n/a', missed: '100.0%' };
  const at = (q) => fired[Math.min(fired.length - 1, Math.floor(q * fired.length))];
  return {
    mean: (fired.reduce((sum, week) => sum + week, 0) / fired.length).toFixed(2),
    median: String(at(0.5)),
    p90: String(at(0.9)),
    missed: pct(tally.draws - fired.length, tally.draws),
  };
}

function summaryTable(results, filter, title) {
  const by = (lifter) => pooled(results, { ...filter, lifter });
  const [full, half, quarter, flat, falling, late] = GRID.lifter.map(by);
  const lines = [
    `### ${title}`,
    '',
    '| candidate | full ramp: flat reads | full: ever in 12 wk | half ramp: flat reads | half: ever in 12 wk | quarter ramp: flat reads | flat lifter: flat reads | falling: flat reads | late flatline: mean delay (wk) | median | p90 | never in 10 wk |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const name of Object.keys(CANDIDATES)) {
    const delay = delayStats(late[name]);
    lines.push(
      `| ${label(name)} | ${pct(full[name].flatReads, full[name].reads)} | ${pct(full[name].everFlat, full[name].draws)} ` +
        `| ${pct(half[name].flatReads, half[name].reads)} | ${pct(half[name].everFlat, half[name].draws)} ` +
        `| ${pct(quarter[name].flatReads, quarter[name].reads)} | ${pct(flat[name].flatReads, flat[name].reads)} ` +
        `| ${pct(falling[name].flatReads, falling[name].reads)} | ${delay.mean} | ${delay.median} | ${delay.p90} | ${delay.missed} |`,
    );
  }
  return lines.join('\n');
}

/** VW-452's own study, reproduced exactly: its generator, its seed, one read of 3 to 5 weekly points at 100 lb. */
function reproduceBaseline(rampFraction) {
  const rows = [];
  for (const points of [3, 4, 5]) {
    let state = 452;
    const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
    let flat = 0;
    for (let draw = 0; draw < 4000; draw++) {
      const series = Array.from({ length: points }, (_, week) => ({
        t: Date.parse('2026-07-06T12:00:00.000Z') + week * core.WEEK_MS,
        v: 100 + 2.5 * rampFraction * week + (random() * 6 - 3),
      }));
      if (core.readsFlat(series, 2.5, core.STRATEGIES.baseline)) flat++;
    }
    rows.push(`| ${rampFraction} | ${points} | ${pct(flat, 4000)} |`);
  }
  return rows;
}

function baselineSection() {
  return [
    '### Baseline reproduction (VW-452 method: 100 lb, uniform ±3 lb, one read, 4000 draws)',
    '',
    '| ramp fraction | weekly points | reads flat |',
    '| --- | --- | --- |',
    ...reproduceBaseline(1),
    ...reproduceBaseline(0.5),
  ].join('\n');
}

/** A lifter with no noise at all: the structural delay each candidate adds, before any noise. */
function quietSection() {
  const lines = [
    '### No noise: weeks from the last step to the first flat read',
    '',
    '| candidate | 40 lb | 135 lb | 315 lb |',
    '| --- | --- | --- | --- |',
  ];
  const delays = GRID.startLbs.map((startLbs) => {
    const cell = {
      lifter: 'late_flatline',
      noiseKind: 'uniform',
      noiseLbs: 0,
      sessionsPerWeek: 1,
      startLbs,
    };
    return tallyCell(cell, 1, 0);
  });
  for (const name of Object.keys(CANDIDATES)) {
    lines.push(
      `| ${name} | ${delays.map((d) => d[name].firstFlatRead[0] ?? 'never').join(' | ')} |`,
    );
  }
  return lines.join('\n');
}

/** The fast whole-run check must agree with WA's detector, or every row below is about a different rule. */
function assertGateMatchesWa() {
  const random = core.seededRandom(1);
  for (let draw = 0; draw < 2000; draw++) {
    const noise = core.noiseSampler('uniform', 5, random);
    const loads = core.trueLoads(
      100,
      core.LIFTERS.half_ramp(3 + (draw % 8)),
      programmedRampStepLbs,
    );
    const points = core.weeklyTopLoads(loads, 1, noise);
    const series = points.map((p) => ({ ts: new Date(p.t).toISOString(), value: p.v }));
    const wa = detectPlateau(series, core.WA_THRESHOLD_PCT, 0);
    const days = (points[points.length - 1].t - points[0].t) / core.DAY_MS;
    if (core.isWholePlateau(points) !== wa.plateauDays >= days) {
      throw new Error(`whole-run gate disagrees with detectPlateau on draw ${draw}`);
    }
  }
}

function report(results, draws) {
  const sections = [
    `Draws per cell: ${draws}. Cells: ${results.length}. Reads are weekly, 12-week lookback. ` +
      `The real flatline() matched '${SHIPPED_AS}' (its default) and '${RAW_AS}' (smoothing: null) on all ${parity.reads} sampled reads.`,
    baselineSection(),
    quietSection(),
    summaryTable(results, {}, 'All cells pooled'),
    summaryTable(
      results,
      { noiseKind: 'uniform', noiseLbs: 3, sessionsPerWeek: 1 },
      'Headline: uniform ±3 lb, 1 session a week, start loads pooled',
    ),
  ];
  for (const noiseKind of GRID.noiseKind)
    for (const noiseLbs of GRID.noiseLbs)
      sections.push(summaryTable(results, { noiseKind, noiseLbs }, `${noiseKind} ±${noiseLbs} lb`));
  for (const sessionsPerWeek of GRID.sessionsPerWeek)
    sections.push(
      summaryTable(results, { sessionsPerWeek }, `${sessionsPerWeek} session(s) a week`),
    );
  for (const startLbs of GRID.startLbs)
    sections.push(summaryTable(results, { startLbs }, `start load ${startLbs} lb`));
  return sections.join('\n\n');
}

assertGateMatchesWa();
const draws = Number(argument('draws', '1000'));
const results = runGrid(draws);
const jsonPath = argument('json', null);
if (jsonPath !== null) {
  const slim = results.map(({ cell, tallies }) => ({
    cell,
    tallies: Object.fromEntries(
      Object.entries(tallies).map(([name, tally]) => [
        name,
        { ...tally, ...delayStats(tally), firstFlatRead: undefined },
      ]),
    ),
  }));
  writeFileSync(jsonPath, JSON.stringify({ draws, results: slim }, null, 2));
}
process.stdout.write(`${report(results, draws)}\n`);
