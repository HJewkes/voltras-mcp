// `metrics.compute` — Wave 3C dispatcher (Task 12).
//
// One MCP tool, one zod discriminated union, nine pipelines, nine distinct
// `@voltras/workout-analytics` functions. The handler's only jobs are:
//
//   1. Fetch the targeted persistence rows (`getSet`, `getSetsForSession`).
//   2. Adapt the storage shape to the analytics function's input shape
//      (always pure plumbing — no rep math here).
//   3. Dispatch to the analytics function.
//
// Per AC-20: zero analytics computation logic lives here. Per EC-07: a missing
// target id short-circuits to a `NOT_FOUND` error result before any analytics
// function is invoked.
//
// ── `vbt.set` resolution (briefing Step 1) ────────────────────────────────
//
// `@voltras/workout-analytics@0.2.0` exposes `getSetVelocitySummary(set)`
// returning `{ first, last, best, mean, peak, lossPct, repCount }` — the
// canonical "single-set VBT result" the schema's `vbt.set` literal points
// at. The schema's `PENDING` comment is satisfied by binding `vbt.set` to
// `getSetVelocitySummary`. No schema change required.
//
// ── Status of all 9 pipelines ──────────────────────────────────────────────
//
// All 9 pipelines below are fully implemented and merged (`quality.rep`,
// `session.readiness` and `vbt.rir` included) — see the `compute()` switch
// below. An earlier revision of this file marked the first two
// `NOT_IMPLEMENTED`; that was stale by the time this comment was written and
// has been corrected. Do not trust a "not implemented" claim about this tool
// without reading the switch statement.
//
// `quality.rep` derives its `TechniqueBaseline` from a caller-supplied
// `baselineSetId` (a real prior set, not an invented target) — the handler
// is the policy layer that turns "a set" into a `TechniqueBaseline`; the
// analytics package owns the per-rep comparison logic.
//
// `session.readiness` resolves `actualVelocity`/`baselineVelocity` from the
// first-rep concentric velocity of each session's first set OF THE SESSION'S
// OWN EXERCISE — see `setsForSessionExercise`. Baseline-confidence gating
// (B57/VW-90, PR #232) LANDED 2026-08-11: below CALIBRATED the readiness zone
// is withheld while the raw observed velocities still ship. `vbt.rir` (VW-134)
// is gated the same way, on the `rir-estimate` feature.
//
// GATES DEGRADE, THEY NEVER BLOCK. A `withheld` activation hedges a claim; it
// does not empty the response. See `store/baseline-gate.ts`'s header.

import {
  assessRepQuality,
  buildProfile,
  computeReadiness,
  estimateLoad,
  type LoadVelocityProfile,
  computeSessionFatigue,
  computeStrengthEstimate,
  computeVBTSetFatigueIndex,
  computeVolume,
  createTechniqueBaseline,
  estimateRIRWithProfile,
  getPhaseDuration,
  getPhaseRangeOfMotion,
  getRepMeanVelocity,
  getRepPeakVelocity,
  getSetFatigueIndex,
  getSetFirstRepVelocity,
  getSetMeanVelocity,
  getSetVelocitySummary,
  type LoadVelocityDataPoint,
  type ReadinessEstimate,
  type Rep as AnalyticsRep,
  type Set as AnalyticsSet,
} from '@voltras/workout-analytics';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MetricsComputeInput } from '../schemas/metrics.js';
import type { ServerState } from '../state/server-state.js';
import {
  checkFeatureGate,
  deriveFeatureGate,
  type FeatureGateVerdict,
} from '../store/baseline-gate.js';
import {
  RIR_MODEL_CALIBRATION_CONFIDENCE,
  rirInputDomainConfidence,
  type ConfidenceIndicator,
} from '../store/confidence-indicator.js';
import { scopeSessionSetsToExerciseId } from '../store/set-scope.js';
import { LOCAL_USER_ID, type StoredSet, type StoredSide } from '../store/types.js';
import { errorResult, textResult, wrapHandler, type ToolResult } from './helpers.js';

type MetricsComputeInputType = z.infer<typeof MetricsComputeInput>;

const TOOL_NAME = 'metrics.compute';

/**
 * Coerce a `StoredSet` row into the `Set` shape the analytics package
 * consumes. `StoredRep extends Rep` (compile-time guard in `store/types.ts`)
 * means the rep array passes through untouched; the `loadSettings` field is
 * intentionally omitted because session-level callers pass weights as a
 * parallel array argument.
 */
function toAnalyticsSet(stored: StoredSet): AnalyticsSet {
  return { reps: stored.reps };
}

/**
 * Build the parallel `weights` array the session-level analytics functions
 * accept, sourced from each `StoredSet.weightLbs`.
 */
function weightsOf(sets: readonly StoredSet[]): number[] {
  // 0 for a set with no recorded weight. This is a COMPUTE boundary, not a
  // storage one: the analytics functions take a weights array positionally
  // aligned with `sets`, so dropping an entry would silently shift every later
  // set's load onto the wrong set. A 0 contributes no volume and no strength
  // estimate — the same result the pre-v6 sentinel produced — while the stored
  // row keeps the gap.
  return sets.map((s) => s.weightLbs ?? 0);
}

/**
 * A session's sets narrowed to ONE exercise — the session's own — by each set's
 * own `exerciseId`.
 *
 * The session-level pipelines below compare sets against each other: velocity
 * decay across the session, a single e1RM, a first-rep readiness velocity. Each
 * of those comparisons is only meaningful within one movement, and none of the
 * inputs carries an exercise to scope by, so the session's exercise is the one
 * available key. `session.volume` deliberately does NOT use this: tonnage
 * across a whole session is a defensible session-level number, and narrowing it
 * is a product decision nobody has made (VMCP-01.72).
 */
async function setsForSessionExercise(state: ServerState, sessionId: string): Promise<StoredSet[]> {
  const sets = await state.store.getSetsForSession(sessionId);
  const session = await state.store.getSession(sessionId);
  return scopeSessionSetsToExerciseId(sets, session?.exerciseId);
}

/**
 * Dispatch core. Returns either the analytics function's output (which
 * `wrapHandler` wraps in `textResult`) or a `ToolResult` error directly when
 * a pre-dispatch guard fails. Throwing a tagged error lets `wrapHandler`'s
 * existing `mapSdkError` path produce the structured `errorResult` for us
 * without a second control-flow channel.
 */
async function compute(state: ServerState, input: MetricsComputeInputType): Promise<unknown> {
  switch (input.pipeline) {
    case 'vbt.set': {
      const set = await state.store.getSet(input.setId);
      if (!set) throw notFound(`set '${input.setId}' not found`);
      return getSetVelocitySummary(toAnalyticsSet(set));
    }

    case 'vbt.profile': {
      const sets = await Promise.all(input.setIds.map((id: string) => state.store.getSet(id)));
      const missingIdx = sets.findIndex((s) => s === undefined);
      if (missingIdx >= 0) {
        throw notFound(`set '${input.setIds[missingIdx]}' not found`);
      }
      const points: LoadVelocityDataPoint[] = (sets as StoredSet[]).map((s) => ({
        load: s.weightLbs,
        velocity: getSetMeanVelocity(toAnalyticsSet(s)),
      }));
      const profile = buildProfile(points);
      if (input.targetVelocity === undefined) return profile;
      return { ...profile, recommendation: recommendLoad(profile, input.targetVelocity) };
    }

    case 'fatigue.set': {
      const set = await state.store.getSet(input.setId);
      if (!set) throw notFound(`set '${input.setId}' not found`);
      return getSetFatigueIndex(toAnalyticsSet(set));
    }

    case 'vbt.rir': {
      const set = await state.store.getSet(input.setId);
      if (!set) throw notFound(`set '${input.setId}' not found`);
      if (set.reps.length === 0) throw notFound(`set '${input.setId}' has no reps`);
      return rirForSet(state, set, input.targetReps);
    }

    case 'session.volume': {
      // Whole-session tonnage, ON PURPOSE — NOT narrowed to one exercise the
      // way the pipelines below are. See `setsForSessionExercise`.
      const sets = await state.store.getSetsForSession(input.sessionId);
      if (sets.length === 0) throw notFound(`session '${input.sessionId}' has no sets`);
      return computeVolume(sets.map(toAnalyticsSet), weightsOf(sets));
    }

    case 'session.fatigue': {
      const sets = await setsForSessionExercise(state, input.sessionId);
      if (sets.length === 0) throw notFound(`session '${input.sessionId}' has no sets`);
      const analyticsSets = sets.map(toAnalyticsSet);
      const crossSet = computeSessionFatigue(analyticsSets, weightsOf(sets));
      // VMCP-02.26: computeSessionFatigue measures CROSS-set decay only
      // (velocity recovery + rep drop between sets), so a single working set —
      // even one taken to functional failure — reports level 0. Fold in the
      // per-set WITHIN-set fatigue index (VBT spec §6.2: velocity loss + tempo
      // creep + ROM shrink) so a hard single set surfaces real fatigue. Report
      // `level` as the max of the two views: cross-set decay dominates
      // multi-set sessions; within-set fatigue rescues the low-set-count case.
      // `withinSetFatigue` is surfaced alongside for transparency.
      const withinSetPerSet = analyticsSets.map((s) => computeVBTSetFatigueIndex(s).fatigueIndex);
      const withinSetMax = withinSetPerSet.length === 0 ? 0 : Math.max(...withinSetPerSet);
      return {
        ...crossSet,
        level: Math.max(crossSet.level, withinSetMax),
        withinSetFatigue: { max: withinSetMax, perSet: withinSetPerSet },
      };
    }

    case 'session.strength': {
      const sets = await setsForSessionExercise(state, input.sessionId);
      if (sets.length === 0) throw notFound(`session '${input.sessionId}' has no sets`);
      return computeStrengthEstimate(sets.map(toAnalyticsSet), weightsOf(sets));
    }

    case 'quality.rep': {
      const target = await state.store.getSet(input.setId);
      if (!target) throw notFound(`set '${input.setId}' not found`);
      const baseline = await state.store.getSet(input.baselineSetId);
      if (!baseline) throw notFound(`baseline set '${input.baselineSetId}' not found`);
      if (baseline.reps.length === 0) {
        throw notFound(`baseline set '${input.baselineSetId}' has no reps`);
      }
      // Average ROM, eccentric/concentric duration, and concentric mean
      // velocity across the baseline set's reps. The handler is the policy
      // layer that turns "a set" into a TechniqueBaseline; the analytics
      // package owns the per-rep comparison logic.
      const baselineRom = mean(baseline.reps.map((r) => getPhaseRangeOfMotion(r.concentric)));
      const baselineEccTime = mean(baseline.reps.map((r) => getPhaseDuration(r.eccentric)));
      const baselineConcTime = mean(baseline.reps.map((r) => getPhaseDuration(r.concentric)));
      const baselineMeanVel = mean(baseline.reps.map((r) => getRepMeanVelocity(r)));
      const technique = createTechniqueBaseline({
        rom: baselineRom,
        eccentricTime: baselineEccTime,
        concentricTime: baselineConcTime,
        meanVelocity: baselineMeanVel,
      });
      return target.reps.map((rep) => assessRepQuality(rep, technique));
    }

    case 'session.readiness': {
      const target = await setsForSessionExercise(state, input.sessionId);
      if (target.length === 0) throw notFound(`session '${input.sessionId}' has no sets`);
      const baseline = await setsForSessionExercise(state, input.baselineSessionId);
      if (baseline.length === 0) {
        throw notFound(`baseline session '${input.baselineSessionId}' has no sets`);
      }
      // Per the analytics signature: actualVelocity = the first-rep concentric
      // velocity of the current session's first set OF ITS EXERCISE;
      // baselineVelocity = the same metric from the baseline session. This pins
      // both values to a directly comparable measurement (the first rep is
      // canonical for "fresh" velocity).
      const actualVel = getSetFirstRepVelocity(toAnalyticsSet(target[0]!));
      const baselineVel = getSetFirstRepVelocity(toAnalyticsSet(baseline[0]!));
      const observed = { actualVelocityMps: actualVel, baselineVelocityMps: baselineVel };

      // B57: a readiness ZONE is an assertion about where this lifter sits
      // against their own norm, and it is only supportable once the exercise
      // baseline is calibrated. The raw velocities are measurements and always
      // ship; the interpreted estimate is what the gate withholds.
      const gate = await readinessGate(state, input.baselineSessionId, [...target, ...baseline]);
      const result: GatedReadinessResult = {
        readiness: gate.activation === 'withheld' ? null : computeReadiness(actualVel, baselineVel),
        observed,
        gate,
      };
      return result;
    }
  }
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * `session.readiness`'s response (B57).
 *
 * `readiness` is `null` when the gate withholds — the pipeline still answers,
 * it just declines to interpret. `observed` carries the two velocities either
 * way: those are measurements, not claims, and a caller that wants to show a
 * bare ratio is entitled to them at any baseline tier.
 */
interface GatedReadinessResult {
  readiness: ReadinessEstimate | null;
  observed: { actualVelocityMps: number; baselineVelocityMps: number };
  gate: FeatureGateVerdict;
}

/**
 * The side to key the baseline on, or `undefined` for the side-agnostic pooled
 * key. Only names a side when every scoped set agrees on one: a per-side
 * baseline and a pooled one are different measurement streams, and reading a
 * left-side baseline to grade a mixed comparison mixes them (see
 * `recalcBaselineForSet` in set-tools.ts, which makes the same call at write
 * time). Sets that recorded no side at all leave the key pooled.
 */
function resolveKeySide(sets: readonly StoredSet[]): StoredSide | undefined {
  let seen: StoredSide | undefined;
  for (const set of sets) {
    if (set.side === undefined) return undefined;
    if (seen === undefined) {
      seen = set.side;
      continue;
    }
    if (set.side !== seen) return undefined;
  }
  return seen;
}

/**
 * Grade the readiness feature against the baseline session's exercise.
 *
 * A baseline session with no `exerciseId` is INCONCLUSIVE, not an error: there
 * is no key to look a baseline up under, so the verdict is the same
 * never-computed `withheld` a missing row produces. Throwing here would turn a
 * hedge into a failure, which is exactly what an advisory gate must not do.
 */
async function readinessGate(
  state: ServerState,
  baselineSessionId: string,
  comparedSets: readonly StoredSet[],
): Promise<FeatureGateVerdict> {
  const baselineSession = await state.store.getSession(baselineSessionId);
  const exerciseId = baselineSession?.exerciseId;
  if (exerciseId === undefined) return deriveFeatureGate(undefined, 'readiness-score');

  const side = resolveKeySide(comparedSets);
  return checkFeatureGate(
    state.store,
    { userId: LOCAL_USER_ID, exerciseId, ...(side !== undefined ? { side } : {}) },
    'readiness-score',
  );
}

/**
 * One rep's RIR estimate, with the inputs the regression actually saw.
 *
 * Restates `ExerciseRIREstimate`'s fields rather than extending it: under
 * NodeNext resolution the package's `.d.ts` types degrade to `any` here, so
 * `extends ExerciseRIREstimate` silently contributes NO members and every
 * inherited field reads as a type error at the use site. Spelling them out
 * keeps this shape checked.
 */
interface RepRIREstimate {
  /** Point estimate, clamped to >= 0. */
  rir: number;
  /** 95% CI band from the profile's stderr, half-rep resolution. */
  range: { low: number; high: number };
  /** Analytics' own grade of how far the inputs sit from the fitted range. */
  confidence: 'low' | 'medium' | 'high';
  /** 1-indexed rep number within the set. */
  repIndex: number;
  /**
   * This rep's peak concentric velocity, in whatever unit the persisted
   * samples carry — device-native mm/s today, NOT m/s (see `rirForSet`).
   * Reported for transparency about what the model was fed; do not render it
   * as a speed without converting.
   */
  peakVelocity: number;
  /** Loss from the set's fastest rep to this one (%), PEAK-based. See `rirForSet`. */
  velocityLossPct: number;
}

/**
 * `vbt.rir`'s response (VW-134).
 *
 * THREE CONFIDENCE AXES, NAMED AND SEPARATE (VW-151). They answer different
 * questions and are never merged into a single score:
 *   - `modelCalibration` — is the MODEL trustworthy? Always `low`; the shipped
 *     coefficients are placeholders. Identical for every user and every set.
 *   - `inputDomain` — is THIS REP inside the model's fitted range? Varies per
 *     rep; taken from workout-analytics' own per-estimate grade.
 *   - `baselineMaturity` — do we know THIS USER on THIS EXERCISE well enough
 *     to interpret the number? B57's verdict, unchanged.
 *
 * Per B57's advisory-only rule the estimate SHIPS at every gate activation —
 * `baselineMaturity.activation === 'withheld'` hedges the reading, it does not
 * blank it. Silence reads as breakage; a hedge reads as honesty.
 */
interface SetRIRResult {
  /** The set's final rep — the "how much did you leave in the tank" headline. */
  final: RepRIREstimate;
  /** Every rep's estimate, so a caller can see the trajectory, not just the end. */
  perRep: RepRIREstimate[];
  /** The fastest rep's peak velocity — the ratio's denominator, same unit as `peakVelocity`. */
  baselineMaxVelocity: number;
  /** What the model was told the set's length was, and whether that was supplied. */
  repsInSet: { value: number; source: 'targetReps' | 'actualRepCount' };
  confidence: {
    modelCalibration: ConfidenceIndicator;
    inputDomain: ConfidenceIndicator;
    baselineMaturity: FeatureGateVerdict;
  };
}

/**
 * Per-rep RIR across one recorded set.
 *
 * BASELINE VELOCITY IS THE SET'S FASTEST REP, NOT REP 1. The model asks for
 * "baseline max velocity from the first reps of the set", but rep 1 on this
 * hardware is routinely a cable-engagement artifact with a tiny ROM and a
 * meaninglessly low velocity — anchoring on it inflates every subsequent
 * v_ratio. Substituting the set's peak rep is the same workaround
 * `peakConcentricBaseline` already applies elsewhere in this server.
 *
 * VELOCITY UNITS ARE NOT m/s. `WorkoutSample.velocity` is documented by
 * workout-analytics as m/s, but this server's bridge converts position
 * (mm->m) and force (tenths->lb) and passes velocity through RAW
 * (`event-bridge.ts`: `velocity: frame.velocity`, with the SSE tap below it
 * calling `mmsToMps` precisely because the value is still mm/s). Every
 * absolute velocity in the store is therefore ~1000x its documented unit.
 * THE RIR ESTIMATE IS UNAFFECTED: the model consumes `peakVelocity /
 * baselineMaxVelocity` and a percentage loss, both scale-invariant, so a
 * consistent unit error cancels. The raw figures are surfaced under
 * unit-neutral names rather than a false `...Mps`. Tracked as VW-160.
 *
 * VELOCITY LOSS HERE IS PEAK-BASED, AND WILL NOT MATCH `vbt.set`. That
 * pipeline reports the canonical MEAN-concentric loss (VW-62). This one feeds
 * a regression whose `peakVelocity` / `baselineMaxVelocity` terms are both
 * peaks, so its loss term has to be on the same basis or the model is fed
 * mixed units. Two different numbers, both correct for their own question.
 */
async function rirForSet(
  state: ServerState,
  set: StoredSet,
  targetReps: number | undefined,
): Promise<SetRIRResult> {
  const analyticsSet = toAnalyticsSet(set);
  // `reps` degrades to `any[]` through the package's .d.ts here, so the
  // element type is annotated explicitly rather than inferred.
  const peaks: number[] = analyticsSet.reps.map((rep: AnalyticsRep) => getRepPeakVelocity(rep));
  const baselineMax = Math.max(...peaks);
  const repsInSet = targetReps ?? peaks.length;

  const perRep: RepRIREstimate[] = peaks.map((peak: number, i: number) => {
    // Clamped at 0: a rep faster than the set's fastest is impossible by
    // construction here, but a 0 baseline (a set that never moved) would
    // otherwise produce a negative or non-finite loss.
    const velocityLossPct =
      baselineMax > 0 ? Math.max(0, ((baselineMax - peak) / baselineMax) * 100) : 0;
    const estimate = estimateRIRWithProfile({
      peakVelocity: peak,
      baselineMaxVelocity: baselineMax,
      velLossPct: velocityLossPct,
      repIndex: i + 1,
      repsInSet,
    });
    return { ...estimate, repIndex: i + 1, peakVelocity: peak, velocityLossPct };
  });

  const final = perRep[perRep.length - 1]!;
  return {
    final,
    perRep,
    baselineMaxVelocity: baselineMax,
    repsInSet: {
      value: repsInSet,
      source: targetReps === undefined ? 'actualRepCount' : 'targetReps',
    },
    confidence: {
      modelCalibration: RIR_MODEL_CALIBRATION_CONFIDENCE,
      // The headline number is the final rep's, so the input-domain axis grades
      // that same rep — a per-rep axis on a per-rep value.
      inputDomain: rirInputDomainConfidence(final.confidence),
      baselineMaturity: await rirGate(state, set),
    },
  };
}

/**
 * Grade the RIR feature for the set's own exercise. A set with no `exerciseId`
 * has no baseline key to look up, which is `evaluable: false` ("we never
 * looked") rather than a failed gate ("we looked and it's thin").
 */
async function rirGate(state: ServerState, set: StoredSet): Promise<FeatureGateVerdict> {
  if (set.exerciseId === undefined) return deriveFeatureGate(undefined, 'rir-estimate');
  return checkFeatureGate(
    state.store,
    {
      userId: LOCAL_USER_ID,
      exerciseId: set.exerciseId,
      ...(set.side !== undefined ? { side: set.side } : {}),
    },
    'rir-estimate',
  );
}

/** Load recommendation derived by inverting a load-velocity profile. */
interface LoadRecommendation {
  /** The target mean concentric velocity the load was solved for (m/s). */
  targetVelocity: number;
  /** Recommended load in lb for that velocity (clamped ≥ 0 upstream). */
  recommendedLoad: number;
  /** The parent profile's fit confidence, surfaced so callers can weigh it. */
  confidence: LoadVelocityProfile['confidence'];
}

/**
 * Invert a fitted profile to the load for `targetVelocity`. A flat profile
 * (slope 0 — e.g. every observed set moved at the same velocity) is
 * non-invertible: `estimateLoad` returns a meaningless 0, so we report an
 * honest `null` instead of a fabricated load. Confidence rides along so a
 * low-R² fit is never mistaken for a trustworthy prescription.
 */
function recommendLoad(
  profile: LoadVelocityProfile,
  targetVelocity: number,
): LoadRecommendation | null {
  if (profile.slope === 0 || !Number.isFinite(profile.slope)) return null;
  const recommendedLoad = estimateLoad(profile, targetVelocity);
  if (!Number.isFinite(recommendedLoad)) return null;
  return { targetVelocity, recommendedLoad, confidence: profile.confidence };
}

class CodedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CodedError';
    this.code = code;
  }
}
const notFound = (msg: string): CodedError => new CodedError('NOT_FOUND', msg);

/**
 * Hot-swap the placeholder `metrics.compute` callback installed at server
 * startup with the live dispatcher. Mirrors the pattern Wave 1 documented
 * in `server.ts` and `state/server-state.ts`.
 */
const METRICS_COMPUTE_DESCRIPTION =
  'Compute a VBT/analytics result for a set or session. Dispatches on the required `pipeline` ' +
  'field (one of 9 literals) to a single `@voltras/workout-analytics` function; each pipeline ' +
  'takes different input fields, all optional at the schema level but required per-pipeline: ' +
  '`vbt.set` (setId) — single-set velocity summary (first/last/best/mean/peak/lossPct/repCount). ' +
  '`vbt.profile` (setIds[], optional targetVelocity) — fits a load-velocity profile across sets ' +
  'and, if targetVelocity is given, inverts it to a recommended load + confidence (null if the ' +
  'fit is flat/non-invertible — never a fabricated number). ' +
  '`fatigue.set` (setId) — within-set fatigue index for one set. ' +
  '`vbt.rir` (setId, optional targetReps) — per-rep reps-in-reserve from the VBT §5.3 ' +
  'regression, plus the final rep as the headline. Carries THREE separately named confidence ' +
  'axes and never a bare number: model-calibration (always low — the coefficients are ' +
  'placeholders pending real-device calibration), input-domain (is this rep inside the fitted ' +
  'range), and baseline-maturity (B57). Relay the estimate WITH its caveats; do not present it ' +
  'as a precise rep count. Its velocity loss is peak-based by model contract and will not equal ' +
  "`vbt.set`'s mean-based lossPct. " +
  '`session.volume` (sessionId) — whole-session tonnage, deliberately NOT narrowed to one ' +
  'exercise (a session may span several). ' +
  "`session.fatigue` (sessionId) — cross-set fatigue decay for the session's own exercise, " +
  'folded with within-set fatigue so a single hard set still reads as fatigued. ' +
  "`session.strength` (sessionId) — session-level strength estimate for the session's own " +
  'exercise. ' +
  '`quality.rep` (setId, baselineSetId) — per-rep technique quality against a caller-supplied ' +
  'baseline set (a real prior set, not an invented target). ' +
  '`session.readiness` (sessionId, baselineSessionId) — compares first-rep velocity between two ' +
  'sessions of the same exercise; treat the result as provisional unless the exercise baseline ' +
  'is CALIBRATED (see `baselines.get`). ' +
  'A missing/nonexistent target id returns a NOT_FOUND error before any analytics runs.';

export function registerMetricsTools(
  server: McpServer,
  state: ServerState,
  placeholders: Map<string, RegisteredTool>,
): void {
  void server; // `tool()` is only called via the placeholder's `update`.
  const placeholder = placeholders.get(TOOL_NAME);
  if (!placeholder) {
    throw new Error(`registerMetricsTools: missing '${TOOL_NAME}' placeholder`);
  }
  const handler: (args: unknown, extra?: unknown) => Promise<ToolResult> = wrapHandler(
    MetricsComputeInput,
    (input) => compute(state, input),
  );
  // `paramsSchema` paired with `callback`: bootstrap placeholders carry an
  // empty-object schema that strips required input fields. The MCP SDK's
  // `update.paramsSchema` only accepts a `ZodRawShape` (key-to-type map), not
  // a discriminated union, so we declare the loose superset of every variant's
  // fields here. `wrapHandler(MetricsComputeInput, ...)` does the strict
  // discriminated-union validation inside the callback — this shape exists
  // only to keep the SDK from stripping legitimate args.
  const looseShape = {
    pipeline: z.string(),
    setId: z.string().optional(),
    setIds: z.array(z.string()).optional(),
    targetVelocity: z.number().optional(),
    sessionId: z.string().optional(),
    baselineSetId: z.string().optional(),
    baselineSessionId: z.string().optional(),
  };
  placeholder.update({
    paramsSchema: looseShape,
    callback: handler as never,
    description: METRICS_COMPUTE_DESCRIPTION,
  } as never);
}

// `errorResult` and `textResult` are referenced indirectly via `wrapHandler`
// and the `CodedError` → `mapSdkError` path; explicit re-export keeps the
// dependency graph obvious to downstream readers.
export const _internal = { errorResult, textResult };
