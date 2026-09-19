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
// the provisional note), and `profile.get_starting_prescription`. Goal derivation reads the
// DECLARED tier for magnitude and flags when the clamp disagreed.
//
// `sessions.user_id` is not populated by any current writer, so this file counts every owner
// session rather than filtering by user id, the same single-user posture `profile-tools.ts`
// takes by keying off `LOCAL_USER_ID`.

import { readTrainingDaysMatching } from '../analytics/training-days.js';
import { LOCAL_USER_ID, type SessionStore, type StoredTrainingProfile } from '../store/types.js';

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
  store: Pick<SessionStore, 'getTrainingProfile' | 'listSessionEndTimes' | 'getSessionDateSpan'>;
}

export interface TierSignalEvidence {
  /** Distinct local days with an ended session, all time (VW-462); one visit is one day however many rows it holds. */
  trainingDaysLogged: number;
  firstSessionAt: string | null;
  weeksSpanned: number;
  /** Whether the logged history alone clears the 24-day, 12-week gate. */
  loggedHistoryMet: boolean;
  /** The longest run of days between two logged training days; `null` with fewer than two. */
  longestLoggedGapDays: number | null;
  plateauDetected: boolean;
  /** null = not enough data / not computed by this MVP (needs a later increment). */
  techniqueStableUnderLoad: boolean | null;
  frequencyConsistent: boolean | null;
  planOwnershipObserved: boolean | null;
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

function weeksBetween(first: string | null, last: string | null): number {
  if (first === null || last === null) return 0;
  const spanMs = new Date(last).getTime() - new Date(first).getTime();
  if (!Number.isFinite(spanMs) || spanMs <= 0) return 0;
  return Math.floor(spanMs / MS_PER_WEEK);
}

/** The longest run of days between consecutive training days, which arrive sorted. */
function longestGapDays(days: readonly string[]): number | null {
  let longest: number | null = null;
  for (let i = 1; i < days.length; i++) {
    const gap = (Date.parse(days[i]) - Date.parse(days[i - 1])) / DAY_MS;
    longest = longest === null ? gap : Math.max(longest, gap);
  }
  return longest;
}

/**
 * The returner path: declared prior training, a last break under a year, and no logged gap of
 * a year or more. An unanswered break question never opens it.
 */
function isReturner(
  profile: StoredTrainingProfile | undefined,
  longestLoggedGapDays: number | null,
): boolean {
  const breakMonths = profile?.lastBreakMonths;
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

/**
 * The crude ceiling (§6.2), the returner path, and the §3.1 output shape.
 *
 * ```
 * loggedHistoryMet = trainingDaysLogged >= 24 and weeksSpanned >= 12
 * confidence = loggedHistoryMet ? 'confident' : 'provisional'
 * ceiling = everPlateaued and (loggedHistoryMet or returner) ? 'intermediate' : 'beginner'
 * tier = min(declared ?? 'beginner', ceiling)
 * ```
 *
 * `advanced` is never produced by the ceiling (§3.5): it can only come from an explicit
 * `declared_tier = 'advanced'`, and the clamp still applies to it.
 */
export async function getTierSignal(
  state: TierSignalState,
  userId: string = LOCAL_USER_ID,
): Promise<TierSignal> {
  const profile = await state.store.getTrainingProfile(userId);
  const days = await readTrainingDaysMatching(state.store, {});
  const span = await state.store.getSessionDateSpan({ endedOnly: true });
  const weeksSpanned = weeksBetween(span.first, span.last);
  const everPlateaued = profile?.everPlateaued ?? false;
  const loggedHistoryMet = days.length >= MIN_TRAINING_DAYS && weeksSpanned >= MIN_WEEKS_SPANNED;
  const longestLoggedGapDays = longestGapDays(days);
  const ceilingBasis = ceilingBasisOf(
    everPlateaued,
    loggedHistoryMet,
    isReturner(profile, longestLoggedGapDays),
  );
  const derivedCeiling: Tier = ceilingBasis === null ? 'beginner' : 'intermediate';

  const declared = isTier(profile?.declaredTier) ? profile.declaredTier : null;
  const tier = minTier(declared ?? 'beginner', derivedCeiling);
  const source: TierSource =
    declared === null ? 'default' : tier === declared ? 'declared' : 'derived';

  return {
    tier,
    confidence: loggedHistoryMet ? 'confident' : 'provisional',
    source,
    derivedCeiling,
    ceilingBasis,
    declared,
    evidence: {
      trainingDaysLogged: days.length,
      firstSessionAt: span.first,
      weeksSpanned,
      loggedHistoryMet,
      longestLoggedGapDays,
      plateauDetected: everPlateaued,
      techniqueStableUnderLoad: null,
      frequencyConsistent: null,
      planOwnershipObserved: null,
    },
  };
}
