// The goal ramp sim (VW-510, VW-558 H4).
//
//   npm run sim:goal-ramp -- [--retro <retro-data.json>] [--tier intermediate]
//
// Part 1 reproduces today's one-slope `projectRate` numbers for the worked goals from an
// independent formula (and throws on a mismatch), then prints the two-slope numbers with the
// undated block length at 4, 5 and 6 weeks. Part 2, only with `--retro`, projects every restart
// in a retro-data file and compares each variant with the best load the lifter reached in the
// horizon. It prints percentages of the start load only, so no personal load leaves the file,
// and it writes nothing.

import { readFileSync } from 'node:fs';

import {
  deriveGoalBand,
  programmedRampStepLbs,
  type GoalBand,
  type GoalBandWeek,
  type GoalInfoLevel,
  type GoalLaterBlockRate,
  type RampClass,
} from '../../src/analytics/goal-band.js';
import { laterBlockRateOf } from '../../src/analytics/goal-class-rate.js';
import { horizonWeeksOf } from '../../src/analytics/goal-horizon.js';
import type { Tier } from '../../src/tools/tier-signal.js';

const MESO_CHOICES = [4, 5, 6] as const;
const RETRO_HORIZON_WEEKS = 12;
const DAY_MS = 86_400_000;

interface WorkedGoal {
  name: string;
  startValue: number;
  tier: Tier;
  rampClass: RampClass;
  horizonWeeks: number;
  infoLevel: Exclude<GoalInfoLevel, 'own'>;
  /** Dated blocks' deload flags; absent means no plan tree (the undated fallback). */
  dated?: boolean[][];
}

const FOUR_WEEKS = [false, false, false, false];

const WORKED_GOALS: WorkedGoal[] = [
  goal('100 lb beginner chest press, 12 wk, no plan', 100, 'beginner', 'upper_compound', 12),
  {
    ...goal(
      '100 lb beginner chest press, three dated 4-wk blocks',
      100,
      'beginner',
      'upper_compound',
      12,
    ),
    dated: [FOUR_WEEKS, FOUR_WEEKS, FOUR_WEEKS],
  },
  {
    ...goal('100 lb beginner chest press, 12 wk, cold', 100, 'beginner', 'upper_compound', 12),
    infoLevel: 'cold',
  },
  goal('200 lb intermediate row, 12 wk, no plan', 200, 'intermediate', 'upper_compound', 12),
  goal('135 lb intermediate squat, 12 wk, no plan', 135, 'intermediate', 'lower_compound', 12),
  goal('40 lb beginner triceps extension, 8 wk, no plan', 40, 'beginner', 'isolation', 8),
];

function goal(
  name: string,
  startValue: number,
  tier: Tier,
  rampClass: RampClass,
  horizonWeeks: number,
): WorkedGoal {
  return { name, startValue, tier, rampClass, horizonWeeks, infoLevel: 'ramp' };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function bandFor(
  subject: Pick<WorkedGoal, 'startValue' | 'tier' | 'rampClass' | 'infoLevel'>,
  weeks: GoalBandWeek[],
  laterBlockPctPerWeek?: GoalLaterBlockRate,
): GoalBand {
  return deriveGoalBand({
    metric: 'top_load_at_reps',
    startValue: subject.startValue,
    horizonWeeks: weeks.length,
    weeks,
    tier: subject.tier,
    rampClass: subject.rampClass,
    infoLevel: subject.infoLevel,
    dietState: { phase: 'maintenance', weeksInPhase: 4 },
    layoff: false,
    matchedSessionCount: 4,
    baselineState: 'PROVISIONAL',
    completedMesoCount: 0,
    ...(laterBlockPctPerWeek === undefined ? {} : { laterBlockPctPerWeek }),
  });
}

/** Today's one-slope band, checked against the plain formula: start plus one step per ramping week. */
function todayBand(subject: WorkedGoal, weeks: GoalBandWeek[]): GoalBand {
  const oneBlock = weeks.map(({ index, isDeload }) => ({ index, isDeload }));
  const band = bandFor(subject, oneBlock);
  const ramping = oneBlock.filter((week, position) => position > 0 && !week.isDeload).length;
  const step = programmedRampStepLbs(subject.startValue, subject.rampClass, subject.tier);
  const expected = round2(subject.startValue + ramping * step);
  if (round2(band.stretchValue) !== expected) {
    throw new Error(`parity: ${subject.name} stretch ${band.stretchValue}, formula ${expected}`);
  }
  return band;
}

function workedGoalRow(subject: WorkedGoal): string {
  const cells = MESO_CHOICES.map((meso) => {
    const band = bandFor(subject, horizonWeeksOf(subject.dated ?? [], subject.horizonWeeks, meso));
    return pair(band);
  });
  const today = todayBand(subject, horizonWeeksOf(subject.dated ?? [], subject.horizonWeeks));
  return `| ${subject.name} | ${pair(today)} | ${cells.join(' | ')} |`;
}

function pair(band: GoalBand): string {
  return `${round2(band.committedValue)} / ${round2(band.stretchValue)}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function printWorkedGoals(): void {
  console.log('## Worked goals: committed / stretch (lb)\n');
  console.log('| goal | today (one slope) | two slopes, 4-wk undated | 5-wk | 6-wk |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const subject of WORKED_GOALS) console.log(workedGoalRow(subject));
  console.log(
    '\nDated rows ignore the undated length. Later blocks ramp at half the class step (ENGINEERING DEFAULT).\n',
  );
}

// ---------------------------------------------------------------------------------------------
// Part 2: the retro restarts.

interface RetroSession {
  date: string;
  topLoad: number;
  topLoadAtModalReps: number | null;
}
interface RetroLift {
  lift: string;
  family: string;
  sessions: RetroSession[];
}
interface RetroMeso {
  start: string;
  nextStart: string | null;
  calendarWeeks: number;
}
interface RetroRestart {
  lift: string;
  start: string;
  restartLoad: number;
}
interface RetroData {
  lifts: RetroLift[];
  mesos: RetroMeso[];
  mesoChecks: { restarts: RetroRestart[] };
}

const LOWER_FAMILIES = new Set(['squat', 'deadlift']);

function classOfFamily(family: string): RampClass {
  return LOWER_FAMILIES.has(family) ? 'lower_compound' : 'upper_compound';
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The retro's own mesos from the restart on, as dated blocks of `calendarWeeks` weeks. */
function datedBlocksFrom(data: RetroData, start: string): boolean[][] {
  return data.mesos
    .filter((meso) => meso.start >= start)
    .map((meso) => Array.from({ length: meso.calendarWeeks }, () => false));
}

/** The class rate measured only from history before the restart, so nothing looks ahead. */
function measuredRateBefore(
  data: RetroData,
  restart: RetroRestart,
  tier: Tier,
): GoalLaterBlockRate {
  const byLift = new Map(data.lifts.map((lift) => [lift.lift, lift]));
  const blocks = data.mesos
    .filter((meso) => meso.nextStart !== null && meso.nextStart <= restart.start)
    .map((meso) => ({ start: meso.start, end: addDays(meso.nextStart!, -1) }));
  const series = data.lifts.map((lift) => ({
    lift: lift.lift,
    points: lift.sessions
      .filter((session) => session.date < restart.start)
      .map((session) => ({ day: session.date, value: session.topLoadAtModalReps })),
  }));
  const family = byLift.get(restart.lift)?.family ?? '';
  return laterBlockRateOf({
    series,
    blocks,
    classOf: (lift) => classOfFamily(byLift.get(lift)?.family ?? ''),
    rampClass: classOfFamily(family),
    tier,
  });
}

/** The heaviest top load inside the horizon, or `null` when the lift was not trained in it. */
function bestInHorizon(lift: RetroLift, start: string): number | null {
  const end = addDays(start, 7 * RETRO_HORIZON_WEEKS);
  const loads = lift.sessions
    .filter((session) => session.date >= start && session.date < end)
    .map((session) => session.topLoad);
  return loads.length === 0 ? null : Math.max(...loads);
}

type Variant = { name: string; band: (restart: RetroRestart, subject: WorkedGoal) => GoalBand };

function retroVariants(data: RetroData, tier: Tier): Variant[] {
  const undated = (meso: number): Variant => ({
    name: `two slopes, undated ${meso}-wk blocks`,
    band: (_r, subject) => bandFor(subject, horizonWeeksOf([], RETRO_HORIZON_WEEKS, meso)),
  });
  const dated = (r: RetroRestart) =>
    horizonWeeksOf(datedBlocksFrom(data, r.start), RETRO_HORIZON_WEEKS);
  return [
    {
      name: 'today (one slope)',
      band: (_r, subject) => todayBand(subject, horizonWeeksOf([], RETRO_HORIZON_WEEKS)),
    },
    ...MESO_CHOICES.map(undated),
    {
      name: 'two slopes, retro mesos, default rate',
      band: (r, subject) => bandFor(subject, dated(r)),
    },
    {
      name: 'two slopes, retro mesos, measured rate',
      band: (r, subject) => bandFor(subject, dated(r), measuredRateBefore(data, r, tier)),
    },
  ];
}

interface Outcome {
  stretchOver: number;
  committedOver: number;
  stretchMissPct: number[];
  committedMissPct: number[];
}

function scoreVariant(data: RetroData, variant: Variant, tier: Tier): Outcome & { n: number } {
  const out: Outcome = {
    stretchOver: 0,
    committedOver: 0,
    stretchMissPct: [],
    committedMissPct: [],
  };
  let n = 0;
  for (const restart of data.mesoChecks.restarts) {
    const lift = data.lifts.find((candidate) => candidate.lift === restart.lift);
    const best = lift === undefined ? null : bestInHorizon(lift, restart.start);
    if (lift === undefined || best === null || restart.restartLoad <= 0) continue;
    const subject = {
      ...goal(
        restart.lift,
        restart.restartLoad,
        tier,
        classOfFamily(lift.family),
        RETRO_HORIZON_WEEKS,
      ),
    };
    const band = variant.band(restart, subject);
    n += 1;
    if (band.stretchValue > best) out.stretchOver += 1;
    if (band.committedValue > best) out.committedOver += 1;
    out.stretchMissPct.push(((band.stretchValue - best) / restart.restartLoad) * 100);
    out.committedMissPct.push(((band.committedValue - best) / restart.restartLoad) * 100);
  }
  return { ...out, n };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function printRetro(path: string, tier: Tier): void {
  const data = JSON.parse(readFileSync(path, 'utf8')) as RetroData;
  console.log(`## Retro restarts, ${RETRO_HORIZON_WEEKS}-week goals at the ${tier} tier\n`);
  console.log(
    'Percent of the restart load; positive means the projection sat above the best load reached.\n',
  );
  console.log(
    '| variant | n | committed over best | median committed - best | stretch over best | median stretch - best |',
  );
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const variant of retroVariants(data, tier)) {
    const s = scoreVariant(data, variant, tier);
    console.log(
      `| ${variant.name} | ${s.n} | ${s.committedOver} | ${round2(median(s.committedMissPct))}% | ` +
        `${s.stretchOver} | ${round2(median(s.stretchMissPct))}% |`,
    );
  }
}

printWorkedGoals();
const retro = argument('retro');
if (retro !== undefined) printRetro(retro, (argument('tier') ?? 'intermediate') as Tier);
