// `exercise_baselines` — the first read/write path over the state machine that
// has been inert DDL since v7 (VW-116 / B56).
//
// WHAT THIS TABLE HOLDS, AND WHAT IT DELIBERATELY DOES NOT
// -------------------------------------------------------
// State ONLY. No baseline VALUES (median ROM, tempo mean, velocity decay
// slope) are written here — those are recomputed from stored reps on every
// read, because a number persisted from a formula that later changes becomes a
// silent lie (data-layer-migration-plan.md §2 C2). What IS persisted is
// history about our own confidence: how many observations back this baseline,
// how consistent they were, and when it went stale. No amount of rep data
// reproduces that.
//
// `setup_id` IS NULL UNLESS THE CALLER ASKS FOR A SETUP
// -----------------------------------------------------
// A NULL-`setup_id` baseline pools every set for the key — "the one default
// setup for this exercise" — and is what every row written before VW-119 is.
// Since ROM clustering shipped (`exercise-setups.ts`), a caller may name a
// setup that exists and get a row derived from only the sets stamped into it.
// The two coexist: the pooled row stays re-derivable from the same reps, which
// is exactly why no values are cached here. The `UNIQUE (user_id, exercise_id,
// setup_id, side)` constraint admits both, and `baselineKeyId` — a total
// function of all four dimensions, NULLs included — remains the row identity.
//
// IDENTITY comes from `@voltras/workout-analytics`'s public `BaselineKey`
// (`baselineKeyId` for the primary key, `matchesBaselineKey` for selection).
// This module does not invent a parallel key scheme.

import {
  baselineKeyId,
  getRepDuration,
  type BaselineKey,
  type Rep,
} from '@voltras/workout-analytics';

import type { BaselineState, StoredExerciseBaseline, StoredSet } from './types.js';

/**
 * Version stamped onto every row this module writes. Bump on ANY change to
 * the thresholds or the derivation below: a row's `state` is only interpretable
 * against the rules that produced it, and re-deriving history after a rule
 * change means knowing which rows are stale.
 */
export const BASELINE_ALGORITHM_VERSION = 'baseline@1.0.0';

/**
 * Promotion thresholds. Every one of these is load-bearing and traceable to
 * the VBT/RIR protocol's state table (vbt-rir-research-and-protocol.md §4.4).
 */
export const BASELINE_THRESHOLDS = {
  /**
   * A set only counts as a shape observation once it has enough reps for a
   * velocity-decay slope to mean anything. Four is the protocol's floor.
   */
  minRepsPerShapeSet: 4,
  /** Qualifying sets required before shape is considered established. */
  minShapeSets: 3,
  /**
   * Tempo-consistency gate on shape. Sets performed at wildly different
   * cadences do not describe one movement: their decay slopes are not
   * comparable, and averaging them manufactures a confident-looking baseline
   * out of two different exercises. Measured as the coefficient of variation
   * of per-set mean rep duration across qualifying sets; a single qualifying
   * set has no spread and is treated as consistent.
   */
  maxShapeTempoCv: 0.35,
  /** Failure anchors required for CALIBRATED (protocol §4.4). */
  minCalibratedAnchors: 3,
  /**
   * Anchor-spread tolerance for CALIBRATED. Spread gates promotion on its own,
   * not just count: a user whose anchors disagree wildly is not calibratable
   * and must stay at SHAPE_ONLY however long they train, rather than having
   * noise averaged into a confident number (§4.4).
   */
  maxCalibratedAnchorSpread: 0.15,
  /**
   * Distinct anchor sessions required for CALIBRATED. NOT optional: multiple
   * anchors from one session are correlated and will look more consistent than
   * they are.
   */
  minCalibratedAnchorSessions: 2,
  /**
   * Days without a qualifying observation before a baseline degrades to STALE.
   * A stale baseline is not wrong, it is unvouched-for: consumers treat it as
   * SHAPE_ONLY and it re-enters its former tier on fresh observations.
   *
   * A TIME-ONLY STAND-IN, deliberately. The protocol's real invalidators
   * (§4.5) are baseline SHIFTS — a sustained >10–15 % move in median
   * concentric ROM or in the tempo baseline, which is how an attachment
   * change, a seat-height change or a deliberate technique change becomes
   * detectable. That detector is a separate build (it needs the computed ROM
   * and tempo baselines, which by design are not stored here) and is out of
   * scope for this PR. Until it exists, the only invalidator in force is the
   * one row of §4.5's table that is readable "from the calendar": a layoff
   * beyond ~3–4 weeks, after which the anchor drifts with detraining.
   *
   * 28 days is the top of that ~3–4-week band. The asymmetry picks the
   * direction: demoting a still-valid baseline only costs features (the
   * consumer falls back to relative signals), while leaving a drifted one
   * CALIBRATED biases RIR estimates OPTIMISTIC — telling a user they have
   * reps left when they do not, the one failure direction §4.5 calls
   * dangerous. So err toward tripping early, and take the band's ceiling
   * rather than a doubled figure with no source.
   *
   * Note this measures a layoff FROM THIS KEY, not from training generally:
   * an exercise rotated out of a program for a month has an anchor as
   * untrustworthy as one belonging to a user who did not train at all, since
   * both the anchor and the shape are movement-specific.
   */
  staleAfterDays: 28,
} as const;

/** One failure anchor, as far as the state machine cares. */
export interface AnchorObservation {
  /**
   * Session the anchor was observed in. Anchors with no resolvable session
   * (the anchor's set row was deleted) fall back to a per-day bucket at the
   * caller — see `selectAnchors`.
   */
  sessionBucket: string;
  /** When the anchor was observed, ISO-8601. */
  observedAt: string;
  /** Terminal velocity at failure. Absent anchors do not contribute to spread. */
  terminalVelocityMps?: number;
  /**
   * The inferred physical setup the anchor's set was performed at (VW-119).
   * Absent means unknown, NOT "some other setup": every anchor harvested
   * before the clustering ran carries nothing, and a set with no measurable
   * travel is never stamped.
   */
  setupId?: string;
}

/** Which pool {@link selectSetupAnchors} drew from. */
export type AnchorScope = 'pooled' | 'setup';

/** What an anchor selection did, without the anchors themselves. */
export interface AnchorSelectionReport {
  scope: AnchorScope;
  /**
   * The key named a setup and no anchor carries it, so the exercise's whole
   * pool was used. Always false for a pooled key — a key that asked for
   * nothing narrower did not fall back to anything.
   */
  pooledFallback: boolean;
  anchorCount: number;
  /** One phrase naming why this pool, in the shape the filter's `reason` takes. */
  reason: string;
}

/** A selection report plus the anchors it selected. */
export interface AnchorSelection extends AnchorSelectionReport {
  anchors: AnchorObservation[];
}

/**
 * Prefer anchors from one inferred setup, and fall back to the whole pool when
 * none carry it (VW-204).
 *
 * PREFER, THEN FALL BACK — never "same setup only". A naive filter would leave
 * a newly-clustered exercise with zero eligible anchors and silently stop
 * producing a baseline that worked yesterday, which is a demotion nothing
 * downstream can see: anchor evidence feeds the CALIBRATED gate, and losing it
 * reads as SHAPE_ONLY rather than as an error.
 *
 * NO MINIMUM COUNT, deliberately. "At least N same-setup anchors" would be a
 * threshold with no source behind it; one anchor from this bench is evidence
 * about this bench, and the fallback rule already covers the case where there
 * are none.
 *
 * A key naming no setup takes the whole pool and reports no fallback: it asked
 * for nothing narrower, so it lost nothing. That is the common case — most
 * exercises have no setups inferred — and it is byte-identical to the
 * pre-VW-204 behaviour, where every anchor carried a NULL setup.
 */
export function selectSetupAnchors(
  setupId: string | undefined,
  anchors: AnchorObservation[],
): AnchorSelection {
  if (setupId === undefined) {
    return pooled(anchors, false, 'pooled key: every anchor for the exercise counts');
  }
  const sameSetup = anchors.filter((a) => a.setupId === setupId);
  if (sameSetup.length === 0) {
    return pooled(anchors, true, 'no anchor carries this setup; pooled anchors used instead');
  }
  return {
    scope: 'setup',
    pooledFallback: false,
    anchorCount: sameSetup.length,
    reason: 'anchors from this setup only',
    anchors: sameSetup,
  };
}

function pooled(
  anchors: AnchorObservation[],
  pooledFallback: boolean,
  reason: string,
): AnchorSelection {
  return { scope: 'pooled', pooledFallback, anchorCount: anchors.length, reason, anchors };
}

/** Everything the derivation needs, already reduced out of SQL rows. */
export interface BaselineObservations {
  /** Sets with at least `minRepsPerShapeSet` reps, oldest-first. */
  qualifyingSetCount: number;
  /** DISTINCT sessions among qualifying sets — promotion needs time, not volume. */
  observedSessions: number;
  /** Coefficient of variation of per-set mean rep duration; `undefined` when < 2 sets. */
  tempoCv?: number;
  /** ISO timestamp of the earliest qualifying set, if any. */
  firstObservedAt?: string;
  /** ISO timestamp of the most recent qualifying set, if any. */
  lastObservedAt?: string;
  anchors: AnchorObservation[];
}

/** The derived half of a baseline row. */
export interface BaselineDerivation {
  state: BaselineState;
  confidence: number;
  observedSessions: number;
  anchorCount: number;
  anchorSpread?: number;
  lastAnchorAt?: string;
  firstObservedAt?: string;
  invalidatedAt?: string;
  invalidationReason?: string;
}

/**
 * Reduce a key's stored sets into the observation summary the state machine
 * reads. Pure: every input is already-fetched rows.
 */
export function summarizeSets(sets: StoredSet[]): Omit<BaselineObservations, 'anchors'> {
  const qualifying = sets.filter((s) => s.reps.length >= BASELINE_THRESHOLDS.minRepsPerShapeSet);
  if (qualifying.length === 0) {
    return { qualifyingSetCount: 0, observedSessions: 0 };
  }
  const sessions = new Set(qualifying.map((s) => s.sessionId));
  const started = qualifying.map((s) => s.startedAt).sort();
  const meanDurations = qualifying
    .map((s) => meanRepDurationSec(s.reps))
    .filter((d): d is number => d !== undefined && d > 0);

  const out: Omit<BaselineObservations, 'anchors'> = {
    qualifyingSetCount: qualifying.length,
    observedSessions: sessions.size,
  };
  const first = started[0];
  const last = started[started.length - 1];
  if (first !== undefined) out.firstObservedAt = first;
  if (last !== undefined) out.lastObservedAt = last;
  const cv = coefficientOfVariation(meanDurations);
  if (cv !== undefined) out.tempoCv = cv;
  return out;
}

/**
 * The state machine. Ratchets COLD → SHAPE_ONLY → PROVISIONAL → CALIBRATED,
 * with STALE as a time-based degrade off any established tier.
 *
 * - **COLD** — shape not established: fewer than `minShapeSets` sets of
 *   `minRepsPerShapeSet`+ reps, or those sets disagree on tempo.
 * - **SHAPE_ONLY** — shape established, no failure anchor. Relative signals
 *   (velocity loss %, ROM decline) are honest here; anything phrased in reps
 *   to failure is not.
 * - **PROVISIONAL** — shape + 1–2 anchors. Internal estimate only.
 * - **CALIBRATED** — shape + `minCalibratedAnchors` anchors, spread within
 *   tolerance, across `minCalibratedAnchorSessions` distinct sessions.
 * - **STALE** — no qualifying observation for `staleAfterDays`. Degrades from
 *   any established tier and re-enters it on fresh observations, so this is a
 *   ratchet in evidence, not a one-way door.
 *
 * `confidence` is a coarse 0–1 scalar meant for ordering and gating, not for
 * arithmetic: tier floor plus a within-tier term (session count for shape,
 * anchor agreement for calibration).
 */
export function deriveBaselineState(obs: BaselineObservations, now: Date): BaselineDerivation {
  const anchorSpread = coefficientOfVariation(
    obs.anchors
      .map((a) => a.terminalVelocityMps)
      .filter((v): v is number => v !== undefined && v > 0),
  );
  const anchorSessions = new Set(obs.anchors.map((a) => a.sessionBucket)).size;
  const anchorCount = obs.anchors.length;

  const shapeEstablished =
    obs.qualifyingSetCount >= BASELINE_THRESHOLDS.minShapeSets &&
    (obs.tempoCv === undefined || obs.tempoCv <= BASELINE_THRESHOLDS.maxShapeTempoCv);

  const out: BaselineDerivation = {
    state: 'COLD',
    confidence: 0,
    observedSessions: obs.observedSessions,
    anchorCount,
  };
  if (anchorSpread !== undefined) out.anchorSpread = anchorSpread;
  const lastAnchorAt = latestAnchorTimestamp(obs.anchors);
  if (lastAnchorAt !== undefined) out.lastAnchorAt = lastAnchorAt;
  if (obs.firstObservedAt !== undefined) out.firstObservedAt = obs.firstObservedAt;

  if (!shapeEstablished) return out;

  if (isStale(obs.lastObservedAt, now)) {
    out.state = 'STALE';
    out.confidence = 0.2;
    out.invalidatedAt = now.toISOString();
    out.invalidationReason = `no qualifying observation in ${BASELINE_THRESHOLDS.staleAfterDays}d`;
    return out;
  }

  const calibrated =
    anchorCount >= BASELINE_THRESHOLDS.minCalibratedAnchors &&
    anchorSessions >= BASELINE_THRESHOLDS.minCalibratedAnchorSessions &&
    anchorSpread !== undefined &&
    anchorSpread <= BASELINE_THRESHOLDS.maxCalibratedAnchorSpread;

  if (calibrated && anchorSpread !== undefined) {
    out.state = 'CALIBRATED';
    // 0.7 floor, plus up to 0.3 for how tightly the anchors agree.
    const agreement = 1 - anchorSpread / BASELINE_THRESHOLDS.maxCalibratedAnchorSpread;
    out.confidence = round2(0.7 + 0.3 * clamp01(agreement));
    return out;
  }
  if (anchorCount > 0) {
    out.state = 'PROVISIONAL';
    out.confidence = round2(0.4 + 0.1 * Math.min(anchorCount, 2));
    return out;
  }
  out.state = 'SHAPE_ONLY';
  // 0.2 floor, saturating at four distinct sessions of shape evidence.
  out.confidence = round2(0.2 + 0.2 * clamp01(obs.observedSessions / 4));
  return out;
}

/** Row id for a baseline key: WA's stable, percent-encoded, collision-free id. */
export function baselineRowId(key: BaselineKey): string {
  return baselineKeyId(key);
}

function latestAnchorTimestamp(anchors: AnchorObservation[]): string | undefined {
  return anchors.map((a) => a.observedAt).sort()[anchors.length - 1];
}

function isStale(lastObservedAt: string | undefined, now: Date): boolean {
  if (lastObservedAt === undefined) return false;
  const ageMs = now.getTime() - Date.parse(lastObservedAt);
  return ageMs > BASELINE_THRESHOLDS.staleAfterDays * 24 * 60 * 60 * 1000;
}

function meanRepDurationSec(reps: Rep[]): number | undefined {
  if (reps.length === 0) return undefined;
  const total = reps.reduce((sum, rep) => sum + getRepDuration(rep), 0);
  return total / reps.length;
}

/**
 * Sample coefficient of variation (SD / mean) — the unitless spread measure
 * both tempo consistency and anchor spread are expressed in, so one tolerance
 * reads the same across exercises and across velocity scales.
 *
 * `undefined` for fewer than two values (no spread is measurable) or a
 * non-positive mean (the ratio is meaningless).
 */
export function coefficientOfVariation(values: number[]): number | undefined {
  if (values.length < 2) return undefined;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean <= 0) return undefined;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance) / mean;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Assemble the row to persist from a key plus a derivation. */
export function toBaselineRow(
  key: BaselineKey,
  derived: BaselineDerivation,
  updatedAt: string,
): StoredExerciseBaseline {
  const out: StoredExerciseBaseline = {
    id: baselineRowId(key),
    userId: key.userId,
    exerciseId: key.exerciseId,
    state: derived.state,
    confidence: derived.confidence,
    observedSessions: derived.observedSessions,
    anchorCount: derived.anchorCount,
    updatedAt,
    algorithmVersion: BASELINE_ALGORITHM_VERSION,
  };
  if (key.setupId !== undefined) out.setupId = key.setupId;
  if (key.side !== undefined) out.side = key.side;
  if (derived.anchorSpread !== undefined) out.anchorSpread = derived.anchorSpread;
  if (derived.lastAnchorAt !== undefined) out.lastAnchorAt = derived.lastAnchorAt;
  if (derived.firstObservedAt !== undefined) out.firstObservedAt = derived.firstObservedAt;
  if (derived.invalidatedAt !== undefined) out.invalidatedAt = derived.invalidatedAt;
  if (derived.invalidationReason !== undefined) {
    out.invalidationReason = derived.invalidationReason;
  }
  return out;
}
