// Rendering for the adaptive-rest simulation (VW-516): one JSON result and one
// markdown table. No personal values appear here; every number is synthetic.

import { ADAPTIVE_REST_POLICY, type RestIntentKey } from '../../src/analytics/adaptive-rest.js';
import type { FitScore, Stage1Verdict } from './stage1-baselines.js';
import type { ReplayCounts } from './replay.js';
import type { FalseArrivalResult, Stage2Result } from './stage2-staircase.js';

/** One ship gate from design s.10.3. */
export interface Gate {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface SimulationReport {
  readonly generatedFor: string;
  readonly policyVersion: string;
  readonly stage1: { fit: FitScore; verdict: Stage1Verdict };
  readonly stage2: readonly Stage2Result[];
  /** Lifters with 4 to 6 exercises, so the lifter-factor seed is exercised. */
  readonly multiKey: readonly Stage2Result[];
  readonly falseArrivals: FalseArrivalResult;
  /** Counts from the read-only replay over a copy of the store, or null when it was not run. */
  readonly replay: ReplayCounts | null;
  readonly gates: readonly Gate[];
  readonly defaultsMoved: readonly string[];
  readonly recommendations: readonly string[];
}

function round(value: number, places = 2): number {
  return Number(value.toFixed(places));
}

function pct(value: number): string {
  return `${round(value * 100, 1)}%`;
}

function tick(passed: boolean): string {
  return passed ? 'pass' : 'FAIL';
}

function stage1Table(verdict: Stage1Verdict): string {
  const rows = verdict.checks.map((entry) => {
    const expected = entry.tolerance === 0 ? `${round(entry.expected, 3)}` : `${entry.expected}`;
    const tolerance = entry.tolerance === 0 ? 'one-sided' : `±${pct(entry.tolerance)}`;
    return `| ${entry.name} | ${round(entry.observed, 3)} | ${expected} | ${tolerance} | ${tick(entry.passed)} |`;
  });
  return [
    '| Check | Simulated | Published | Tolerance | Verdict |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function fitTable(fit: FitScore): string {
  const rows = Object.entries(fit.params).map(
    ([key, value]) => `| \`${key}\` | ${round(value as number, 3)} |`,
  );
  return ['| Parameter | Fitted |', '| --- | --- |', ...rows].join('\n');
}

function stage2Table(results: readonly Stage2Result[], intent: RestIntentKey): string {
  const rows = results
    .filter((result) => result.intent === intent)
    .map(
      (result) =>
        `| ${result.lifter} | ${result.behaviour} | ${result.trueRestSec} | ${result.finalSec} | ` +
        `${result.daysToLearned ?? 'never'} | ${result.errorAtLearnedSec ?? 'n/a'} | ` +
        `${result.errorAtDay12Sec ?? 'n/a'} | ${pct(result.bounceAfterLearned)} | ` +
        `${pct(result.underRecoveredShare)} | ${pct(result.underRecoveredShareOnDefault)} | ` +
        `${round(result.restMinutesPerSession, 1)} | ${round(result.restMinutesPerSessionOnDefault, 1)} |`,
    );
  return [
    '| Population | Behaviour | True rest (s) | Final T (s) | Days to learned | Err at learned (s) | Err at day 12 (s) | Bounce after learned | Under-recovered | Same on default | Rest min/session | Same on default |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** Median of a sample, or null when it is empty. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The one number that explains most of the stage 2 table: how far the learned
 * value still is from the lifter's rest at the moment the record calls itself
 * learned, against how far it is nine days later.
 */
function convergenceSummary(results: readonly Stage2Result[]): string {
  const learned = results.filter((result) => result.daysToLearned !== null);
  const days = median(learned.map((result) => result.daysToLearned as number));
  const atLearned = median(learned.map((result) => Math.abs(result.errorAtLearnedSec ?? 0)));
  const atDay12 = median(
    results.filter((r) => r.errorAtDay12Sec !== null).map((r) => Math.abs(r.errorAtDay12Sec ?? 0)),
  );
  return [
    `Records that reached \`learned\`: ${learned.length} of ${results.length}.`,
    `Median exercise-days to \`learned\`: **${days ?? 'n/a'}**.`,
    `Median distance from the lifter's true rest at that moment: **${atLearned ?? 'n/a'} s**.`,
    `Median distance after 12 exercise-days: **${atDay12 ?? 'n/a'} s**.`,
  ].join(' ');
}

/**
 * Amendment s.6.2, finding 5: no earlier run ever reached `seedRest`'s
 * lifter-factor path, because each simulated lifter had one key. These lifters
 * have four to six.
 */
function multiKeySection(results: readonly Stage2Result[]): string {
  const bySource = new Map<string, number>();
  for (const result of results) {
    bySource.set(result.seedSource, (bySource.get(result.seedSource) ?? 0) + 1);
  }
  const fromFactor = results.filter((result) => result.seedSource === 'lifter_factor');
  const learned = fromFactor.filter((result) => result.daysToLearned !== null);
  const rows = [...bySource.entries()].map(([source, n]) => `| \`${source}\` | ${n} |`);
  const median = medianOf(learned.map((result) => result.daysToLearned as number));
  return [
    `${results.length} runs across lifters with 4, 5 and 6 exercises each.`,
    '',
    '| Seed source | Runs |',
    '| --- | --- |',
    ...rows,
    '',
    `Runs seeded from the lifter factor that went on to read \`learned\`: ${learned.length} of ${fromFactor.length}.`,
    `Median exercise-days to \`learned\` on those runs: ${median ?? 'n/a'}.`,
  ].join('\n');
}

/**
 * The number that decides between two arrivals and three: how often a lifter
 * who is still travelling turns anyway.
 */
function falseArrivalSection(result: FalseArrivalResult): string {
  const perRun = round(result.falseArrivalsPerRun, 2);
  const verdict =
    result.falseArrivalsPerRun >= ARRIVAL_MINIMUM
      ? `**${perRun} arrivals per run is at or above the minimum of ${ARRIVAL_MINIMUM}.** A lifter who has not reached their rest can therefore collect a full set of arrivals from noise alone, which is what these runs did: ${result.runsFalselyLearned} of ${result.runs} read \`learned\` while still more than two steps away. On this evidence the minimum is TOO LOW. Raising it, or tightening what counts as an arrival, is the change to test first.`
      : `**${perRun} arrivals per run is below the minimum of ${ARRIVAL_MINIMUM}**, so noise alone does not fill the quota, and the minimum could be tested at 2 to settle sooner.`;
  return [
    `${result.runs} compliant runs of ${result.days} exercise-days, seeded from the population default rather than near the lifter's rest. A run counts as FALSE here when it finished more than two steps from that rest — judged on the finish, so a run that arrived falsely and then converged is not counted, and the figures below are the conservative side of the truth.`,
    '',
    `- Arrivals per run: **${perRun}**.`,
    `- Runs with at least one false arrival: **${result.runsWithFalseArrival} of ${result.runs}**.`,
    `- Runs that reached \`learned\` while still more than two steps away: **${result.runsFalselyLearned} of ${result.runs}**.`,
    '',
    verdict,
    '',
    'This is the number the amendment (s.3.2) said must decide between two arrivals and three. It was an estimate there; it is measured here.',
  ].join('\n');
}

const ARRIVAL_MINIMUM = ADAPTIVE_REST_POLICY.learnedMinArrivals.value;

function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const REPLAY_INTRO = `Run over a plain file COPY of the store, opened read-only and deleted
afterwards. COUNTS ONLY: no load, no velocity, no date, no exercise, no per-key figure. A
count cannot leak a training history; a per-exercise row can.

This is the only part of the report that touches real data, and it says nothing about
whether the rest numbers are right. It answers one question: how much evidence would these
rules actually find in what has been recorded so far.`;

function countTable(title: string, counts: Readonly<Record<string, number>>): string {
  const rows = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `| \`${key}\` | ${n} |`);
  if (rows.length === 0) return `_No ${title.toLowerCase()}._`;
  return [`| ${title} | Count |`, '| --- | --- |', ...rows].join('\n');
}

function replaySection(replay: ReplayCounts): string {
  const thin = replay.tooThinToJudge
    ? [
        '',
        '> **Too thin to judge, and this is the finding.** The corpus does not hold enough valid',
        '> pairs for any of the numbers below to mean anything about the rules. The design',
        '> predicted it (s.10.4: most historical rows are test rows), and the honest thing is to',
        '> say so rather than read a trend into single digits. The exclusion table says which',
        '> gate the sets fell at, which is the actionable part.',
      ].join('\n')
    : '';
  return [
    REPLAY_INTRO,
    thin,
    '',
    `Store schema version ${replay.schemaVersion}, read at policy \`${replay.policyVersion}\`.`,
    '',
    '| Measure | Count |',
    '| --- | --- |',
    `| Sets in the store | ${replay.setsInStore} |`,
    `| Sets carrying reps | ${replay.setsUsable} |`,
    `| Exercise keys seen | ${replay.exerciseKeys} |`,
    `| Keys with enough exercise-days to evaluate | ${replay.keysWithEnoughHistory} |`,
    `| Exercise-days evaluated | ${replay.exerciseDaysEvaluated} |`,
    `| Candidate pairs | ${replay.candidatePairs} |`,
    `| Valid pairs | ${replay.validPairs} |`,
    `| Valid pairs inside the window | ${replay.pairsInWindow} |`,
    `| Valid pairs outside it (veto only) | ${replay.pairsOutOfWindow} |`,
    `| Keys reaching at least one arrival | ${replay.keysReachingAnArrival} |`,
    `| Keys that would read \`learned\` | ${replay.keysReadingLearned} |`,
    `| Steps down | ${replay.stepsByDirection.down} |`,
    `| Steps up | ${replay.stepsByDirection.up} |`,
    '',
    countTable('Why a set was never a pair candidate', replay.setsExcluded),
    '',
    countTable('Why a candidate pair was rejected', replay.rejectedPairs),
    '',
    countTable('Pair verdict', replay.pairsByVerdict),
    '',
    countTable('Exercise-day decision', replay.decisions),
  ].join('\n');
}

function gatesTable(gates: readonly Gate[]): string {
  const rows = gates.map((gate) => `| ${gate.name} | ${tick(gate.passed)} | ${gate.detail} |`);
  return ['| Ship gate | Verdict | Detail |', '| --- | --- | --- |', ...rows].join('\n');
}

const HEADER = `# VW-516: the adaptive-rest simulation

Generated by \`npm run sim:rest\` (\`scripts/sim/adaptive-rest-sim.ts\`). Every number below is
SYNTHETIC: it comes from a fitted model of a lifter, never from a recorded session. The
simulation imports the production rules from \`src/analytics/adaptive-rest.ts\` and
re-implements none of them, so a default changed in the module is the default these numbers
describe.

Seeded throughout. Re-running the command reproduces this file exactly.
`;

const STAGE1_INTRO = `## Stage 1: does the model reproduce published results?

Stage 2 means nothing until this passes. One model is fitted JOINTLY to all three baselines,
with the fatigue parameters shared.

**Baseline B is now a CALIBRATION, not a test.** Each of its two groups was given its own
spread parameter, because one shared spread cannot hold two groups whose published relative
spreads differ. That fix costs B its standing as evidence: it now has four published numbers
(two means, two spreads) and four free parameters (two time constants, two spreads), so it
can be made to fit and its fitting says nothing about whether the model is right.

**That leaves A and C as the only tests of the model.** Read the verdict that way: the
baseline-B rows below are the model being told what to do, and the baseline-A and baseline-C
rows are the model being asked.

Published values are quoted from \`2026-09-19-vw-445-adaptive-rest-research.md\` s.2.2 and
s.2.4. No paper was re-read. Three figures are this simulation's ASSUMPTIONS, not the
papers': the number of sets in baseline A, and the rep target and reps-to-failure in
baseline C.
`;

const STAGE2_INTRO = `## Stage 2: the staircase on simulated lifters

Each row is one lifter, one behaviour and one intent over 14 exercise-days. "True rest" is
the rest at which that lifter's expected recovery ratio just reaches the target, measured on
a noiseless copy of the same lifter by bisection: it is the number the staircase is hunting.
Errors are signed, in seconds, against the true rest clamped into the floor and ceiling.

"Under-recovered" means a pair whose recovery ratio fell more than the measurement CV (4.5
points) BELOW the target, not merely under it. A staircase that converges on the target
leaves about half its pairs a hair under it by construction, so counting those would hand the
comparison to any rest long enough to be wasteful.
`;

function stage1Section(stage1: SimulationReport['stage1']): string {
  return [
    STAGE1_INTRO,
    `**Stage 1 verdict: ${stage1.verdict.passed ? 'PASSED' : 'FAILED'}.**`,
    '',
    stage1Table(stage1.verdict),
    '',
    '### The fit',
    '',
    fitTable(stage1.fit),
    '',
    `Self-selected rests, set by set (baseline C): ${stage1.verdict.baselineCRests.join(', ')} s.`,
  ].join('\n');
}

const PROVISIONAL = `> **Stage 1 did not pass, so everything below it is PROVISIONAL.** The design's rule is that
> the model must reproduce the published baselines before its verdicts on the staircase mean
> anything, and this run does not clear every one of them. The stage 2 tables describe what
> the staircase does to THIS model of a lifter; they are not yet evidence about a real one.
> No engineering default may be moved on this result, and none was.
`;

export function renderMarkdown(report: SimulationReport): string {
  return [
    HEADER,
    report.stage1.verdict.passed ? '' : PROVISIONAL,
    stage1Section(report.stage1),
    '',
    STAGE2_INTRO,
    '### Opening velocity (intent `strength`)',
    '',
    stage2Table(report.stage2, 'strength'),
    '',
    '### Reps preserved (no stated intent)',
    '',
    stage2Table(report.stage2, 'none'),
    '',
    '### What the two tables say in one line',
    '',
    convergenceSummary(report.stage2),
    '',
    '## The lifter-factor seed, finally exercised',
    '',
    multiKeySection(report.multiKey),
    '',
    '## False arrivals: can noise alone fill the arrival quota?',
    '',
    falseArrivalSection(report.falseArrivals),
    '',
    ...(report.replay === null
      ? []
      : ['## Stage 3: the replay over recorded sets', '', replaySection(report.replay), '']),
    '## Ship gates (design s.10.3, as amended s.4)',
    '',
    gatesTable(report.gates),
    '',
    '## Recommendations',
    '',
    'Recommendations only. Nothing here was applied.',
    '',
    report.recommendations.map((line) => `- ${line}`).join('\n'),
    '',
    '## Defaults',
    '',
    report.defaultsMoved.length === 0
      ? 'No engineering default was moved by this run. Every number in `ADAPTIVE_REST_POLICY` is as the design set it.'
      : report.defaultsMoved.map((line) => `- ${line}`).join('\n'),
    '',
    `Policy version: \`${report.policyVersion}\`. The two recovery targets and the 15 s step are` +
      ' dose: the simulation may recommend moving them and may not move them.',
    '',
  ].join('\n');
}

export function policyVersion(): string {
  return ADAPTIVE_REST_POLICY.policyVersion;
}
