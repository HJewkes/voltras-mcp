#!/usr/bin/env node
// flatline-sim (VW-458): how often does each plateau-input smoother call a noisy
// climber flat, and how many weeks does it take to call a genuine flatline?
//
// Seeded and deterministic. Draws lifters (full, half and quarter ramp, flat,
// falling, and a flatline after a six-week climb) at start loads 40/135/315 lb
// climbing the real `plateauReferenceStepLbs` (or, with `--lifter-ramp`, the goal
// ramp's `programmedRampStepLbs` for that class), noise ±1.5/3/5 lb (uniform and
// gaussian) and 1/2/3 sessions a week, then reads every candidate once a week
// the way `history.trend` would: weekly top-load points, 12-week lookback.
//
// Usage:
//   npm run build && node scripts/flatline-sim.mjs            # markdown to stdout
//   node scripts/flatline-sim.mjs --draws 4000 --json out.json
//   node scripts/flatline-sim.mjs --lifter-ramp isolation --rule reference
//   node scripts/flatline-sim.mjs --lifter-ramp isolation --rule hybrid   # or class
//   node scripts/flatline-sim.mjs --lifter-ramp reference --rule hybrid --rule-class isolation
//   node scripts/flatline-sim.mjs --ramp-class isolation   # = --lifter-ramp isolation --rule class
//   node scripts/flatline-sim.mjs --measured-pct 0.5       # a measured slope in percent of load a week
//
// `--rule` picks the step every row judges by: reference, class, or hybrid
// (VW-490 R7c's step, min of the two); the light_min_35d row on `--rule hybrid`
// is R7c itself. Every row is a candidate defined in scripts/lib/flatline-sim-core.mjs.
// WA's `detectPlateau` rate mode is checked read for read against the row named
// by `--shipped-as`, on the first 25 draws of every cell, and the run throws on
// a disagreement.
//
// `--retro <path>` (VW-672) prints the historical recall count only; `--help` has the input shape.

import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectPlateau } from '@voltras/workout-analytics';

import * as core from './lib/flatline-sim-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { plateauReferenceStepLbs } = await import(
  path.resolve(here, '../dist/analytics/stall-step.js')
);
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

const RAMP_CLASSES = ['isolation', 'upper_compound', 'lower_compound'];
const RULES = ['reference', 'class', 'hybrid'];
const classStep = (rampClass) => (loadLbs) =>
  programmedRampStepLbs(loadLbs, rampClass, 'intermediate');

function oneOf(name, value, allowed) {
  if (value !== null && !allowed.includes(value))
    throw new Error(`--${name} must be one of ${allowed.join(', ')}; got '${value}'`);
  return value;
}

/** VW-482: `--ramp-class` is shorthand for a lifter on that class ramp judged by the class step. */
const RAMP_CLASS = oneOf('ramp-class', argument('ramp-class', null), RAMP_CLASSES);
/** VW-558 H4: `--measured-pct` judges against a lifter's own measured weekly slope, with no floor. */
const MEASURED_PCT = argument('measured-pct', null);
/** VW-671: the lifter's climb, apart from the step the stall rule judges it by. */
const LIFTER_RAMP = oneOf('lifter-ramp', argument('lifter-ramp', RAMP_CLASS ?? 'reference'), [
  'reference',
  ...RAMP_CLASSES,
]);
const RULE = oneOf('rule', argument('rule', RAMP_CLASS === null ? 'reference' : 'class'), RULES);
const RULE_CLASS = oneOf(
  'rule-class',
  argument('rule-class', LIFTER_RAMP === 'reference' ? null : LIFTER_RAMP),
  RAMP_CLASSES,
);
/** VW-672: the retro-data file for the historical recall count. */
const HELP = `Usage: node scripts/flatline-sim.mjs --retro <path-to-retro-file> [--rule reference|class|hybrid]

Reads the retro-data JSON that \`npm run retro:truecoach -- ... --json <file>\` writes and prints
one line, "k of n historical flatlines fire (--rule <rule>)", and nothing else.

Input shape (other keys are ignored; anything else malformed fails the run):
  { "lifts": [ { "family": string,
                 "sessions": [ { "date": "YYYY-MM-DD", "topLoad": number, "e1rm": number | null } ],
                 "plateaus": [ { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD",
                                 "rule": "flatline" | "wa_window" } ] } ] }
Sessions are in date order, one a day. Each "flatline" plateau is one historical flatline.

A window fires when the rule reads the lift's e1RM history, up to any session inside the window,
flat, with the step read at the median top load of the lift's valued sessions: the retro tool's
own labelling. --rule class and hybrid take the class from the family the way
\`sim:goal-ramp --retro\` does (squat and deadlift lower compound, the rest upper compound) at the
intermediate tier. hybrid is VW-490 R7c: the smaller step, and the light_min_35d row.
Every read is also checked against WA detectPlateau rate mode at the rule's step; a disagreement throws.
Without --retro the script runs the synthetic grid; see the header of this file.
`;
const RETRO = argument('retro', null);
if (RULE !== 'reference' && RULE_CLASS === null && RETRO === null)
  throw new Error(`--rule ${RULE} needs a class: pass --rule-class or a class --lifter-ramp`);

function chooseLifterStep() {
  if (MEASURED_PCT !== null) return (loadLbs) => (loadLbs * Number(MEASURED_PCT)) / 100;
  return LIFTER_RAMP === 'reference' ? plateauReferenceStepLbs : classStep(LIFTER_RAMP);
}

/** `hybrid` is VW-490 R7c's step: the smaller of the reference and the class step. */
function chooseRuleStep() {
  if (MEASURED_PCT !== null) return chooseLifterStep();
  if (RULE === 'reference') return plateauReferenceStepLbs;
  if (RULE === 'class') return classStep(RULE_CLASS);
  const byClass = classStep(RULE_CLASS);
  return (loadLbs) => Math.min(plateauReferenceStepLbs(loadLbs), byClass(loadLbs));
}
const lifterStepAt = chooseLifterStep();
const stepAt = chooseRuleStep();
const describe = (ramp) => (ramp === 'reference' ? 'plateau reference' : `${ramp} class`);
const STEP_LABEL =
  MEASURED_PCT !== null
    ? `measured ${MEASURED_PCT}%/wk`
    : `lifter climbs the ${describe(LIFTER_RAMP)} step; rule '${RULE}'` +
      (RULE === 'reference' ? '' : ` on the ${RULE_CLASS} class`);

function shippedVerdict(
  points,
  smoothing,
  expectedStepLbsPerWeek = stepAt(points[points.length - 1].v),
) {
  const series = points.map((p) => ({ ts: new Date(p.t).toISOString(), value: p.v }));
  const options = {
    expectedRatePerWeek: expectedStepLbsPerWeek,
    minDays: core.MIN_DAYS,
    smoothing,
  };
  return detectPlateau(series, options).isPlateau;
}

const CANDIDATES = Object.fromEntries(
  Object.entries(core.STRATEGIES).map(([name, strategy]) => [
    name,
    (points, gates) => core.verdict(points, stepAt, strategy, gates),
  ]),
);
const DEEPEST_CONFIRM = Math.max(...Object.values(core.STRATEGIES).map((s) => s.confirm ?? 1));

/** The candidates WA's rate mode must agree with, read for read: its default, and `smoothing: null`. */
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
    throw new Error(
      `detectPlateau rate mode disagrees with its candidate on ${JSON.stringify(seen)}`,
    );
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
  const loads = core.trueLoads(cell.startLbs, fractions, lifterStepAt);
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
    const loads = core.trueLoads(100, core.LIFTERS.half_ramp(3 + (draw % 8)), lifterStepAt);
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
    `Step: ${STEP_LABEL}. Draws per cell: ${draws}. Cells: ${results.length}. Reads are weekly, 12-week lookback. ` +
      `WA detectPlateau rate mode matched '${SHIPPED_AS}' (its default) and '${RAW_AS}' (smoothing: null) on all ${parity.reads} sampled reads.`,
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

/** The step `--rule` judges a retro lift by, at its median top load. */
function retroStep({ loadLbs, rampClass }) {
  const reference = plateauReferenceStepLbs(loadLbs);
  if (RULE === 'reference') return reference;
  const byClass = programmedRampStepLbs(loadLbs, rampClass, 'intermediate');
  return RULE === 'class' ? byClass : Math.min(reference, byClass);
}

/** The shipped row must match WA's rate mode on every retro read, or the count is about a different rule. */
function retroFires(points, retroCase) {
  const step = retroStep(retroCase);
  const shipped = shippedVerdict(points, undefined, step);
  if (core.readsFlat(points, step, core.STRATEGIES[SHIPPED_AS]) !== shipped)
    throw new Error(`detectPlateau rate mode disagrees with '${SHIPPED_AS}' on a retro read`);
  return RULE === 'hybrid' ? core.readsFlat(points, step, core.STRATEGIES.light_min_35d) : shipped;
}

function runSyntheticGrid() {
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
}

if (process.argv.includes('--help')) process.stdout.write(HELP);
else if (RETRO !== null)
  process.stdout.write(
    `${core.recallLine(core.retroRecall(core.loadRetro(RETRO), retroFires), RULE)}\n`,
  );
else runSyntheticGrid();
