// Regular and broken training weeks (VW-548): which weeks a check can read as steady training.

import { trainingGaps } from '../../../src/analytics/training-days.js';

import { isoWeekStart } from './dates.js';
import { isReportedSet } from './log-rules.js';
import type { SetRecord } from './types.js';
import { modalWeeklyCount, sessionsPerWeek } from './weekly.js';

export const SEGMENT_RULE = {
  /** A gap between training days longer than this ends a run, unless the human kept it inside. */
  breakGapDays: 10,
  minRunWeeks: 3,
  /** A regular week holds at least the modal weekly session count minus this. */
  frequencySlack: 1,
  minReportedExercises: 3,
  tailWeeks: 2,
  /** The first trained week after a gap longer than this is a re-entry week, whatever the mark. */
  longGapDays: 21,
} as const;

/** In precedence order: a week's first reason is the one the page colours it by. */
export const BREAK_REASONS = [
  'tail',
  'gap_edge',
  'short_run',
  'low_frequency',
  'sparse_logging',
] as const;
export type BreakReason = (typeof BREAK_REASONS)[number];

/** `unplanned_drop`: a real boundary the human saw as a load drop, neither a deload nor a gap. */
export const BOUNDARY_CHOICES = [
  'planned_deload',
  'life_gap',
  'unplanned_drop',
  'not_a_boundary',
] as const;
export type BoundaryChoice = (typeof BOUNDARY_CHOICES)[number];

/** One row of the human's `boundary-decisions.json`, written by the page's section 5. */
export interface BoundaryDecision {
  week: string;
  choice: BoundaryChoice | null;
  note?: string;
}

function isDecision(entry: unknown): entry is BoundaryDecision {
  if (entry === null || typeof entry !== 'object') return false;
  const { week, choice } = entry as { week?: unknown; choice?: unknown };
  const knownChoice = choice === null || BOUNDARY_CHOICES.includes(choice as BoundaryChoice);
  return typeof week === 'string' && knownChoice;
}

/** The page's decisions file; an unknown choice fails loudly rather than reading as unmarked. */
export function parseBoundaryDecisions(json: unknown): BoundaryDecision[] {
  if (!Array.isArray(json))
    throw new Error('boundary decisions: expected an array of { week, choice, note }');
  const bad = json.find((entry) => !isDecision(entry));
  if (bad !== undefined)
    throw new Error(
      `boundary decisions: unknown entry ${JSON.stringify(bad)}; choice is one of ${BOUNDARY_CHOICES.join(', ')} or null`,
    );
  return json as BoundaryDecision[];
}

/** Choices that keep a run going across a long gap: the block did not end there. */
const BRIDGING: readonly BoundaryChoice[] = ['planned_deload', 'not_a_boundary'];

export type WeekLabel = 'regular' | 'broken' | 'untrained';

export interface LabelledWeek {
  week: string;
  sessions: number;
  /** Distinct exercises with at least one set the lifter wrote out. */
  reportedExercises: number;
  /** Index into `runs`, or `null` for a week with no training. */
  run: number | null;
  label: WeekLabel;
  reasons: BreakReason[];
}

export interface Run {
  firstWeek: string;
  lastWeek: string;
  trainedWeeks: number;
}

export interface LongGap {
  /** The week training resumed in. */
  week: string;
  days: number;
  choice: BoundaryChoice | null;
  breaksRun: boolean;
}

export interface Segmentation {
  modalSessionsPerWeek: number | null;
  weeks: LabelledWeek[];
  runs: Run[];
  gaps: LongGap[];
}

/** Distinct exercises per week with a written-out set: separates set-by-set logging from one load line. */
export function reportedExercisesByWeek(rows: readonly SetRecord[]): Map<string, number> {
  const names = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!isReportedSet(row)) continue;
    const week = isoWeekStart(row.workout_due_date!);
    names.set(week, (names.get(week) ?? new Set()).add(row.exercise_name ?? ''));
  }
  return new Map([...names].map(([week, set]) => [week, set.size]));
}

/** Gaps over the break length, each read against the human's mark for the week training resumed. */
export function longGaps(
  days: readonly string[],
  decisions: readonly BoundaryDecision[] | null,
): LongGap[] {
  const choices = new Map((decisions ?? []).map((d) => [d.week, d.choice]));
  return trainingGaps(days)
    .filter((gap) => gap.days > SEGMENT_RULE.breakGapDays)
    .map((gap) => {
      const week = isoWeekStart(gap.endsOn);
      const choice = choices.get(week) ?? null;
      return {
        week,
        days: gap.days,
        choice,
        breaksRun: !(choice !== null && BRIDGING.includes(choice)),
      };
    });
}

/** Trained weeks grouped into runs, a new run starting at each week a breaking gap ends in. */
function runsOf(trained: readonly string[], breakWeeks: ReadonlySet<string>): string[][] {
  const runs: string[][] = [];
  for (const week of trained) {
    if (runs.length === 0 || breakWeeks.has(week)) runs.push([]);
    runs.at(-1)!.push(week);
  }
  return runs;
}

interface WeekFacts {
  sessions: number;
  reportedExercises: number;
  /** Weeks in this week's run that pass the frequency and logging tests. */
  runSteadyWeeks: number;
  floor: number | null;
  tail: boolean;
  gapEdge: boolean;
}

function frequentEnough(sessions: number, floor: number | null): boolean {
  return floor === null || sessions >= floor;
}

export function reasonsFor(facts: WeekFacts): BreakReason[] {
  const checks: Record<BreakReason, boolean> = {
    tail: facts.tail,
    gap_edge: facts.gapEdge,
    short_run: facts.runSteadyWeeks < SEGMENT_RULE.minRunWeeks,
    low_frequency: !frequentEnough(facts.sessions, facts.floor),
    sparse_logging: facts.reportedExercises < SEGMENT_RULE.minReportedExercises,
  };
  return BREAK_REASONS.filter((reason) => checks[reason]);
}

function runJson(weeks: readonly string[]): Run {
  return { firstWeek: weeks[0]!, lastWeek: weeks.at(-1)!, trainedWeeks: weeks.length };
}

interface RunContext {
  steadyPerRun: readonly number[];
  runIndex: ReadonlyMap<string, number>;
  floor: number | null;
  tail: ReadonlySet<string>;
  edges: ReadonlySet<string>;
}

function labelWeek(week: string, sessions: number, reportedExercises: number, rc: RunContext) {
  const run = rc.runIndex.get(week) ?? null;
  const base = { week, sessions, reportedExercises, run };
  if (run === null) return { ...base, label: 'untrained' as const, reasons: [] };
  const reasons = reasonsFor({
    sessions,
    reportedExercises,
    runSteadyWeeks: rc.steadyPerRun[run]!,
    floor: rc.floor,
    tail: rc.tail.has(week),
    gapEdge: rc.edges.has(week),
  });
  return { ...base, label: reasons.length ? ('broken' as const) : ('regular' as const), reasons };
}

/** Every calendar week from the first training day to the last, labelled by the rule. */
export function segmentWeeks(
  days: readonly string[],
  reported: ReadonlyMap<string, number>,
  decisions: readonly BoundaryDecision[] | null,
): Segmentation {
  const perWeek = sessionsPerWeek(days);
  const modal = modalWeeklyCount(perWeek.values());
  const gaps = longGaps(days, decisions);
  const trained = [...perWeek].filter(([, n]) => n > 0).map(([week]) => week);
  const runs = runsOf(trained, new Set(gaps.filter((g) => g.breaksRun).map((g) => g.week)));
  const floor = modal === null ? null : modal - SEGMENT_RULE.frequencySlack;
  const steady = (week: string) =>
    frequentEnough(perWeek.get(week)!, floor) &&
    (reported.get(week) ?? 0) >= SEGMENT_RULE.minReportedExercises;
  const rc: RunContext = {
    steadyPerRun: runs.map((run) => run.filter(steady).length),
    runIndex: new Map(runs.flatMap((run, i) => run.map((week) => [week, i] as const))),
    floor,
    tail: new Set(trained.slice(-SEGMENT_RULE.tailWeeks)),
    edges: new Set(gaps.filter((g) => g.days > SEGMENT_RULE.longGapDays).map((g) => g.week)),
  };
  const weeks = [...perWeek].map(
    ([week, sessions]): LabelledWeek => labelWeek(week, sessions, reported.get(week) ?? 0, rc),
  );
  return { modalSessionsPerWeek: modal, weeks, runs: runs.map(runJson), gaps };
}

export function regularWeeks(segmentation: Segmentation): Set<string> {
  return new Set(segmentation.weeks.filter((w) => w.label === 'regular').map((w) => w.week));
}

/** The rule in one paragraph, from the constants, for the report and the page. */
export function ruleText(modal: number | null): string {
  const r = SEGMENT_RULE;
  const floor = modal === null ? 'the modal weekly count' : `${modal - r.frequencySlack}`;
  return (
    `A trained week holds at least one training day. A run is a stretch of trained weeks with no gap between training days longer than ${r.breakGapDays} days; ` +
    `a gap the human marked a planned deload or not a boundary stays inside the run, and any other mark (a life gap or an unplanned drop) or no mark ends it. ` +
    `A trained week is steady when it holds at least ${floor} sessions (the modal ${modal ?? 'n/a'} minus ${r.frequencySlack}) ` +
    `and at least ${r.minReportedExercises} of its exercises carry a set the lifter wrote out rather than one load line the parser filled from the prescription. ` +
    `A week is regular when it is steady and its run holds at least ${r.minRunWeeks} steady weeks. ` +
    `Every other trained week is broken, with each reason that applies: low_frequency, sparse_logging, short_run (fewer than ${r.minRunWeeks} steady weeks in the run), tail (the last ${r.tailWeeks} trained weeks of the log) ` +
    `and gap_edge (the first trained week after a gap longer than ${r.longGapDays} days, however it was marked). A session takes its week's label.`
  );
}
