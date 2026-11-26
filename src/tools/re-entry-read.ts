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
// A break also carries the lifter's latest return clearance answer (VW-976), and, while that
// answer is "not yet", the reason `session.start` holds working sessions.
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
  scaleReEntryLoad,
  selectReEntry,
  type BreakBand,
  type ReEntryPhase,
  type ReEntryRead,
  type ReEntryRule,
  type RirFloorByWeek,
} from '../analytics/re-entry.js';
import type { BaselineSession } from '../analytics/baseline-session.js';
import type { SourcedValue } from '../coach-copy/fragments.js';
import { clearanceBlock, type StoredReturnClearance } from '../profile/return-clearance.js';
import { LOCAL_USER_ID, type SessionStore } from '../store/types.js';

/** Where a lifter with no load to scale starts instead of a baseline session. */
export const STARTING_PRESCRIPTION_TOOL = 'profile.get_starting_prescription';

export interface ReEntryBrief {
  readonly phase: ReEntryPhase;
  readonly daysSinceLastTrainingDay: number | null;
}

/** A guardrail as the result carries it: its value and a short citation of its own. */
interface Cited<T> {
  readonly value: T;
  readonly source: string;
}

export type ReEntryRuleBrief = Omit<
  ReEntryRule,
  'rirFloor' | 'noFailureSets' | 'velocityLossCapPct'
> & {
  readonly rirFloor?: Cited<RirFloorByWeek>;
  readonly noFailureSets?: Cited<true>;
  readonly velocityLossCapPct?: Cited<number>;
  readonly source: string;
};

export interface ReEntryBreakBrief extends ReEntryBrief {
  readonly band: BreakBand;
  /** The last day of the re-entry window, inclusive; `null` when the band has no window. */
  readonly windowEndsOn: string | null;
  readonly rule: ReEntryRuleBrief;
  /** The latest return clearance answer; `null` when the question was never answered. */
  readonly clearance: StoredReturnClearance | null;
  /** Why working sessions are held; present only while "not yet" stands. */
  readonly blocked?: string;
  /**
   * The day-1 session (VW-982): on an open break, or on the first day back. `null` when no
   * lift has a load to scale; `startFrom` then names the tool to begin from instead.
   */
  readonly baselineSession?: BaselineSession | null;
  readonly startFrom?: typeof STARTING_PRESCRIPTION_TOOL;
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

function cited<T>({ value, sourceKind, sourceRef }: SourcedValue<T>): Cited<T> {
  return { value, source: citation(sourceKind, sourceRef) };
}

function briefRule({ value, sourceKind, sourceRef }: SourcedValue<ReEntryRule>): ReEntryRuleBrief {
  const { rirFloor, noFailureSets, velocityLossCapPct, ...load } = value;
  return {
    ...load,
    ...(rirFloor && { rirFloor: cited(rirFloor) }),
    ...(noFailureSets && { noFailureSets: cited(noFailureSets) }),
    ...(velocityLossCapPct && { velocityLossCapPct: cited(velocityLossCapPct) }),
    source: citation(sourceKind, sourceRef),
  };
}

/** The compact result: the full read only for a break or the window after one. */
export function briefReEntry(
  read: ReEntryRead,
  clearance: StoredReturnClearance | undefined = undefined,
): ReEntryResult {
  const { phase, daysSinceLastTrainingDay } = read;
  if (read.rule === null) return { phase, daysSinceLastTrainingDay };
  const blocked = clearanceBlock(clearance);
  return {
    phase,
    daysSinceLastTrainingDay,
    band: read.band,
    windowEndsOn: read.windowEndsOn,
    rule: briefRule(read.rule),
    clearance: clearance ?? null,
    ...(blocked === null ? {} : { blocked }),
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

/**
 * `trainingDayInstant` dates the session the way the VW-462 training-day rule does (its end, or
 * its last working set's end), so a session that crosses local midnight reads the same day here
 * as on `plan.next_workout`.
 */
export function readLastTime(
  startedAt: string,
  trainingDayInstant: string,
  today: string,
): LastTime {
  const daysAgo = daysBetween(localDate(trainingDayInstant), today);
  return { startedAt, daysAgo, stale: classifyBreak(daysAgo) !== 'none' };
}

/**
 * The re-entry load for a stale basis in the short or medium band, rounded down to a 5 lb step.
 * `null` when the basis is fresh, has no load, or the break is long enough that no old load is
 * scaled at all.
 *
 * Never under one 5 lb step: that step is the smallest load change this tool suggests, so a light
 * lift (10 lb x one third) re-enters at 5 lb rather than at 0. Never above the old load either: a
 * top load of 5 lb or less holds where it was.
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
  return {
    band,
    loadLbs: scaleReEntryLoad(topLoadLbs, loadFactor),
    loadFactor,
    source: citation(rule.sourceKind, rule.sourceRef),
  };
}

/** Builds the baseline session for the rule in force; the caller owns the template and history. */
export type BaselineBuilder = (rule: ReEntryRule) => Promise<BaselineSession | null>;

export type ReEntryStore = TrainingDayStore & Pick<SessionStore, 'getTrainingProfile'>;

/**
 * Everything the lifter has logged up to `nowIso`, not a rolling window: a break can be long.
 * With `buildBaseline`, a result that offers the day-1 session carries it.
 */
export async function readReEntry(
  store: ReEntryStore,
  today: string,
  nowIso: string,
  buildBaseline?: BaselineBuilder,
): Promise<ReEntryResult> {
  const trainingDays = await readTrainingDaysMatching(store, { to: nowIso });
  const read = selectReEntry({ trainingDays, today });
  const profile = await store.getTrainingProfile(LOCAL_USER_ID);
  const brief = briefReEntry(read, profile?.returnClearance);
  if (buildBaseline === undefined || read.rule === null) return brief;
  if (!offersBaselineSession(read, trainingDays, today)) return brief;
  const baselineSession = await buildBaseline(read.rule.value);
  if (baselineSession !== null) return { ...brief, baselineSession };
  return { ...brief, baselineSession: null, startFrom: STARTING_PRESCRIPTION_TOOL };
}

/**
 * An open break offers the baseline session, and so does the first day back: the training day
 * that closed the break is today, so the window holds no session from before today.
 */
export function offersBaselineSession(
  read: ReEntryRead,
  trainingDays: readonly string[],
  today: string,
): boolean {
  if (read.phase === 'in_gap') return true;
  if (read.phase !== 'returning' || trainingDays.at(-1) !== today) return false;
  const dayBefore = trainingDays.at(-2);
  return dayBefore !== undefined && classifyBreak(daysBetween(dayBefore, today)) !== 'none';
}

/**
 * Why `session.start` holds a working session for the owner now, or `null`. The answer is read
 * first: with no "not yet" standing, the training days are never read.
 */
export async function readClearanceBlock(
  store: ReEntryStore,
  today: string,
  nowIso: string,
): Promise<string | null> {
  const profile = await store.getTrainingProfile(LOCAL_USER_ID);
  if (clearanceBlock(profile?.returnClearance) === null) return null;
  const reEntry = await readReEntry(store, today, nowIso);
  return 'blocked' in reEntry && reEntry.blocked !== undefined ? reEntry.blocked : null;
}
