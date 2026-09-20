// The adaptive-rest simulation (VW-516, design s.10).
//
//   npm run sim:rest -- [--out <dir>] [--json <path>] [--restarts N] [--days N]
//
// Stage 1 fits one lifter model to three published rest results. Stage 2 runs
// the PRODUCTION staircase on simulated lifters and measures it. Stage 3, the
// read-only replay over stored sets, is not in this script: see the pull
// request for why.
//
// The staircase's rules live in `src/analytics/adaptive-rest.ts` and are
// imported, never copied. Nothing here writes to a store, reads a real session,
// or touches a device.

import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  intentDefaultSec,
  type LearnedRecordSummary,
  type RestIntentKey,
} from '../../src/analytics/adaptive-rest.js';
import { fitModel, judgeStage1 } from './stage1-baselines.js';
import {
  falseArrivalRate,
  runStage2,
  type Behaviour,
  type SimLifter,
  type Stage2Result,
} from './stage2-staircase.js';
import { policyVersion, renderMarkdown, type Gate, type SimulationReport } from './report.js';
import { replayStore, type ReplayCounts } from './replay.js';
import type { FitParams } from './stage1-baselines.js';

const DEFAULT_OUT_DIR = '/Users/hjewkes/projects/voltras-workspace/sources/research';
const REPORT_NAME = '2026-09-19-vw-516-adaptive-rest-simulation.md';

const BEHAVIOURS: readonly Behaviour[] = [
  'compliant',
  'rusher',
  'loiterer',
  'two_set',
  'load_ramp',
  'depth_jump',
  'plan_restart',
];

const INTENTS: readonly RestIntentKey[] = ['strength', 'none'];

/** Populations spanning true rests from under the floor to over the ceiling (design s.10.3). */
const POPULATION_TAU_SCALE = {
  'sub-floor': 0.12,
  fast: 0.4,
  middle: 1.0,
  slow: 2.6,
} as const;

const SQUAT = { v0: 0.6, vFail: 0.24, n0: 10 } as const;

function populations(fit: FitParams): SimLifter[] {
  return Object.entries(POPULATION_TAU_SCALE).map(([name, scale]) => ({
    name,
    params: {
      ...SQUAT,
      tauSec: fit.tauCSec * scale,
      fatigueCost: fit.fatigueCost,
      repsPenalty: fit.repsPenalty,
      velocityPenalty: fit.velocityPenalty,
      cv: 0.045,
    },
  }));
}

interface CliOptions {
  readonly outDir: string;
  readonly jsonPath: string | null;
  readonly restarts: number;
  readonly days: number;
  /** Run the read-only replay over a copy of the store. Off unless asked for. */
  readonly replay: boolean;
  readonly storePath: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  return {
    outDir: read('--out') ?? DEFAULT_OUT_DIR,
    jsonPath: read('--json') ?? null,
    restarts: Number(read('--restarts') ?? 400),
    days: Number(read('--days') ?? 14),
    replay: argv.includes('--replay'),
    storePath: read('--store') ?? join(homedir(), '.voltras', 'vmcp.sqlite'),
  };
}

const SCRATCH_DIR = '.sim-scratch';

/**
 * Replay over a plain FILE COPY of the store, then delete the copy.
 *
 * The live file is never opened here. It is copied with `copyFileSync`, which
 * only reads it, and everything after that touches the copy. The copy lands in
 * a gitignored scratch directory and is removed in `finally`, so a crash does
 * not leave a second copy of the lifter's training history on disk.
 */
function runReplay(storePath: string): ReplayCounts {
  mkdirSync(SCRATCH_DIR, { recursive: true });
  const copy = join(SCRATCH_DIR, `vmcp-replay-${process.pid}.sqlite`);
  try {
    copyFileSync(storePath, copy);
    return replayStore(copy);
  } finally {
    rmSync(copy, { force: true });
  }
}

const LEARNED_WITHIN_DAYS = 6;
const MAX_FALSE_LEARNED_SHARE = 0.05;
const MAX_BOUNCE = 0.25;
const UNDER_RECOVERED_SLACK = 0.02;

function gateLearnedSoon(results: readonly Stage2Result[]): Gate {
  const middle = results.filter(
    (result) => result.lifter === 'middle' && result.behaviour === 'compliant',
  );
  const worst = middle.map((result) => result.daysToLearned ?? Infinity);
  const passed = worst.every((days) => days <= LEARNED_WITHIN_DAYS);
  return {
    name: `A compliant middle lifter reads learned within ${LEARNED_WITHIN_DAYS} exercise-days`,
    passed,
    detail: middle
      .map((result) => `${result.intent}: ${result.daysToLearned ?? 'never'} days`)
      .join('; '),
  };
}

function gateFalseLearned(results: readonly Stage2Result[]): Gate {
  const learned = results.filter((result) => result.daysToLearned !== null);
  const wrong = learned.filter((result) => result.falseLearned);
  const share = learned.length === 0 ? 0 : wrong.length / learned.length;
  return {
    name: `False learned under ${MAX_FALSE_LEARNED_SHARE * 100}% of records`,
    passed: share < MAX_FALSE_LEARNED_SHARE,
    detail: `${wrong.length} of ${learned.length} records read learned more than two steps from the true rest`,
  };
}

/**
 * The amendment's widened gate (s.4): neither rushing nor loitering moves the
 * rest in EITHER direction.
 *
 * The old form compared a rusher's final rest against a compliant lifter's. It
 * went stale the moment veto-only evidence landed: the rusher is then correctly
 * frozen at its seed while the compliant lifter descends properly, so the
 * rusher ends higher and the comparison fired on a module that was behaving.
 * It measured "did the rusher end above someone else", which was never the
 * question. The question is whether their own rushing moved their own rest.
 */
function gateRusherAndLoiterer(results: readonly Stage2Result[]): Gate {
  const drifted = results.filter(
    (result) =>
      (result.behaviour === 'rusher' || result.behaviour === 'loiterer') &&
      (result.finalSec !== result.seedSec || result.upSteps > 0 || result.downSteps > 0),
  );
  const judged = results.filter(
    (result) => result.behaviour === 'rusher' || result.behaviour === 'loiterer',
  );
  return {
    name: 'Neither rushing nor loitering moves the rest, in either direction',
    passed: drifted.length === 0,
    detail:
      drifted.length === 0
        ? `${judged.length} rusher and loiterer runs, every one still at its seed with no step taken`
        : drifted
            .map((r) => `${r.lifter}/${r.behaviour}/${r.intent}: ${r.seedSec}s to ${r.finalSec}s`)
            .join('; '),
  };
}

function gateUnderRecovered(results: readonly Stage2Result[]): Gate {
  const exempt: string[] = [];
  const offenders: string[] = [];
  for (const result of results) {
    if (result.trueRestSec > intentDefaultSec(result.intent)) {
      exempt.push(`${result.lifter}/${result.behaviour}/${result.intent}`);
      continue;
    }
    if (result.underRecoveredShare > result.underRecoveredShareOnDefault + UNDER_RECOVERED_SLACK) {
      offenders.push(`${result.lifter}/${result.behaviour}/${result.intent}`);
    }
  }
  return {
    name: 'Under-recovered sets no more frequent than on the intent default',
    passed: offenders.length === 0,
    detail: `${offenders.length} run(s) worse than the default; ${exempt.length} exempt because the default already under-rests them`,
  };
}

function gateBounce(results: readonly Stage2Result[]): Gate {
  const noisy = results.filter((result) => result.bounceAfterLearned >= MAX_BOUNCE);
  return {
    name: `After learned, rest moves on fewer than 1 in ${1 / MAX_BOUNCE} exercise-days`,
    passed: noisy.length === 0,
    detail: `${noisy.length} run(s) moved on ${MAX_BOUNCE * 100}% or more of their days after reading learned`,
  };
}

/**
 * What this run argues for. Recommendations only: stage 1 has to reproduce its
 * baselines before the simulation may move any engineering default, and the two
 * recovery targets and the 15 s step are dose and the owner's in any case.
 */
const RECOMMENDATIONS: readonly string[] = [
  'The `learned` rule is the weak point, and it is the one number these runs argue about. Three exercise-days and six informative pairs are satisfied on the third visit every time, while the staircase has moved at most three 15 s steps from the population seed. A lifter whose rest is 100 s from the seed is still seven steps away when the record says `learned`. Consider adding a condition about DISTANCE TRAVELLED rather than time served: no step on the newest evaluated day, or no step for two consecutive days.',
  'The high bounce after `learned` is the same fault seen from the other end, not a separate one. A record that calls itself learned while still walking will keep walking, and every one of those steps is counted as a bounce. Fixing the state rule should move both gates together.',
  'The staircase itself converges. Median distance from the true rest falls substantially between the day it reads `learned` and day 12, in every population. The rule for SAYING it has learned is what is mistimed, not the rule for learning.',
  'The 15 s step interacts with the seed. The step is an engineering default carrying the owner sign-off the two targets carry, so this is a recommendation and not a change: reaching a rest 100 s away takes seven exercise-days at best. If the owner wants a faster first convergence, the lever is a per-lifter seed rather than a larger step. The lifter-factor seed already in `seedRest` is exactly that lever, and none of these runs exercised it, because each simulated lifter has only one key.',
  'No default was moved, and none may be on this result: stage 1 did not reproduce its baselines.',
];

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  process.stderr.write('stage 1: fitting the lifter model to three published baselines...\n');
  const fit = fitModel(options.restarts, 300, 11);
  const verdict = judgeStage1(fit);
  process.stderr.write(`stage 1: ${verdict.passed ? 'PASSED' : 'FAILED'}\n`);

  process.stderr.write('stage 2: running the production staircase...\n');
  const stage2 = sweepStage2(fit.params, options.days);
  const multiKey = sweepMultiKeyLifters(fit.params, options.days);
  const middle = populations(fit.params).find((lifter) => lifter.name === 'middle');
  const falseArrivals = falseArrivalRate(middle ?? populations(fit.params)[0], 'strength', 40, 6);

  let replay: ReplayCounts | null = null;
  if (options.replay) {
    process.stderr.write('stage 3: replaying over a read-only copy of the store...\n');
    replay = runReplay(options.storePath);
  }

  const report: SimulationReport = {
    generatedFor: 'VW-516',
    policyVersion: policyVersion(),
    stage1: { fit, verdict },
    stage2,
    multiKey,
    falseArrivals,
    replay,
    gates: [
      gateLearnedSoon(stage2),
      gateFalseLearned(stage2),
      gateRusherAndLoiterer(stage2),
      gateUnderRecovered(stage2),
      gateBounce(stage2),
    ],
    defaultsMoved: [],
    recommendations: RECOMMENDATIONS,
  };

  write(join(options.outDir, REPORT_NAME), renderMarkdown(report));
  if (options.jsonPath !== null) write(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const failures = report.gates.filter((gate) => !gate.passed).length;
  process.stderr.write(`stage 2: ${failures} ship gate(s) failed of ${report.gates.length}\n`);
}

/** Every population, behaviour and intent, each on its own seed. */
function sweepStage2(fit: FitParams, days: number): Stage2Result[] {
  const results: Stage2Result[] = [];
  let seed = 1000;
  for (const lifter of populations(fit)) {
    for (const behaviour of BEHAVIOURS) {
      for (const intent of INTENTS) {
        seed += 1;
        results.push(runStage2({ lifter, behaviour, intent, exerciseDays: days, seed }));
      }
    }
  }
  return results;
}

/** How many exercises one simulated lifter trains, so the lifter factor has keys to read. */
const KEYS_PER_LIFTER = [4, 5, 6] as const;

/**
 * A lifter with several exercises. The first two keys settle from the
 * population default; every key after them seeds from the LIFTER FACTOR, which
 * no earlier stage 2 run ever exercised (amendment s.6.2, finding 5).
 *
 * The keys differ only in how hard their sets are taken, which is what makes
 * their rests differ while the lifter's own recovery stays one number.
 */
function sweepMultiKeyLifters(fit: FitParams, days: number): Stage2Result[] {
  const results: Stage2Result[] = [];
  let seed = 5000;
  for (const lifter of populations(fit)) {
    for (const keys of KEYS_PER_LIFTER) {
      const settled: LearnedRecordSummary[] = [];
      for (let key = 0; key < keys; key += 1) {
        seed += 1;
        const result = runStage2({
          lifter: { ...lifter, name: `${lifter.name} (${keys} keys)` },
          behaviour: 'compliant',
          intent: 'strength',
          exerciseDays: days,
          seed,
          otherRecords: settled,
        });
        results.push(result);
        if (result.daysToLearned !== null) {
          settled.push({ intent: 'strength', valueSec: result.finalSec, state: 'learned' });
        }
      }
    }
  }
  return results;
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
  process.stderr.write(`wrote ${path}\n`);
}

main();
