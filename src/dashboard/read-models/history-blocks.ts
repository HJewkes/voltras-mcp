// Dated blocks of a history, the gaps between them, and how each lift restarted (VW-558, S5a).
//
// Block edges are the boundaries the caller passes: for a logged history, the
// retro's meso boundaries with the human's marks on them. A `not_a_boundary`
// mark removes a boundary. A `planned_deload` mark keeps it, and it also
// bridges the gap for WA's `segmentWeeks`, because the run of training did not
// end there.
//
// Confidentiality: fitness metadata only — no protocol data (NF-07).

import {
  SEGMENT_RULE,
  buildLiftSeries,
  type LiftSeries,
  type ProgressionBlock,
} from '@voltras/workout-analytics';

import {
  addDays,
  daysBetween,
  evidenceOf,
  groupRows,
  historyTrainingDays,
  isoWeekStart,
  workRows,
  type HistoryEvidence,
  type HistorySetRow,
} from './history-rows.js';

export const BOUNDARY_CHOICES = [
  'planned_deload',
  'life_gap',
  'unplanned_drop',
  'not_a_boundary',
] as const;
export type BoundaryChoice = (typeof BOUNDARY_CHOICES)[number];

/** Choices under which the run of training went on across the gap. */
const BRIDGING: ReadonlySet<BoundaryChoice> = new Set(['planned_deload', 'not_a_boundary']);

/** One boundary: the Monday the new block starts, what fired it, and the human's mark. */
export interface HistoryBoundary {
  week: string;
  kinds: ('gap' | 'load_drop')[];
  gapDays: number | null;
  choice: BoundaryChoice | null;
}

export const HISTORY_BLOCK_CONSTANTS = {
  /** RP's 3:1 to 5:1: three to five accumulation weeks and a deload, four to six trained weeks. */
  withinMinWeeks: 4,
  withinMaxWeeks: 6,
  /** RP's margin of error: "one rep or 5 lb" reads as the same load. */
  sameLoadLbs: 5,
} as const;

export type BlockLength = 'short' | 'within 3:1 to 5:1' | 'long';
export type RestartKind = 'at or above final' | 'mid-meso' | 'at week 1 or below';

export interface HistoryBlockSpan {
  /** Monday of the block's first week. */
  start: string;
  /** Monday of the week after the block, exclusive. */
  nextStart: string;
}

export interface HistoryBlockView extends HistoryBlockSpan {
  index: number;
  calendarWeeks: number;
  trainedWeeks: number;
  firstDay: string | null;
  lastDay: string | null;
  /** The boundary that opened the block; `null` for the first. */
  openedBy: HistoryBoundary | null;
  /** The next block opens on a planned deload mark. */
  endsInDeload: boolean;
  length: BlockLength;
  evidence: HistoryEvidence | null;
}

/** A stretch with no training longer than the segment rule's break gap. */
export interface HistoryGapSpan {
  after: string;
  endsOn: string;
  days: number;
  /** The Monday training resumed in. */
  week: string;
  choice: BoundaryChoice | null;
  bridged: boolean;
}

export interface HistoryRestartRung {
  previousStart: string;
  start: string;
  /** Top load in each trained week of the previous block, in order. */
  previousLoads: number[];
  restartLoad: number;
  kind: RestartKind;
}

export interface HistoryBlocksView {
  blocks: HistoryBlockView[];
  gaps: HistoryGapSpan[];
  restarts: { lift: string; rungs: HistoryRestartRung[] }[];
  lengthBasis: string;
}

export interface HistoryBlocksInput {
  rows: readonly HistorySetRow[];
  boundaries: readonly HistoryBoundary[];
}

/** The weeks `segmentWeeks` must not end a run in. */
export function bridgedGapWeeks(boundaries: readonly HistoryBoundary[]): Set<string> {
  return new Set(
    boundaries.filter((b) => b.choice !== null && BRIDGING.has(b.choice)).map((b) => b.week),
  );
}

/** The blocks between the first training week, each kept boundary, and the week after the last day. */
export function blockSpans(
  days: readonly string[],
  boundaries: readonly HistoryBoundary[],
): HistoryBlockSpan[] {
  if (days.length === 0) return [];
  const first = isoWeekStart(days[0]!);
  const kept = boundaries.filter((b) => b.choice !== 'not_a_boundary' && b.week > first);
  const edges = [first, ...kept.map((b) => b.week).sort()];
  const ends = [...edges.slice(1), addDays(isoWeekStart(days.at(-1)!), 7)];
  return edges.map((start, index) => ({ start, nextStart: ends[index]! }));
}

/** Each trained block as a WA `ProgressionBlock`, first to last training day. */
export function progressionBlocks(view: HistoryBlocksView): ProgressionBlock[] {
  return view.blocks.flatMap((block) =>
    block.firstDay === null || block.lastDay === null
      ? []
      : [{ start: block.firstDay, end: block.lastDay }],
  );
}

export function blockLength(trainedWeeks: number): BlockLength {
  const { withinMinWeeks, withinMaxWeeks } = HISTORY_BLOCK_CONSTANTS;
  if (trainedWeeks < withinMinWeeks) return 'short';
  return trainedWeeks <= withinMaxWeeks ? 'within 3:1 to 5:1' : 'long';
}

export function restartKind(previousLoads: readonly number[], restartLoad: number): RestartKind {
  const { sameLoadLbs } = HISTORY_BLOCK_CONSTANTS;
  if (restartLoad >= previousLoads.at(-1)! - sameLoadLbs) return 'at or above final';
  if (restartLoad <= previousLoads[0]! + sameLoadLbs) return 'at week 1 or below';
  return 'mid-meso';
}

const inside = (day: string, span: HistoryBlockSpan) => day >= span.start && day < span.nextStart;

function blockView(
  span: HistoryBlockSpan,
  index: number,
  days: readonly string[],
  rows: readonly HistorySetRow[],
  boundaryAt: ReadonlyMap<string, HistoryBoundary>,
  next: HistoryBlockSpan | undefined,
): HistoryBlockView {
  const trainedDays = days.filter((day) => inside(day, span));
  const trainedWeeks = new Set(trainedDays.map(isoWeekStart)).size;
  return {
    index,
    ...span,
    calendarWeeks: daysBetween(span.start, span.nextStart) / 7,
    trainedWeeks,
    firstDay: trainedDays[0] ?? null,
    lastDay: trainedDays.at(-1) ?? null,
    openedBy: index === 0 ? null : (boundaryAt.get(span.start) ?? null),
    endsInDeload: next !== undefined && boundaryAt.get(next.start)?.choice === 'planned_deload',
    length: blockLength(trainedWeeks),
    evidence: evidenceOf(rows.filter((row) => inside(row.day, span))),
  };
}

function gapSpans(
  days: readonly string[],
  boundaryAt: ReadonlyMap<string, HistoryBoundary>,
): HistoryGapSpan[] {
  return days.slice(1).flatMap((endsOn, i): HistoryGapSpan[] => {
    const after = days[i]!;
    const gap = daysBetween(after, endsOn);
    if (gap <= SEGMENT_RULE.breakGapDays) return [];
    const week = isoWeekStart(endsOn);
    const choice = boundaryAt.get(week)?.choice ?? null;
    const bridged = choice !== null && BRIDGING.has(choice);
    return [{ after, endsOn, days: gap, week, choice, bridged }];
  });
}

/** Each mapped lift's top load per trained week. */
function weeklyTopLoads(rows: readonly HistorySetRow[]): Map<string, Map<string, number>> {
  const byLift = groupRows(
    rows.filter((row) => row.exerciseId !== null),
    (row) => row.exerciseId!,
  );
  return new Map(
    [...byLift].map(([lift, liftRows]) => {
      const weekly = new Map<string, number>();
      const sets = liftRows.flatMap((row) =>
        row.load === null || row.reps === null
          ? []
          : [{ day: row.day, load: row.load, reps: row.reps, sets: row.sets }],
      );
      for (const point of (buildLiftSeries(sets) as LiftSeries).points) {
        const week = isoWeekStart(point.day);
        weekly.set(week, Math.max(weekly.get(week) ?? 0, point.topLoad));
      }
      return [lift, weekly];
    }),
  );
}

function loadsIn(weekly: ReadonlyMap<string, number>, span: HistoryBlockSpan): number[] {
  return [...weekly]
    .filter(([week]) => inside(week, span))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, load]) => load);
}

/** Each block's first top load for a lift against the previous block's week-by-week loads. */
function restartLadder(
  weekly: ReadonlyMap<string, number>,
  spans: readonly HistoryBlockSpan[],
): HistoryRestartRung[] {
  return spans.slice(1).flatMap((span, i): HistoryRestartRung[] => {
    const previous = spans[i]!;
    const previousLoads = loadsIn(weekly, previous);
    const restartLoad = loadsIn(weekly, span)[0];
    if (previousLoads.length < 2 || restartLoad === undefined) return [];
    const kind = restartKind(previousLoads, restartLoad);
    return [{ previousStart: previous.start, start: span.start, previousLoads, restartLoad, kind }];
  });
}

const LENGTH_BASIS =
  "Trained weeks against RP's 3:1 to 5:1 (three to five accumulation weeks and a deload): " +
  'under 4 is short, 4 to 6 is within, over 6 is long.';

export function buildHistoryBlocksView(input: HistoryBlocksInput): HistoryBlocksView {
  const rows = workRows(input.rows);
  const days = historyTrainingDays(rows);
  const spans = blockSpans(days, input.boundaries);
  const boundaryAt = new Map(input.boundaries.map((b) => [b.week, b]));
  const restarts = [...weeklyTopLoads(rows)]
    .map(([lift, weekly]) => ({ lift, rungs: restartLadder(weekly, spans) }))
    .filter((entry) => entry.rungs.length > 0);
  return {
    blocks: spans.map((span, i) => blockView(span, i, days, rows, boundaryAt, spans[i + 1])),
    gaps: gapSpans(days, boundaryAt),
    restarts,
    lengthBasis: LENGTH_BASIS,
  };
}
