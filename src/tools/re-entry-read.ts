// The store read behind `plan.next_workout`'s `reEntry` (VW-851, slice VW-906).
//
// The rule is pure (`analytics/re-entry.ts`); this is the one place that feeds it. It reads the
// owner's training days by the VW-462 rule, so a guest's days and a `test`-kind session never
// count, and it takes today's local date from the caller.
//
// The result rides on every `plan.next_workout` response, so it stays small: a lifter training
// normally gets the phase and the days, and only a break (or the window after one) adds the band,
// the rule and its citation.

import { readTrainingDaysMatching, type TrainingDayStore } from '../analytics/training-days.js';
import {
  selectReEntry,
  type BreakBand,
  type ReEntryPhase,
  type ReEntryRead,
  type ReEntryRule,
} from '../analytics/re-entry.js';

export interface ReEntryBrief {
  readonly phase: ReEntryPhase;
  readonly daysSinceLastTrainingDay: number | null;
}

export interface ReEntryBreakBrief extends ReEntryBrief {
  readonly band: BreakBand;
  /** The last day of the re-entry window, inclusive; `null` when the band has no window. */
  readonly windowEndsOn: string | null;
  readonly rule: ReEntryRule & { readonly source: string };
}

export type ReEntryResult = ReEntryBrief | ReEntryBreakBrief;

/** The authors and year of a paper source; any other kind is named by its kind. */
function citation(sourceKind: string, sourceRef: string): string {
  if (sourceKind !== 'paper') return sourceKind;
  return sourceRef
    .split('; ')
    .map((part) => part.split(',')[0])
    .join('; ');
}

/** The compact result: the full read only for a break or the window after one. */
export function briefReEntry(read: ReEntryRead): ReEntryResult {
  const { phase, daysSinceLastTrainingDay } = read;
  if (read.rule === null) return { phase, daysSinceLastTrainingDay };
  return {
    phase,
    daysSinceLastTrainingDay,
    band: read.band,
    windowEndsOn: read.windowEndsOn,
    rule: { ...read.rule.value, source: citation(read.rule.sourceKind, read.rule.sourceRef) },
  };
}

/** Everything the lifter has logged up to `nowIso`, not a rolling window: a break can be long. */
export async function readReEntry(
  store: TrainingDayStore,
  today: string,
  nowIso: string,
): Promise<ReEntryResult> {
  const trainingDays = await readTrainingDaysMatching(store, { to: nowIso });
  return briefReEntry(selectReEntry({ trainingDays, today }));
}
