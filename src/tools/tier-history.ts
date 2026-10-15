// An imported training-history summary for the tier signal (VW-551).
//
// The shape a history importer (a coaching-app export reader, say) would hand to
// `getTierSignal`. Nothing in production passes one yet. The summary is untrusted input, so
// `validateHistory` checks it at the boundary: a bad entry is dropped with a reason, a
// malformed summary is rejected with a reason, and neither ever throws into the tool path.

import { isIsoDate } from '../plan/block-calendar.js';

export interface HistoricalTrainingSummary {
  /** Where the summary came from, echoed into the evidence so the coach can name it. */
  source: string;
  /** ISO local dates ('YYYY-MM-DD'), one per distinct training day. */
  trainingDayDates: string[];
  /** ISO date of the first sustained stall per main lift; `null` means none seen. */
  firstSustainedStallByLift: Record<string, string | null>;
  /** Share of planned weeks hit, 0..1; `null` when the source has no plan to compare against. */
  attendanceConsistency: number | null;
}

/** One lift's first sustained stall. */
export interface StallEntry {
  lift: string;
  date: string;
}

/** A summary that passed validation: dates sorted and unique, stalls sorted by date. */
export interface ValidatedHistory {
  source: string;
  trainingDayDates: string[];
  stalls: StallEntry[];
  attendanceConsistency: number | null;
}

export interface HistoryValidation {
  /** `null` when the summary as a whole was rejected; the reason is in `dropped`. */
  history: ValidatedHistory | null;
  dropped: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validDates(raw: unknown[], dropped: string[]): string[] {
  const seen = new Set<string>();
  for (const value of raw) {
    if (!isIsoDate(value)) dropped.push(`trainingDayDates: not an ISO date: ${String(value)}`);
    else if (seen.has(value)) dropped.push(`trainingDayDates: duplicate ${value}`);
    else seen.add(value);
  }
  return [...seen].sort();
}

function validStalls(raw: unknown, dropped: string[]): StallEntry[] {
  if (!isRecord(raw)) {
    if (raw !== undefined) dropped.push('firstSustainedStallByLift: not an object');
    return [];
  }
  const stalls: StallEntry[] = [];
  for (const [lift, value] of Object.entries(raw)) {
    if (value === null) continue;
    if (isIsoDate(value)) stalls.push({ lift, date: value });
    else dropped.push(`firstSustainedStallByLift.${lift}: not an ISO date or null`);
  }
  return stalls.sort((a, b) => a.date.localeCompare(b.date));
}

function validAttendance(raw: unknown, dropped: string[]): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw;
  dropped.push(`attendanceConsistency: outside 0..1: ${String(raw)}`);
  return null;
}

/** Check an imported summary at the boundary; never throws. */
export function validateHistory(raw: unknown): HistoryValidation {
  if (!isRecord(raw)) return { history: null, dropped: ['summary: not an object'] };
  if (typeof raw.source !== 'string' || raw.source.trim() === '') {
    return { history: null, dropped: ['summary: source missing'] };
  }
  if (!Array.isArray(raw.trainingDayDates)) {
    return { history: null, dropped: ['summary: trainingDayDates is not an array'] };
  }
  const dropped: string[] = [];
  const history: ValidatedHistory = {
    source: raw.source,
    trainingDayDates: validDates(raw.trainingDayDates, dropped),
    stalls: validStalls(raw.firstSustainedStallByLift, dropped),
    attendanceConsistency: validAttendance(raw.attendanceConsistency, dropped),
  };
  return { history, dropped };
}

/** The entries a lifter could have lived by `cutoff`, and why each other entry was cut. */
export interface WindowedHistory {
  trainingDayDates: string[];
  stallDates: string[];
  dropped: string[];
}

/**
 * Cut what no lifter could have lived by `cutoff` (a local date): training days after it, and
 * stalls after it or before the first training day, logged or imported.
 */
export function cutToWindow(
  history: ValidatedHistory | null,
  loggedDays: readonly string[],
  cutoff: string,
): WindowedHistory {
  const dropped: string[] = [];
  const trainingDayDates = (history?.trainingDayDates ?? []).filter((date) => {
    if (date <= cutoff) return true;
    dropped.push(`trainingDayDates: ${date} is after ${cutoff}`);
    return false;
  });
  const firstDay = [loggedDays[0], trainingDayDates[0]]
    .filter((day) => day !== undefined)
    .sort()[0];
  const stallDates = (history?.stalls ?? []).flatMap(({ lift, date }) => {
    const reason =
      date > cutoff
        ? `is after ${cutoff}`
        : firstDay === undefined || date < firstDay
          ? 'is before the first training day'
          : null;
    if (reason === null) return [date];
    dropped.push(`firstSustainedStallByLift.${lift}: ${date} ${reason}`);
    return [];
  });
  return { trainingDayDates, stallDates, dropped };
}

/** Reasons listed in full before the rest collapse into a count. */
export const MAX_DROPPED_LISTED = 50;

/** The first MAX_DROPPED_LISTED reasons, then one line counting the rest. */
export function capDropped(dropped: readonly string[]): string[] {
  if (dropped.length <= MAX_DROPPED_LISTED) return [...dropped];
  const rest = dropped.length - MAX_DROPPED_LISTED;
  return [...dropped.slice(0, MAX_DROPPED_LISTED), `and ${rest} more dropped`];
}
