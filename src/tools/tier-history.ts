// An imported training-history summary for the tier signal (VW-551).
//
// The shape a history importer (a coaching-app export reader, say) would hand to
// `getTierSignal`. Nothing in production passes one yet. The summary is untrusted input, so
// `validateHistory` checks it at the boundary: a bad entry is dropped with a reason, a
// malformed summary is rejected with a reason, and neither ever throws into the tool path.

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

/** A summary that passed validation: dates sorted and unique, stalls reduced to their dates. */
export interface ValidatedHistory {
  source: string;
  trainingDayDates: string[];
  stallDates: string[];
  attendanceConsistency: number | null;
}

export interface HistoryValidation {
  /** `null` when the summary as a whole was rejected; the reason is in `dropped`. */
  history: ValidatedHistory | null;
  dropped: string[];
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in 'YYYY-MM-DD' form; '2025-02-30' fails the round trip. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE.exec(value);
  if (match === null) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
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

function validStallDates(raw: unknown, dropped: string[]): string[] {
  if (!isRecord(raw)) {
    if (raw !== undefined) dropped.push('firstSustainedStallByLift: not an object');
    return [];
  }
  const dates: string[] = [];
  for (const [lift, value] of Object.entries(raw)) {
    if (value === null) continue;
    if (isIsoDate(value)) dates.push(value);
    else dropped.push(`firstSustainedStallByLift.${lift}: not an ISO date or null`);
  }
  return dates.sort();
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
    stallDates: validStallDates(raw.firstSustainedStallByLift, dropped),
    attendanceConsistency: validAttendance(raw.attendanceConsistency, dropped),
  };
  return { history, dropped };
}
