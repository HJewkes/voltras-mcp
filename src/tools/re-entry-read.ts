// The store read behind `plan.next_workout`'s `reEntry` (VW-851, slice VW-906).
//
// The rule is pure (`analytics/re-entry.ts`); this is the one place that feeds it. It reads the
// owner's training days by the VW-462 rule, so a guest's days and a `test`-kind session never
// count, and it takes today's local date from the caller.
//
// The result rides on every `plan.next_workout` response, so it stays small: a lifter training
// normally gets the phase and the days, and only a break (or the window after one) adds the band,
// the rule and its citation.
//
// `plan.suggest_progression` (slice VW-907) reads one lift's age here too: its basis session's
// local date against today, by the same band edges.

import {
  localDate,
  readTrainingDaysMatching,
  type TrainingDayStore,
} from '../analytics/training-days.js';
import {
  classifyBreak,
  daysBetween,
  RE_ENTRY_RULES,
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

/** How old one lift's "last time" is: per lift, so a lift rotated out for a month reads stale. */
export interface LastTime {
  readonly startedAt: string;
  readonly daysAgo: number;
  readonly stale: boolean;
}

/** Today's load for a lift whose last time is stale, scaled from that session's top load. */
export interface StaleBasisReEntry {
  readonly band: 'short' | 'medium';
  readonly loadLbs: number;
  readonly loadFactor: number;
  readonly source: string;
}

const LOAD_STEP_LBS = 5;
// A factor of one third lands a hair under a whole step in floating point (150 / 3).
const ROUNDING_SLACK = 1e-9;

export function readLastTime(startedAt: string, today: string): LastTime {
  const daysAgo = daysBetween(localDate(startedAt), today);
  return { startedAt, daysAgo, stale: classifyBreak(daysAgo) !== 'none' };
}

/**
 * The re-entry load for a stale basis in the short or medium band, rounded down to a 5 lb step.
 * `null` when the basis is fresh, has no load, or the break is long enough that no old load is
 * scaled at all.
 */
export function staleBasisReEntry(
  lastTime: LastTime,
  topLoadLbs: number | undefined,
): StaleBasisReEntry | null {
  if (!lastTime.stale || topLoadLbs === undefined) return null;
  const band = classifyBreak(lastTime.daysAgo);
  if (band !== 'short' && band !== 'medium') return null;
  const rule = RE_ENTRY_RULES[band];
  const loadFactor = rule.value.loadFactor ?? 1;
  const scaled = (topLoadLbs * loadFactor + ROUNDING_SLACK) / LOAD_STEP_LBS;
  return {
    band,
    loadLbs: Math.floor(scaled) * LOAD_STEP_LBS,
    loadFactor,
    source: citation(rule.sourceKind, rule.sourceRef),
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
