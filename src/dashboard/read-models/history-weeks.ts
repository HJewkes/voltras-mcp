// Every calendar week of a history, labelled regular, broken or untrained (VW-558, S5a).
//
// The labelling is WA's `segmentWeeks`; this module only feeds it days and
// per-week facts, and grades each week's evidence. A logged history uses WA's
// `SEGMENT_RULE` (ENGINEERING DEFAULT, tuned on one coached log). Live
// sessions log every set, so their rule switches `sparseLogging` off (D10).
//
// Confidentiality: fitness metadata only — no protocol data (NF-07).

import {
  SEGMENT_RULE,
  segmentWeeks,
  type LabelledWeek,
  type LongGap,
  type SegmentRule,
  type TrainingRun,
  type WeekSegmentation,
} from '@voltras/workout-analytics';

import {
  evidenceOf,
  groupRows,
  historyTrainingDays,
  isoWeekStart,
  workRows,
  type HistoryEvidence,
  type HistorySetRow,
} from './history-rows.js';

export type HistorySource = 'history' | 'live';

/** Live sessions log every set, so a week with few written-out exercises is not broken (D10). */
export const LIVE_SEGMENT_RULE: Readonly<SegmentRule> = { ...SEGMENT_RULE, sparseLogging: false };

export interface HistoryWeeksInput {
  rows: readonly HistorySetRow[];
  source: HistorySource;
  /** Weeks where a long gap ends but the run did not: see `bridgedGapWeeks` in history-blocks. */
  bridgedGapWeeks?: ReadonlySet<string>;
}

export interface HistoryWeekView extends LabelledWeek {
  /** Work sets in the week, unmapped exercises included. */
  sets: number;
  /** `null` for an untrained week. */
  evidence: HistoryEvidence | null;
}

export interface HistoryWeeksView {
  source: HistorySource;
  rule: SegmentRule;
  ruleBasis: 'ENGINEERING DEFAULT';
  modalSessionsPerWeek: number | null;
  weeks: HistoryWeekView[];
  runs: TrainingRun[];
  gaps: LongGap[];
}

/** Distinct exercises per week with a set the lifter wrote out. */
function reportedExercisesByWeek(rows: readonly HistorySetRow[]): Map<string, number> {
  const names = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.writtenOut) continue;
    const week = isoWeekStart(row.day);
    names.set(week, (names.get(week) ?? new Set()).add(row.exerciseId ?? row.exerciseName));
  }
  return new Map([...names].map(([week, set]) => [week, set.size]));
}

export function buildHistoryWeeksView(input: HistoryWeeksInput): HistoryWeeksView {
  const rows = workRows(input.rows);
  const rule = input.source === 'live' ? LIVE_SEGMENT_RULE : SEGMENT_RULE;
  const segmentation: WeekSegmentation = segmentWeeks(
    historyTrainingDays(rows),
    {
      reportedExercises: reportedExercisesByWeek(rows),
      ...(input.bridgedGapWeeks === undefined ? {} : { bridgedGapWeeks: input.bridgedGapWeeks }),
    },
    rule,
  );
  const byWeek = groupRows(rows, (row) => isoWeekStart(row.day));
  const weeks = segmentation.weeks.map((week: LabelledWeek) => {
    const inWeek = byWeek.get(week.week) ?? [];
    return {
      ...week,
      sets: inWeek.reduce((sum, row) => sum + row.sets, 0),
      evidence: evidenceOf(inWeek),
    };
  });
  return {
    source: input.source,
    rule: { ...rule },
    ruleBasis: 'ENGINEERING DEFAULT',
    modalSessionsPerWeek: segmentation.modalSessionsPerWeek,
    weeks,
    runs: segmentation.runs,
    gaps: segmentation.gaps,
  };
}
