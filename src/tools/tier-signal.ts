// `getTierSignal()` — the training-experience tier signal (VW-92, returner path VW-462).
//
// Design doc: the internal tier-signal design note, held outside this repo
// (§3.1 output shape, §6.2 "deliberately crude ceiling"). The self-report probe
// (`training_profile.ever_plateaued`) stands in for a real plateau detector,
// intentionally per §6. Gate evidence: the VW-462 tier-gate web research, held outside this repo.
//
// Two questions, answered separately:
// - CONFIDENCE is about how much logged history there is: `confident` needs 24 training days
//   over 12 weeks, whatever the ceiling.
// - The CEILING rises to intermediate on a plateau plus EITHER that logged history OR the
//   returner path: declared prior training and a short last break. A returner keeps the tier
//   and loses confidence, because technique and training knowledge do not detrain.
// The clamp only ever lowers the declared tier, and `advanced` is never derived.
//
// Consumers read the clamped `tier`: `plan.warmup_ramp` (rung count), `report.weekly` and
// `plan.suggest_progression` (whether a set may be added), the plan lints (volume ceilings and
// the provisional note), `profile.get_starting_prescription`, and the wall's prescription
// (`/api/session-plan`, VW-668). Goal derivation reads the
// DECLARED tier for magnitude and flags when the clamp disagreed.
//
// `sessions.user_id` is not populated by any current writer, so this file counts every owner
// session rather than filtering by user id, the same single-user posture `profile-tools.ts`
// takes by keying off `LOCAL_USER_ID`.

import { localDate, readTrainingDaysMatching, trainingGaps } from '../analytics/training-days.js';
import { readUnreviewed } from '../analytics/session-review.js';
import { LOCAL_USER_ID, type SessionStore, type StoredTrainingProfile } from '../store/types.js';
import {
  capDropped,
  cutToWindow,
  validateHistory,
  type HistoricalTrainingSummary,
} from './tier-history.js';

export type { HistoricalTrainingSummary } from './tier-history.js';

export type Tier = 'beginner' | 'intermediate' | 'advanced';

export type TierConfidence = 'provisional' | 'confident';

export type TierSource = 'default' | 'declared' | 'derived';

/** Which path raised the ceiling to intermediate, or `null` when it stayed at beginner. */
export type TierCeilingBasis = 'logged_history' | 'returner' | null;

/**
 * The store slice `getTierSignal` reads. Declared narrow (rather than
 * `ServerState`) so a non-tool caller — the goal-progress dashboard route,
 * VW-352 — can satisfy it without fabricating a whole server state; the MCP
 * tool path's `ServerState` still satisfies it structurally.
 */
export interface TierSignalState {
  store: Pick<
    SessionStore,
    | 'getTrainingProfile'
    | 'listTrainingDayInstants'
    | 'getSessionDateSpan'
    | 'listSessionReviewRows'
  >;
}

export interface TierSignalEvidence {
  /** Distinct local days with an ended session, all time (VW-462); one visit is one day however many rows it holds. */
  trainingDaysLogged: number;
  /**
   * Past local days nobody has marked training or test (VW-489). They are NOT in
   * `trainingDaysLogged`, so a gate that reads unmet with this above zero is
   * waiting on a review, not on training.
   */
  unreviewedDays: number;
  firstSessionAt: string | null;
  /** The logged span; with an imported summary, the wider of that and the union's day span. */
  weeksSpanned: number;
  /** Whether logged history, unioned with any imported summary, clears the 24-day, 12-week gate. */
  loggedHistoryMet: boolean;
  /** The longest run of days between two training days, imported ones included; `null` with fewer than two. */
  longestLoggedGapDays: number | null;
  plateauDetected: boolean;
  /** null = not enough data / not computed by this MVP (needs a later increment). */
  techniqueStableUnderLoad: boolean | null;
  /** From an imported summary's attendance when one was passed; otherwise null. */
  frequencyConsistent: boolean | null;
  planOwnershipObserved: boolean | null;
  /** Imported days not already logged, after dedupe by local date. Present only with a summary (VW-551). */
  historicalTrainingDays?: number;
  /** The summary's `source`; `null` when it was rejected outright. Present only with a summary. */
  historySource?: string | null;
  /** Which evidence said the lifter has plateaued. Present only with a summary. */
  plateauSource?: PlateauSource;
  /** The last break derived from the summary, in months; `null` when not derived. Present only with a summary. */
  historyBreakMonths?: number | null;
  /** Summary entries dropped at validation, or the whole summary rejected, each with its reason. */
  historyDropped?: string[];
}

export type PlateauSource = 'self_report' | 'history' | 'both' | null;

export interface TierSignalOptions {
  asOf?: string;
  /** An imported training-history summary; validated here, never trusted as typed. */
  history?: HistoricalTrainingSummary;
}

export interface TierSignal {
  tier: Tier;
  confidence: TierConfidence;
  source: TierSource;
  derivedCeiling: Tier;
  /** Why the ceiling rose, so the coach can say it; `null` when it did not. */
  ceilingBasis: TierCeilingBasis;
  declared: Tier | null;
  evidence: TierSignalEvidence;
}

const TIER_ORDER: Record<Tier, number> = { beginner: 0, intermediate: 1, advanced: 2 };

function isTier(value: string | undefined): value is Tier {
  return value === 'beginner' || value === 'intermediate' || value === 'advanced';
}

/** Tier ordering min: beginner < intermediate < advanced. */
function minTier(a: Tier, b: Tier): Tier {
  return TIER_ORDER[a] <= TIER_ORDER[b] ? a : b;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MS_PER_WEEK = 7 * DAY_MS;
const DAYS_PER_MONTH = 365.25 / 12;

/**
 * Logged weeks before the signal is confident. RP's fastest beginner-to-intermediate case:
 * "Some people can do this in three months of training" (lecture 29, tier-gate web research).
 */
const MIN_WEEKS_SPANNED = 12;

/**
 * Logged training days before the signal is confident. ENGINEERING DEFAULT: RP's minimum
 * beginner frequency of two days a week over those 12 weeks. It also matches the research's
 * trend-noise arithmetic, 18 to 24 exposures before a slow trend reads apart from a plateau.
 */
const MIN_TRAINING_DAYS = 24;

/**
 * Declared years of training for the returner path. Rhea et al. 2003 count a lifter as trained
 * after "at least 1 yr" of weight training; ACSM 2009 puts intermediate at about 6 months. The
 * stricter of the two, because this path lifts the clamp on self-report alone.
 */
const RETURNER_MIN_YEARS_TRAINING = 1;

/**
 * A break at least this long ends the returner path. Nuckols (Stronger By Science, 2022): after
 * more than a year out, train as an untrained lifter. It applies both to the declared last
 * break and to any gap between logged training days, so a break after the answer counts too.
 */
const MAX_BREAK_MONTHS = 12;

/**
 * Attendance at or above this share of planned weeks reads as consistent frequency.
 * ENGINEERING DEFAULT: three planned weeks in four. Evidence only; it never moves the tier.
 */
const MIN_CONSISTENT_ATTENDANCE = 0.75;

function weeksBetween(first: string | null, last: string | null): number {
  if (first === null || last === null) return 0;
  const spanMs = new Date(last).getTime() - new Date(first).getTime();
  if (!Number.isFinite(spanMs) || spanMs <= 0) return 0;
  return Math.floor(spanMs / MS_PER_WEEK);
}

/** The longest run of days between consecutive training days; `null` with fewer than two. */
function longestGapDays(days: readonly string[]): number | null {
  const gaps = trainingGaps(days).map((gap) => gap.days);
  return gaps.length === 0 ? null : Math.max(...gaps);
}

/**
 * The returner path: declared prior training, a last break under a year, and no logged gap of
 * a year or more. An answered break question wins over a break derived from an imported
 * summary; with neither, the path stays closed.
 */
function isReturner(
  profile: StoredTrainingProfile | undefined,
  longestLoggedGapDays: number | null,
  derivedBreakMonths: number | null,
): boolean {
  const breakMonths = profile?.lastBreakMonths ?? derivedBreakMonths ?? undefined;
  return (
    (profile?.yearsTraining ?? 0) >= RETURNER_MIN_YEARS_TRAINING &&
    breakMonths !== undefined &&
    breakMonths < MAX_BREAK_MONTHS &&
    (longestLoggedGapDays ?? 0) < MAX_BREAK_MONTHS * DAYS_PER_MONTH
  );
}

function ceilingBasisOf(
  everPlateaued: boolean,
  loggedHistoryMet: boolean,
  returner: boolean,
): TierCeilingBasis {
  if (!everPlateaued) return null;
  if (loggedHistoryMet) return 'logged_history';
  return returner ? 'returner' : null;
}

/** What an imported summary adds to the logged read (VW-551). */
interface ImportedHistory {
  unionDays: string[];
  stalled: boolean;
  breakMonths: number | null;
  frequencyConsistent: boolean | null;
  evidence: Required<
    Pick<
      TierSignalEvidence,
      'historicalTrainingDays' | 'historySource' | 'historyBreakMonths' | 'historyDropped'
    >
  >;
}

function frequencyFromAttendance(attendance: number | null): boolean | null {
  return attendance === null ? null : attendance >= MIN_CONSISTENT_ATTENDANCE;
}

/** Whole weeks between the first and last of some local dates, oldest first. */
function daySpanWeeks(days: readonly string[]): number {
  if (days.length < 2) return 0;
  return Math.floor((Date.parse(days[days.length - 1]) - Date.parse(days[0])) / MS_PER_WEEK);
}

/**
 * Months from the summary's last day to the first logged day, or to asOf/now when none is
 * logged, rounded to the 0.1 month the evidence shows so the gate reads the shown value.
 */
function derivedBreakMonths(
  importedDays: readonly string[],
  loggedDays: readonly string[],
  cutoff: string,
): number | null {
  const lastImported = importedDays.at(-1);
  if (lastImported === undefined) return null;
  const resumedOn = loggedDays[0] ?? cutoff;
  const gapDays = Math.max(0, (Date.parse(resumedOn) - Date.parse(lastImported)) / DAY_MS);
  return Math.round((gapDays / DAYS_PER_MONTH) * 10) / 10;
}

/** Validate a summary, cut it at asOf (or today), and union it with the logged days. */
function readImportedHistory(
  raw: HistoricalTrainingSummary,
  loggedDays: readonly string[],
  asOf: string | undefined,
): ImportedHistory {
  const { history, dropped } = validateHistory(raw);
  const cutoff = localDate(asOf ?? new Date().toISOString());
  const windowed = cutToWindow(history, loggedDays, cutoff);
  const logged = new Set(loggedDays);
  const added = windowed.trainingDayDates.filter((date) => !logged.has(date));
  const breakMonths = derivedBreakMonths(windowed.trainingDayDates, loggedDays, cutoff);
  return {
    unionDays: [...loggedDays, ...added].sort(),
    stalled: windowed.stallDates.length > 0,
    breakMonths,
    frequencyConsistent: frequencyFromAttendance(history?.attendanceConsistency ?? null),
    evidence: {
      historicalTrainingDays: added.length,
      historySource: history?.source ?? null,
      historyBreakMonths: breakMonths,
      historyDropped: capDropped([...dropped, ...windowed.dropped]),
    },
  };
}

function plateauSourceOf(selfReport: boolean, history: boolean): PlateauSource {
  if (selfReport && history) return 'both';
  if (selfReport) return 'self_report';
  return history ? 'history' : null;
}

/** The training-day read behind both gates: logged days, plus an imported summary when passed. */
interface HistoryRead {
  loggedDays: string[];
  firstSessionAt: string | null;
  unionDays: string[];
  weeksSpanned: number;
  imported: ImportedHistory | null;
}

async function readHistory(
  store: TierSignalState['store'],
  asOf: string | undefined,
  summary: HistoricalTrainingSummary | undefined,
): Promise<HistoryRead> {
  const asOfFilter = asOf === undefined ? {} : { to: asOf };
  const loggedDays = await readTrainingDaysMatching(store, asOfFilter);
  const span = await store.getSessionDateSpan({ endedOnly: true, ...asOfFilter });
  const loggedWeeks = weeksBetween(span.first, span.last);
  if (summary === undefined) {
    return {
      loggedDays,
      firstSessionAt: span.first,
      unionDays: loggedDays,
      weeksSpanned: loggedWeeks,
      imported: null,
    };
  }
  const imported = readImportedHistory(summary, loggedDays, asOf);
  const weeksSpanned = Math.max(loggedWeeks, daySpanWeeks(imported.unionDays));
  return {
    loggedDays,
    firstSessionAt: span.first,
    unionDays: imported.unionDays,
    weeksSpanned,
    imported,
  };
}

function sourceOf(declared: Tier | null, tier: Tier): TierSource {
  if (declared === null) return 'default';
  return tier === declared ? 'declared' : 'derived';
}

interface Gates {
  everPlateaued: boolean;
  loggedHistoryMet: boolean;
  longestLoggedGapDays: number | null;
  ceilingBasis: TierCeilingBasis;
}

function gatesOf(profile: StoredTrainingProfile | undefined, read: HistoryRead): Gates {
  const everPlateaued = (profile?.everPlateaued ?? false) || (read.imported?.stalled ?? false);
  const loggedHistoryMet =
    read.unionDays.length >= MIN_TRAINING_DAYS && read.weeksSpanned >= MIN_WEEKS_SPANNED;
  const longestLoggedGapDays = longestGapDays(read.unionDays);
  const returner = isReturner(profile, longestLoggedGapDays, read.imported?.breakMonths ?? null);
  return {
    everPlateaued,
    loggedHistoryMet,
    longestLoggedGapDays,
    ceilingBasis: ceilingBasisOf(everPlateaued, loggedHistoryMet, returner),
  };
}

/** The evidence keys only an imported summary adds; none at all without one. */
function importedEvidenceOf(
  imported: ImportedHistory | null,
  profile: StoredTrainingProfile | undefined,
): Partial<TierSignalEvidence> {
  if (imported === null) return {};
  return {
    ...imported.evidence,
    plateauSource: plateauSourceOf(profile?.everPlateaued ?? false, imported.stalled),
  };
}

/**
 * The crude ceiling (§6.2), the returner path, and the §3.1 output shape.
 *
 * ```
 * loggedHistoryMet = trainingDays >= 24 and weeksSpanned >= 12   (logged, unioned with any summary)
 * confidence = loggedHistoryMet ? 'confident' : 'provisional'
 * ceiling = everPlateaued and (loggedHistoryMet or returner) ? 'intermediate' : 'beginner'
 * tier = min(declared ?? 'beginner', ceiling)
 * ```
 *
 * `advanced` is never produced by the ceiling (§3.5): it can only come from an explicit
 * `declared_tier = 'advanced'`, and the clamp still applies to it.
 *
 * `asOf` counts only sessions that started at or before that instant, and only imported days
 * and stalls on or before its local date; omitted, the whole history counts. The profile and
 * the unreviewed-day count are always read as they stand now. It may be passed positionally
 * or in `options`. With no `history`, the output is exactly what it was before VW-551.
 */
export async function getTierSignal(
  state: TierSignalState,
  userId: string = LOCAL_USER_ID,
  asOfOrOptions?: string | TierSignalOptions,
): Promise<TierSignal> {
  const options = typeof asOfOrOptions === 'string' ? { asOf: asOfOrOptions } : asOfOrOptions;
  const profile = await state.store.getTrainingProfile(userId);
  const read = await readHistory(state.store, options?.asOf, options?.history);
  const gates = gatesOf(profile, read);
  const derivedCeiling: Tier = gates.ceilingBasis === null ? 'beginner' : 'intermediate';
  const unreviewed = await readUnreviewed(state.store);
  const declared = isTier(profile?.declaredTier) ? profile.declaredTier : null;
  const tier = minTier(declared ?? 'beginner', derivedCeiling);
  return {
    tier,
    confidence: gates.loggedHistoryMet ? 'confident' : 'provisional',
    source: sourceOf(declared, tier),
    derivedCeiling,
    ceilingBasis: gates.ceilingBasis,
    declared,
    evidence: {
      trainingDaysLogged: read.loggedDays.length,
      unreviewedDays: unreviewed.unreviewedDays,
      firstSessionAt: read.firstSessionAt,
      weeksSpanned: read.weeksSpanned,
      loggedHistoryMet: gates.loggedHistoryMet,
      longestLoggedGapDays: gates.longestLoggedGapDays,
      plateauDetected: gates.everPlateaued,
      techniqueStableUnderLoad: null,
      frequencyConsistent: read.imported?.frequencyConsistent ?? null,
      planOwnershipObserved: null,
      ...importedEvidenceOf(read.imported, profile),
    },
  };
}
