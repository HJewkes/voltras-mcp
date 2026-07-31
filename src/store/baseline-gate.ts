// Confidence-gated feature activation over `exercise_baselines` (VW-90 / B57).
//
// ADVISORY ONLY, NEVER BLOCKING.
// -----------------------------
// A gate verdict decides how loudly a feature may speak, not whether it runs.
// Features DEGRADE — a readiness ratio still ships without its zone label, an
// RIR read still ships flagged as rough — they never hard-block, throw, or
// vanish from a response. A user who has trained an exercise twice should see
// a hedged answer, not an empty screen: silence reads as breakage, whereas a
// hedge reads as honesty. Consumers that treat `withheld` as an error have
// misread this module.
//
// WHY THIS LIVES IN VMCP AND NOT IN `@voltras/workout-analytics`.
// --------------------------------------------------------------
// There is no analytics math here. Every function below is an enum-to-tier
// lookup over a persisted `state` — no reps are read, no velocities compared,
// nothing is derived from telemetry. More decisively, `BaselineState` is
// VMCP's own type, declared in `./types.js` and unknown to workout-analytics:
// the state machine that produces it (`./exercise-baselines.ts`) is a storage
// concern, so the policy that consumes it belongs on the same side of the
// boundary. Moving this into WA would mean exporting VMCP's persistence
// vocabulary into a package that has no business knowing it.
//
// `evaluable: false` IS NOT A FAILED GATE.
// ----------------------------------------
// It means no baseline row has ever been computed for this key — the state
// machine has never run here, so there is nothing to grade. That is different
// from `COLD`, which is a real, computed verdict of "observed, and the
// evidence is not there yet". The two produce the same `withheld` activation
// today but carry different reasoning, and a consumer that collapses them is
// telling the user "not enough data" when the truth is "we never looked".
//
// NO MCP TOOL WRAPS THIS.
// -----------------------
// In-process consumers (`metrics-tools.ts`'s `session.readiness`, and the RIR
// and relative-signal surfaces after it) import `checkFeatureGate` directly —
// the same precedent `drift-guard.ts` sets, where `checkDriftGuard` is the
// real interface and the tool is a diagnostic. The only wire exposure here is
// the `gates` block `baselines.get` already returns alongside the row.

import type { BaselineKey } from '@voltras/workout-analytics';

import type { BaselineState, SessionStore, StoredExerciseBaseline } from './types.js';

/** A feature whose activation is gated on baseline evidence. */
export type GatedFeature = 'relative-signal' | 'readiness-score' | 'rir-estimate';

/**
 * How loudly a feature may speak. `withheld` still means the surrounding
 * response ships — with the gated claim omitted, not the whole feature.
 */
export type GateActivation = 'full' | 'degraded' | 'withheld';

/** One feature's activation decision for one baseline key. */
export interface FeatureGateVerdict {
  feature: GatedFeature;
  /** `false` means no baseline row exists at all — see the header. */
  evaluable: boolean;
  activation: GateActivation;
  /** `null` only when there is no row to read a state from. */
  observedState: BaselineState | null;
  /**
   * Carried for transparency ONLY. Confidence never participates in a gating
   * decision: it is a coarse ordering scalar, not a probability, and
   * `StoredExerciseBaseline` says in as many words not to do arithmetic with
   * it. Gating is state-only.
   */
  confidence: number | null;
  requiredState: BaselineState;
  /** Internal-facing. Explains the decision for logs and debugging. */
  reasoning: string;
  /** User-facing. Safe to surface verbatim. */
  userMessage: string;
  /** When the baseline went stale; present only for a STALE row that recorded it. */
  staleSince?: string;
}

/**
 * Ordering over baseline tiers. `STALE` deliberately ranks WITH `SHAPE_ONLY`:
 * a stale baseline still describes the movement's shape, it just has no recent
 * vouching. See `deriveFeatureGate` for the extra cap that keeps a stale row
 * out of `full` regardless of rank.
 */
export const BASELINE_STATE_RANK: Record<BaselineState, number> = {
  COLD: 0,
  STALE: 1,
  SHAPE_ONLY: 1,
  PROVISIONAL: 2,
  CALIBRATED: 3,
};

/**
 * Evidence each feature needs, at each volume.
 *
 * - `relative-signal` (velocity loss %, ROM decline) is honest the moment the
 *   movement shape is known — it compares a set to itself, not to a failure
 *   anchor.
 * - `readiness-score` shows its ratio from `SHAPE_ONLY`, but the ZONE LABEL is
 *   an assertion about where this user sits relative to their own norm, which
 *   only a calibrated baseline supports.
 * - `rir-estimate` is phrased in reps to failure, so it needs failure anchors:
 *   rough from `PROVISIONAL`, stated plainly only from `CALIBRATED`.
 */
export const FEATURE_GATE_REQUIREMENTS: Record<
  GatedFeature,
  { full: BaselineState; degraded: BaselineState }
> = {
  'relative-signal': { full: 'SHAPE_ONLY', degraded: 'SHAPE_ONLY' },
  'readiness-score': { full: 'CALIBRATED', degraded: 'SHAPE_ONLY' },
  'rir-estimate': { full: 'CALIBRATED', degraded: 'PROVISIONAL' },
};

/** Every gated feature, in declaration order. */
const GATED_FEATURES: readonly GatedFeature[] = Object.keys(
  FEATURE_GATE_REQUIREMENTS,
) as GatedFeature[];

const NO_BASELINE_MESSAGE = 'still learning this exercise — no baseline yet';

/**
 * User-facing copy per state, deliberately FEATURE-AGNOSTIC: what the user
 * needs to know is how well we know their exercise, which does not change
 * based on which readout happened to ask.
 */
const STATE_MESSAGES: Record<BaselineState, string> = {
  COLD: 'still learning this exercise — not enough consistent sets yet',
  SHAPE_ONLY: 'learning this exercise — movement shape known, no failure reference yet',
  PROVISIONAL: 'early baseline — treat this as a rough read',
  CALIBRATED: 'baseline calibrated',
  STALE: 'baseline is out of date — no qualifying set in the last 28 days',
};

/**
 * Grade one feature against one baseline row.
 *
 * `baseline === undefined` is the never-computed case: inconclusive, not an
 * error, and never a throw.
 */
export function deriveFeatureGate(
  baseline: StoredExerciseBaseline | undefined,
  feature: GatedFeature,
): FeatureGateVerdict {
  const requirements = FEATURE_GATE_REQUIREMENTS[feature];
  const requiredState = requirements.full;

  if (baseline === undefined) {
    return {
      feature,
      evaluable: false,
      activation: 'withheld',
      observedState: null,
      confidence: null,
      requiredState,
      reasoning: `${feature} requires ${requiredState}; no baseline row has ever been computed for this key, so there is no state to grade`,
      userMessage: NO_BASELINE_MESSAGE,
    };
  }

  const observedState = baseline.state;
  const rank = BASELINE_STATE_RANK[observedState];
  const fullRank = BASELINE_STATE_RANK[requiredState];
  const degradedRank = BASELINE_STATE_RANK[requirements.degraded];

  const earned: GateActivation =
    rank >= fullRank ? 'full' : rank >= degradedRank ? 'degraded' : 'withheld';

  // A stale baseline is not wrong, it is unvouched-for: it may still inform,
  // but it never speaks at full confidence, whatever its rank would allow.
  const stale = observedState === 'STALE';
  const activation: GateActivation = stale && earned === 'full' ? 'degraded' : earned;

  const verdict: FeatureGateVerdict = {
    feature,
    evaluable: true,
    activation,
    observedState,
    confidence: baseline.confidence ?? null,
    requiredState,
    reasoning: explain(feature, observedState, rank, requiredState, fullRank, activation, stale),
    userMessage: STATE_MESSAGES[observedState],
  };
  if (stale && baseline.invalidatedAt !== undefined) {
    verdict.staleSince = baseline.invalidatedAt;
  }
  return verdict;
}

/** Load the key's row and grade one feature against it. */
export async function checkFeatureGate(
  store: Pick<SessionStore, 'getBaseline'>,
  key: BaselineKey,
  feature: GatedFeature,
): Promise<FeatureGateVerdict> {
  const baseline = await store.getBaseline(key);
  return deriveFeatureGate(baseline, feature);
}

/** Grade every gated feature against one row — what `baselines.get` returns. */
export function deriveAllFeatureGates(
  baseline: StoredExerciseBaseline | undefined,
): Record<GatedFeature, FeatureGateVerdict> {
  const out = {} as Record<GatedFeature, FeatureGateVerdict>;
  for (const feature of GATED_FEATURES) {
    out[feature] = deriveFeatureGate(baseline, feature);
  }
  return out;
}

/**
 * The feature-agnostic user-facing summary for a row: "how well do we know
 * this exercise", with no feature in the question.
 */
export function describeBaselineState(baseline: StoredExerciseBaseline | undefined): string {
  if (baseline === undefined) return NO_BASELINE_MESSAGE;
  return STATE_MESSAGES[baseline.state];
}

function explain(
  feature: GatedFeature,
  observedState: BaselineState,
  rank: number,
  requiredState: BaselineState,
  fullRank: number,
  activation: GateActivation,
  stale: boolean,
): string {
  const head =
    `${feature} requires ${requiredState} (rank ${String(fullRank)}); ` +
    `observed state is ${observedState} (rank ${String(rank)})`;
  if (stale && activation === 'degraded' && rank >= fullRank) {
    return `${head}; capped at degraded because a STALE baseline is unvouched-for and never speaks at full confidence`;
  }
  switch (activation) {
    case 'full':
      return `${head}; full because the observed state meets the requirement`;
    case 'degraded':
      return `${head}; degraded because ${observedState} meets the degraded threshold for this feature but not the full one`;
    case 'withheld':
      return `${head}; withheld because ${observedState} is below even the degraded threshold (${FEATURE_GATE_REQUIREMENTS[feature].degraded}) for this feature`;
  }
}
