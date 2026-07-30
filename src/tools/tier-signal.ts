// `getTierSignal()` — the training-experience tier signal (VW-92 MVP).
//
// Design doc: voltras-workspace `sources/research/tier-signal-design.md`
// (§3.1 output shape, §6.2 "deliberately crude ceiling"). This is the MVP
// slice only: no `detectPlateau()` wiring, no g1/g2/g4 gates. The self-report
// probe (`training_profile.ever_plateaued`) stands in for a real plateau
// *detector* — that substitution is intentional per §6, not a shortcut to
// fix later in this file.
//
// Storage only feeds this: `training_profile` (VW-96 Wave 3, see
// `profile-tools.ts`) for the declared side, `sessions` for the derived
// ceiling. Nothing here writes either table, and nothing here is wired into
// any consumer (deload rules, RIR targets, cue density, `derivePrescription`,
// …) — that consumption work is explicitly out of scope for VW-92.
//
// `sessions.user_id` is not populated by any current writer (`putSession`'s
// INSERT omits the column; see the comment on `SqliteSessionStore.putSession`
// and the corresponding note in `sqlite-store-queries.test.ts`). Filtering
// the session aggregates below by `userId` would therefore undercount every
// session logged since the one-time v6 backfill migration ran. The doc's own
// framing — "this repo is currently effectively single-user in practice" —
// is the reason this file counts *all* sessions rather than filtering, the
// same posture `profile-tools.ts` takes by keying strictly off
// `LOCAL_USER_ID` for the profile row. Revisit this the day `sessions` gets a
// real per-session `user_id` writer.

import type { ServerState } from '../state/server-state.js';
import { LOCAL_USER_ID } from '../store/types.js';

export type Tier = 'beginner' | 'intermediate' | 'advanced';

export type TierConfidence = 'provisional' | 'confident';

export type TierSource = 'default' | 'declared' | 'derived';

export interface TierSignalEvidence {
  sessionsLogged: number;
  firstSessionAt: string | null;
  weeksSpanned: number;
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

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

function weeksBetween(first: string | null, last: string | null): number {
  if (first === null || last === null) return 0;
  const spanMs = new Date(last).getTime() - new Date(first).getTime();
  if (!Number.isFinite(spanMs) || spanMs <= 0) return 0;
  return Math.floor(spanMs / MS_PER_WEEK);
}

/**
 * The §6.2 crude ceiling plus the §3.1 output shape.
 *
 * ```
 * ceiling = 'beginner'
 * if ever_plateaued and sessionsLogged >= 24 and weeksSpanned >= 12:
 *     ceiling = 'intermediate'
 *     confidence = 'confident'
 * else:
 *     confidence = 'provisional'
 * tier = min(declared ?? 'beginner', ceiling)
 * ```
 *
 * `advanced` is never produced by the ceiling (§3.5) — it can only come from
 * an explicit `declared_tier = 'advanced'`, and even then the clamp still
 * applies: a `declared` above the ceiling is lowered to the ceiling, never
 * honoured past it. (Non-hazard-class consumers that want to see `declared`
 * unclamped read that field directly, per §3.4/§5 — this function always
 * returns the clamped `tier`.)
 */
export async function getTierSignal(
  state: ServerState,
  userId: string = LOCAL_USER_ID,
): Promise<TierSignal> {
  const profile = await state.store.getTrainingProfile(userId);
  const sessionsLogged = await state.store.countSessions({ endedOnly: true });
  const span = await state.store.getSessionDateSpan({ endedOnly: true });
  const weeksSpanned = weeksBetween(span.first, span.last);
  const everPlateaued = profile?.everPlateaued ?? false;

  let derivedCeiling: Tier = 'beginner';
  let confidence: TierConfidence = 'provisional';
  if (everPlateaued && sessionsLogged >= 24 && weeksSpanned >= 12) {
    derivedCeiling = 'intermediate';
    confidence = 'confident';
  }

  const declared = isTier(profile?.declaredTier) ? profile.declaredTier : null;
  const tier = minTier(declared ?? 'beginner', derivedCeiling);
  const source: TierSource =
    declared === null ? 'default' : tier === declared ? 'declared' : 'derived';

  return {
    tier,
    confidence,
    source,
    derivedCeiling,
    declared,
    evidence: {
      sessionsLogged,
      firstSessionAt: span.first,
      weeksSpanned,
      plateauDetected: everPlateaued,
      techniqueStableUnderLoad: null,
      frequencyConsistent: null,
      planOwnershipObserved: null,
    },
  };
}
