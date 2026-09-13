// `isometric.measure_hold`, `isometric.measure_max` and
// `isometric.measure_imbalance` tools.
//
// These tools drive the isometric assessment protocol against a connected
// Voltra device (or pair of devices for the bilateral imbalance flow). The
// pure analysis math lives in `src/state/isometric-protocol.ts`; this module
// owns the protocol orchestration: subscribe to the SDK's `onFrame` telemetry
// stream for each hold window, accumulate samples, rest between trials, and
// assemble the response.
//
// `captureSingleHold` is the one unit all three share: one hold, one analysis,
// four `isometric_phase` pushes. `measure_hold` calls it once and returns;
// `measure_max` and `measure_imbalance` loop it with the protocol rests.
//
// Every wait — the hold window, the between-trial rest, the between-sides rest
// — runs under a lease fence (VW-200), so a steal aborts the assessment with
// `LEASE_LOST` instead of measuring on through it. See `withLeaseFence`.
//
// Telemetry subscription pattern:
//
// For each trial we call `client.onFrame(listener)`, which returns an
// unsubscribe handle. The listener pushes a `{ tMs, forceLbs }` sample into
// a per-trial buffer. After `durationMs` we call the unsubscribe handle in
// a `finally` so the listener is always removed even on error / cancel
// paths. The SDK's `TelemetryFrame.force` is in tenths of a pound (positive
// concentric, negative eccentric); we convert to pounds and take the absolute
// value because the isometric protocol only cares about magnitude of the pull.
//
// Why push (subscribe) over pull (polling `live.snapshotDeviceState`):
//   * The SDK fires `onFrame` per BLE notification (~11 Hz); polling at a
//     lower cadence would lose peak detail.
//   * The pure-data buffer makes the analysis layer trivially testable —
//     synthetic samples flow through `analyzeTrial` exactly the way real
//     SDK frames do.
//
// Resistance during measurement: the brief specifies 0 lb at the cable so
// the cell measures the user's pull directly. The SDK's `setWeight` clamps
// at 5 lb minimum, so this tool does NOT auto-set the weight — the caller
// is responsible for pre-configuring the device into Isometric mode (or
// any low-resistance mode) before calling. The tool comment in the
// description nudges callers toward that workflow. Open question 1 in the
// brief flags this for hardware validation.

import { randomUUID } from 'node:crypto';

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TelemetryFrame } from '@voltras/node-sdk';
import type { z } from 'zod';

import { log } from '../logger.js';
import {
  LOCAL_USER_ID,
  type IsometricMeasurementHistory,
  type StoredIsometricMeasurement,
  type StoredIsometricSideMeasurement,
} from '../store/types.js';
import { setMedianRomM } from '../store/exercise-setups.js';
import {
  compareSetupSignatures,
  medianRomMetres,
  type SetupComparability,
  type SetupComparabilityVerdict,
  type SetupSignature,
} from '../analytics/setup-comparability.js';

import {
  IsometricMeasureHoldInput,
  IsometricMeasureMaxInput,
  IsometricMeasureImbalanceInput,
  IsometricMeasureImbalanceInputRefined,
  DEFAULT_MAX_REST_MS,
  WARMUP_EFFORT_LEVELS,
} from '../schemas/isometric.js';
import { type ServerState, PRIMARY_SLOT, getSlot } from '../state/server-state.js';
import { FRAME_FORCE_TENTHS_PER_LB } from '../state/live-signal.js';
import {
  aggregateSide,
  analyzeTrial,
  asymmetryEquationFor,
  ASYMMETRY_EQUATION,
  computeImbalance,
  computePeakForceBaseline,
  decideTestOrder,
  directionOfMeasurement,
  evaluateJointAngleGate,
  evaluatePeakForceChange,
  occasionPeakForcesLbs,
  summarizeDirectionHistory,
  PEAK_AFTER_MS,
  JOINT_ANGLE_MISMATCH_THRESHOLD_DEG,
  type AsymmetryEquation,
  type DirectionHistory,
  type ForceSample,
  type JointAngleGateVerdict,
  type PeakForceBaseline,
  type PeakForceChangeVerdict,
  type SideAnalysis,
  type TrialAnalysis,
} from '../state/isometric-protocol.js';
import { buildIsometricPhasePayload, type IsometricPhase } from '../state/channel-payloads.js';
import { publishImbalanceResult, publishMaxResult } from './isometric-result-emit.js';
import { fence, waitFenced, LeaseLostError, type LeaseFence } from '../state/lease-fence.js';
import { checkMountLoad, ISOMETRIC_MAX_PEAK_LBS_PER_UNIT } from '../state/mount-load-gate.js';
import { unloadSlot } from './device-exit.js';
import { wrapHandler } from './helpers.js';

class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ToolError';
  }
}

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

const MEASURE_HOLD_DESCRIPTION = [
  'Measure ONE isometric hold on a device slot and return immediately.',
  'Runs a single max-effort hold (default 5s) — no trial loop, no rest wait —',
  'so a coach can pace the assessment turn by turn instead of blocking through',
  'a whole protocol. Call it again for the next hold when the athlete is ready.',
  '',
  'Caller must pre-configure the device into Isometric mode and set resistance',
  'to a low value before invoking; this tool does NOT change device settings.',
  '',
  'Returns the per-hold analysis (peak and plateau force, plateau window, the',
  'validity flags) plus peakForceLbs at the top level, which is readable even',
  'when the hold fails a validity gate. peakForceLbs is the headline number',
  '(VW-271) — it is the metric the reliability literature actually validated.',
  "Each trial's diagnostic block carries rfdLbPerS and impulseLbS: DIAGNOSTIC ONLY, never for",
  'monitoring change — early-phase force CV runs 5.5-23.3% (Grgic et al. 2022),',
  'too noisy to tell a real change from measurement error. Phase pushes',
  '(isometric_phase: ready, go, hold, stop) are emitted on the channel so a',
  'dashboard or cue surface can signal the athlete while the hold runs.',
  '',
  'MOUNT LOAD (VW-274): isometric mode measures up to 400 lb per unit',
  'regardless of the commanded weight — no wall/rack mount rating is',
  'published for any accessory. Refused as INVALID_INPUT, before the hold',
  'begins, when 400 lb exceeds a configured VMCP_MOUNT_RATING_LBS. With no',
  'rating configured, mountLoadWarning in the result says the envelope is',
  'UNKNOWN — a warning, never a refusal; null once a rating is configured.',
  '',
  'JOINT-ANGLE GATE (VW-296): joint angle dominates what an isometric hold',
  'predicts about the dynamic lift — an isometric squat predicted the full',
  'squat at r=0.864 held at 90 degrees of knee flexion but only r=0.597 held',
  'at 120 degrees (Lum, Haff & Barbosa 2020, Sports 8(5):63). Pass `exerciseId`',
  'and `setupAngleDeg` (the joint angle the current physical setup implies —',
  "this tool cannot measure it) to check the setup against that exercise's",
  'known peak-force angle; jointAngleGate in the result reports `comparable`,',
  `\`angle_mismatch\` (more than ${JOINT_ANGLE_MISMATCH_THRESHOLD_DEG} degrees apart), or`,
  '`angle_unverified` when either input is omitted or the exercise has no',
  'known angle — a gap in the table, never a silent pass. A mismatch WARNS by',
  'default (the hold still runs); pass `strict: true` to REFUSE it as',
  'INVALID_INPUT before the hold begins instead.',
  '',
  'For the full 3-trial protocol with rests and best-2-of-N aggregation, use',
  'isometric.measure_max; for bilateral asymmetry, isometric.measure_imbalance.',
].join(' ');

const MEASURE_MAX_DESCRIPTION = [
  'Run the isometric maximum-force assessment protocol on one device slot.',
  'Performs N trials (default 3) of M-second max-effort holds (default 5s)',
  `with rest between EVERY hold, warm-up pulls included (default ${DEFAULT_MAX_REST_MS / 1000}s).`,
  'Caller must pre-configure the device into Isometric mode and set',
  'resistance to a low value (or 0 lb if supported) before invoking — this',
  'tool does NOT change device settings.',
  '',
  'WARM-UP RAMP (VW-294, default on): before the trial loop, the tool runs',
  'two brief submaximal pulls of its own — one cued as roughly 50% effort,',
  'then one at roughly 75% — with the SAME inter-hold rest as the max trials,',
  'so the whole ramp-then-test sequence runs unprompted from one call instead',
  'of a coach pacing it turn by turn. This standardises the approach to a',
  'maximal isometric attempt (Comfort et al. 2019, as applied by Yeh et al.,',
  'PLoS One). The tool cannot verify actual effort — a warm-up pull is a cue,',
  'not a controlled variable — so its samples are reported under `warmup`',
  '(effortLevel, peakForceLbs, holdMs) and never join `trials`, the best-2',
  'selection, or the stored assessment. Pass `warmup: false` to skip the ramp',
  'for a coach-paced bench sitting.',
  '',
  'PEAK FORCE IS THE HEADLINE METRIC (VW-271): meanPeakForceLbs is the mean',
  'of the best 2 of N valid trials by peakForceLbs, and drives the 70%',
  'inferred working weight (rounded to 5 lb) and the SEM-based change check',
  'below. Peak force is what the reliability literature actually validated —',
  'unilateral IMTP peak force ICC 0.89-0.97, CV 3.4-4.9% (Grgic et al. 2022) —',
  'and plateauForceLbs on each trial exists only to feed the plateau-≥90%-of-',
  'peak validity gate, never as a reported average.',
  '',
  'Each trial also returns a diagnostic block (rfdLbPerS, impulseLbS):',
  'DIAGNOSTIC ONLY, NEVER FOR MONITORING CHANGE. Early-phase force CV runs',
  '5.5-23.3% (Grgic et al. 2022) and Weakley et al. (2024) call RFD "not',
  'recommended" for monitoring because its variability makes a real change',
  'undetectable. Read them as a single-test curiosity, not a trend.',
  '',
  'changeFromBaseline answers "is this different from what this athlete',
  'usually pulls": peakForceBaseline carries this athlete\'s meanLbs, semLbs',
  'and cvPct over sampleSize past test occasions, and is null under 3',
  'occasions — not enough history for a spread. sampleSize counts SIDE-',
  'occasions, not runs: a past isometric.measure_imbalance run contributes 2',
  '(one per side) and a past measure_max run contributes 1. The changed field on',
  "changeFromBaseline is true only when this run's peak force differs from meanLbs by more than",
  'thresholdLbs (deltaLbs is the signed difference); thresholdLbs is the',
  'ADJUSTED SEM, semLbs x sqrt(2) (Weakley et al. 2024) — a change score',
  'carries error from both occasions being compared, not just the new one.',
  'KEYED (VW-280): every stored assessment records the lifter, the exercise and',
  "the session it was captured under, so the baseline pools only this lifter's",
  'own past occasions of this exercise, and legacyUnkeyed counts the older',
  'assessments that carry no key and are therefore excluded from it.',
  '',
  'EACH STORED ASSESSMENT NAMES ITS EQUATION (VW-295): this run has no asymmetry',
  'to name one for (one side, no comparison), so nothing is stored here, but a',
  "past isometric.measure_imbalance occasion's stored equation is checked before",
  "its peak force joins this run's baseline — one computed under a different",
  'equation is excluded and counted in otherEquation, alongside legacyUnkeyed.',
  '',
  'VERIFIED IMTP-style PROTOCOL DETAILS THIS IMPLEMENTS: the 5 s hold',
  '(default, clamp 3-10s) and >=2 trials (default 3, clamp 2-5) an applied',
  "IMTP study used (Yeh et al., PMC13541152), AND (VW-294) that same study's",
  `2 min inter-trial rest — restMs now defaults to ${DEFAULT_MAX_REST_MS} (clamp`,
  'unchanged, 30s-5min), matching the standardised inter-trial rest for',
  'maximal isometric testing (Maffiuletti et al. 2016); pass a shorter restMs',
  'to loosen it for a coach-paced sitting. Its repeat-trial rule (repeat',
  'when two trials differ by more than 250 N) — this tool instead discards a',
  'trial whose peak diverges more than 15% from the session median, a',
  'percentage rule already established here and left unchanged. Its 40 N-',
  'above-bodyweight onset threshold — this tool has no bodyweight/resting-',
  'tension reading to threshold against, so onset is instead bounded',
  'structurally by the continuous-rise-from-zero and peak-after-1s gates.',
  '',
  'THE INFERRED WORKING WEIGHT IS A HEURISTIC, NOT A VALIDATED CONVERSION',
  '(VW-273). No study validates a cable-device isometric maximum as a',
  'predictor of dynamic cable loads, and nothing here treats it as a 1RM',
  'proxy. Joint angle dominates what an isometric maximum predicts at all:',
  'an isometric squat predicted the full squat at r 0.864 at 90 degrees of',
  'knee flexion but only r 0.597 at 120 degrees (Lum et al. 2020), so the',
  'number means something only when the hold was held at the angle where the',
  'exercise peaks. Treat it as a starting point a coach adjusts against what',
  'the athlete actually lifts.',
  '',
  'MOUNT LOAD (VW-274): isometric mode measures up to 400 lb per unit',
  'regardless of the commanded weight — no wall/rack mount rating is',
  'published for any accessory. Refused as INVALID_INPUT, before any trial',
  'runs, when 400 lb exceeds a configured VMCP_MOUNT_RATING_LBS. With no',
  'rating configured, mountLoadWarning in the result says the envelope is',
  'UNKNOWN — a warning, never a refusal; null once a rating is configured.',
  '',
  'For bilateral assessment + asymmetry detection, prefer',
  'isometric.measure_imbalance which composes this tool with the standard',
  'between-sides rest and side-ordering policy.',
].join(' ');

const MEASURE_IMBALANCE_DESCRIPTION = [
  'Run the bilateral isometric assessment protocol across two device slots',
  'and report the asymmetry index. Tests both sides sequentially with the',
  'configured between-sides rest (default 120s); when dominantSide is',
  'known and testNonDominantFirst is true (default), the non-dominant side',
  'is tested first to control for within-session fatigue.',
  '',
  'SETUP GEOMETRY GATES THE VERDICT TOO (VW-284/VW-272): before the asymmetry',
  "verdict is built, each side's CONFIRMED setup signature (its median",
  'concentric ROM, keyed on whichever setup exercise.confirm_setup vouched',
  "for) is compared against the other's. setupComparability carries the",
  'result: setup_confounded means the two sides are different physical',
  'setups, so real and direction on the imbalance verdict come back null',
  '(the raw asymmetryPct and CVs still report — those are facts, only the',
  'left-vs-right READING of them is withheld) — setupSignatures and',
  'setupReason say what was compared and why. setup_unverified means one or',
  'both sides had no confirmed setup to check, so the verdict is reported',
  'unchanged, with setupReason naming what could not be checked.',
  '',
  'THERE IS NO FIXED ASYMMETRY THRESHOLD HERE (VW-270). asymmetryPct is the',
  'standard percentage difference, (stronger − weaker) / stronger × 100, and',
  'the equation it came from is named in the output because the valid equation',
  'is chosen by the test method (Bishop et al. 2018) and percentages from',
  'different equations are not comparable. THE EQUATION IS ALSO PERSISTED ON',
  'THE STORED ROW (VW-295), fixed for this test type and never a per-call',
  'choice, so a later read can tell whether a past occasion used the same one',
  'before pooling it. The difference is marked real ONLY',
  "when asymmetryPct exceeds this athlete's own intra-limb CV across the very",
  'trials being compared (Bishop et al. 2023) — a difference smaller than a',
  "limb's own trial-to-trial spread is a measurement, not a capacity gap. Read",
  "intraLimbCvPct for each side's own CV and noiseFloorCvPct for the one it was",
  'judged against (the higher of the two, because the difference has to clear',
  'both limbs).',
  '',
  'directionHistory reports whether the SAME limb dominated across recent tests:',
  'consistent-left / consistent-right / fluctuating, or insufficient-history',
  'under 3 tests, with testsCompared for how many tests carried a direction and',
  'agreementPct for the share that named the more common limb. Direction, not',
  'one magnitude, is the interpretable signal — re-test agreement on limb',
  'dominance is only fair-to-substantial (Bishop et al. 2019). A consistent',
  'direction may warrant a closer look; a fluctuating one does not.',
  '',
  'KEYED (VW-280): every stored assessment records the lifter, the exercise and',
  'the session it was captured under, so the series is this lifter tested on',
  'this exercise, and legacyUnkeyed counts the older assessments that carry no',
  'key and are therefore excluded from it. directionHistory and',
  'peakForceBaseline also exclude a stored occasion computed under a different',
  'asymmetry equation than this run (VW-295), counted in otherEquation.',
  '',
  'DO NOT PRESCRIBE CORRECTIVE UNILATERAL WORK OFF THIS RESULT (VW-273). The',
  'intervention literature does not support it: unilateral training beats',
  'bilateral for unilateral jump and loses to it for bilateral strength, with',
  'everything else non-significant (Liao et al. 2022), so unilateral work is',
  'goal-specific rather than corrective. The stated answer to a detected',
  'asymmetry is consistent strength training over time. Each side also reports',
  'an inferred working weight; it is the same heuristic isometric.measure_max',
  'labels, carries the same joint-angle caveat, and is never a 1RM proxy.',
  '',
  "PEAK FORCE IS THE HEADLINE METRIC (VW-271): each side's meanPeakForceLbs",
  '(and the asymmetry math above) is the mean of the best 2 valid trials by',
  'peakForceLbs, not plateau force. Each trial also carries a diagnostic',
  'block (rfdLbPerS, impulseLbS) that is DIAGNOSTIC ONLY, NEVER FOR',
  'MONITORING CHANGE — early-phase force CV runs 5.5-23.3% (Grgic et al.',
  '2022). peakForceBaseline (meanLbs, semLbs, cvPct over sampleSize past',
  'occasions; null under 3) is shared by both sides; sampleSize counts SIDE-',
  'occasions, not runs — a past isometric.measure_imbalance run contributes 2',
  '(one per side) and a past measure_max run contributes 1. Each side reports',
  "its own changeFromBaseline against it, with changed true only when this run's peak",
  'force differs from meanLbs by more than thresholdLbs (deltaLbs is the',
  'signed difference) — thresholdLbs is the adjusted SEM, semLbs x sqrt(2)',
  '(Weakley et al. 2024). The baseline reads through the same key',
  'directionHistory above does.',
  '',
  'MOUNT LOAD (VW-274): each side runs the same single-unit isometric hold',
  'isometric.measure_max does, up to 400 lb per unit regardless of the',
  'commanded weight — no wall/rack mount rating is published for any',
  'accessory. Refused as INVALID_INPUT, before either side runs, when 400 lb',
  'exceeds a configured VMCP_MOUNT_RATING_LBS; checked once for both sides',
  'since the peak and the rating are the same regardless of slot. With no',
  'rating configured, mountLoadWarning in the result says the envelope is',
  'UNKNOWN — a warning, never a refusal; null once a rating is configured.',
  '',
  'Both slots must be connected before invoking. Each side runs the same',
  'measurement protocol as isometric.measure_max.',
  '',
  'The per-trial measurements are persisted (keyed on the device id of the',
  'unit that recorded them) so asymmetry can be trended across sessions;',
  'the response carries the resulting measurementId, or null if the write',
  'failed. No verdict is stored — the percentage, the direction and the',
  'real/not-real call are all recomputed from the stored trials on read.',
].join(' ');

/**
 * Register the isometric assessment tools on the running MCP server by
 * hot-swapping the `STARTING` placeholder callbacks (same pattern as every
 * other tool registry — see server.ts).
 */
export function registerIsometricTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
  install(
    placeholders,
    'isometric.measure_hold',
    IsometricMeasureHoldInput,
    wrapHandler(IsometricMeasureHoldInput, (input) => measureHold(state, input)),
    MEASURE_HOLD_DESCRIPTION,
  );
  install(
    placeholders,
    'isometric.measure_max',
    IsometricMeasureMaxInput,
    wrapHandler(IsometricMeasureMaxInput, (input) => measureMax(state, input)),
    MEASURE_MAX_DESCRIPTION,
  );
  install(
    placeholders,
    'isometric.measure_imbalance',
    IsometricMeasureImbalanceInput,
    wrapHandler(IsometricMeasureImbalanceInputRefined, (input) => measureImbalance(state, input)),
    MEASURE_IMBALANCE_DESCRIPTION,
  );
}

function install<S extends z.ZodObject>(
  placeholders: PlaceholderTools,
  name: string,
  schema: S,
  callback: (args: unknown, extra?: unknown) => Promise<unknown>,
  description?: string,
): void {
  const tool = placeholders.get(name);
  if (tool === undefined) {
    throw new Error(`tool placeholder not registered: ${name}`);
  }
  const updates: {
    paramsSchema: unknown;
    callback: (args: unknown, extra?: unknown) => Promise<unknown>;
    description?: string;
  } = { paramsSchema: schema.shape, callback };
  if (description !== undefined) updates.description = description;
  tool.update(updates as never);
}

interface MeasureHoldInput {
  slot?: string | undefined;
  side?: 'left' | 'right' | undefined;
  holdMs: number;
  label?: string | undefined;
  exerciseId?: string | undefined;
  setupAngleDeg?: number | undefined;
  strict: boolean;
}

interface MeasureMaxInput {
  slot?: string | undefined;
  durationMs: number;
  trials: number;
  restMs: number;
  warmup: boolean;
}

interface MeasureImbalanceInput {
  primarySlot: string;
  secondarySlot: string;
  primarySide: 'left' | 'right';
  durationMs: number;
  trials: number;
  restMs: number;
  betweenSidesRestMs: number;
  testNonDominantFirst: boolean;
  dominantSide: 'left' | 'right' | 'unknown';
}

interface MeasureHoldResult {
  ok: true;
  slot: string;
  /** Limb the caller declared for this hold; null when unstated. */
  side: 'left' | 'right' | null;
  /** Caller's free-text tag for the hold; null when unstated. */
  label: string | null;
  holdMs: number;
  trial: TrialAnalysis;
  /**
   * Highest instantaneous force in the hold. Echoes `trial.peakForceLbs` at
   * the top level because it is the number worth reading when the hold fails
   * a validity gate — a coach still wants to know what the athlete pulled.
   */
  peakForceLbs: number;
  /**
   * Set only when no `VMCP_MOUNT_RATING_LBS` is configured (VW-274): the
   * anchor's load envelope is UNKNOWN, not unlimited. `null` once a rating is
   * configured — configured-and-fine reports nothing extra.
   */
  mountLoadWarning: string | null;
  /**
   * Whether the declared setup angle matches this exercise's known peak-force
   * angle (VW-296). `angle_unverified` — never treated as a match or a
   * mismatch — whenever `exerciseId` or `setupAngleDeg` is omitted, or the
   * exercise carries no known angle.
   */
  jointAngleGate: JointAngleGateVerdict;
  totalElapsedMs: number;
}

/**
 * What `inferredWorkingWeightLbs` is, shipped WITH the number rather than only
 * in the tool description (VW-273).
 *
 * A description is read once, when the model picks the tool; the number is read
 * every time the result is. An unlabelled load off an isometric hold is exactly
 * the thing the literature does not support — no study validates a cable-device
 * isometric maximum against dynamic cable loads, and what an isometric maximum
 * predicts at all is dominated by the joint angle it was held at.
 */
const INFERRED_WORKING_WEIGHT_BASIS =
  'HEURISTIC, not a validated conversion. 70% of the mean peak force, rounded to 5 lb. ' +
  'No study validates a cable-device isometric maximum as a predictor of dynamic cable ' +
  'loads, and this is never a 1RM proxy. Joint angle dominates: an isometric squat ' +
  'predicted the full squat at r 0.864 at 90 degrees of knee flexion but only r 0.597 at ' +
  '120 degrees (Lum et al. 2020), so this figure means something only when the hold was ' +
  'held at the angle where the exercise peaks. A starting point a coach adjusts, nothing more.';

interface MeasureMaxResult {
  ok: true;
  slot: string;
  /**
   * The warm-up ramp's own pulls (VW-294), empty when `warmup: false`. Never
   * folded into `trials`, the best-2 selection, or the stored assessment —
   * effort during a warm-up pull is a cue the tool gives, not a controlled
   * variable it can verify.
   */
  warmup: WarmupPullResult[];
  trials: TrialAnalysis[];
  validTrialCount: number;
  meanPeakForceLbs: number | null;
  cvPct: number | null;
  inferredWorkingWeightLbs: number | null;
  /** What that weight is and is not; see {@link INFERRED_WORKING_WEIGHT_BASIS}. */
  inferredWorkingWeightBasis: string;
  /** This athlete's peak-force mean/SEM/CV over past occasions; null under 3 (VW-271). */
  peakForceBaseline: PeakForceBaseline | null;
  /** Whether this run's peak force clears the adjusted SEM; null with no baseline yet. */
  changeFromBaseline: PeakForceChangeVerdict | null;
  /**
   * Stored assessments that predate the VW-280 keying and so carry no lifter,
   * exercise or session. They are excluded from `peakForceBaseline` — nothing
   * says whose tests they were — and counted here instead of dropped
   * silently, because a thin baseline reads differently once you know older
   * tests exist that could not join it.
   */
  legacyUnkeyed: number;
  /**
   * Stored assessments excluded from `peakForceBaseline` because they carry a
   * DIFFERENT asymmetry equation than this run's (VW-295) — a percentage from
   * a different equation is not comparable, so pooling its peak forces in
   * would mix two measurement bases. A row with NO equation at all (every
   * `measure_max` row, and any legacy row) is not "other equation" and stays
   * in; only counted here is a genuine mismatch.
   */
  otherEquation: number;
  /** Id of the persisted `isometric_measurements` row, or `null` when the write failed. */
  measurementId: string | null;
  /**
   * Set only when no `VMCP_MOUNT_RATING_LBS` is configured (VW-274): the
   * anchor's load envelope is UNKNOWN, not unlimited. `null` once a rating is
   * configured — configured-and-fine reports nothing extra.
   */
  mountLoadWarning: string | null;
  totalElapsedMs: number;
}

interface SideSummary {
  slot: string;
  meanPeakForceLbs: number | null;
  inferredWorkingWeightLbs: number | null;
  cvPct: number | null;
  validTrialCount: number;
  /** This side's change against the shared `peakForceBaseline`; null with no baseline yet. */
  changeFromBaseline: PeakForceChangeVerdict | null;
}

type TestOrder = ['left', 'right'] | ['right', 'left'];

/**
 * The pure `computeImbalance` verdict, as reported once the setup gate has had
 * its say (VW-284). `real`/`direction` widen to admit `null` — WITHHELD,
 * distinct from the `false`/tie a computed verdict can also report — for the
 * `setup_confounded` case, where a between-limb difference cannot be told
 * apart from the rig.
 */
type ImbalanceVerdict = ReturnType<typeof computeImbalance>;
type ReportedImbalance = Omit<ImbalanceVerdict, 'real' | 'direction'> & {
  real: boolean | null;
  direction: ImbalanceVerdict['direction'] | null;
};

interface MeasureImbalanceResult {
  ok: true;
  testOrder: TestOrder;
  left: SideSummary;
  right: SideSummary;
  imbalance: ReportedImbalance;
  /**
   * Whether the two sides' setups may be compared at all (VW-284/VW-272): the
   * same cable-geometry gate `progression.get_for_exercise`'s `sideSplit`
   * runs, applied here to each side's CONFIRMED setup for the exercise active
   * on that slot rather than to its stored sets directly — an isometric hold
   * has no reps of its own to cluster. `setup_confounded` withholds
   * `imbalance.real`/`direction`; `setup_unverified` (no confirmed setup on
   * one or both sides) reports the verdict unchanged, with `setupReason`
   * stating what could not be checked.
   */
  setupComparability: SetupComparability;
  /** Each side's confirmed setup signature the gate compared. */
  setupSignatures: { left: SetupSignature; right: SetupSignature };
  /** Why the gate landed where it did — the wording `compareSetupSignatures` itself produced. */
  setupReason: string;
  /**
   * Whether the same limb dominated across this lifter's recent tests of this
   * exercise, recomputed from the stored trials of this run and the ones
   * before it. `null` only when the history could not be read at all —
   * distinct from `insufficient-history`, which is a real answer about a short
   * series.
   */
  directionHistory: DirectionHistory | null;
  /** What each side's inferred weight is and is not; see {@link INFERRED_WORKING_WEIGHT_BASIS}. */
  inferredWorkingWeightBasis: string;
  /**
   * This athlete's peak-force mean/SEM/CV over their own past occasions of
   * this exercise, read before this run's own trials were persisted; null
   * under 3 occasions (VW-271). Shared by both sides' `changeFromBaseline`.
   */
  peakForceBaseline: PeakForceBaseline | null;
  /**
   * Stored assessments that predate the VW-280 keying and so carry no lifter,
   * exercise or session. They are excluded from `directionHistory` and
   * `peakForceBaseline` — nothing says whose tests they were — and counted
   * here instead of dropped silently, because a three-test series reads
   * differently once you know nine older tests could not join it.
   */
  legacyUnkeyed: number;
  /**
   * Stored assessments excluded from `directionHistory` and `peakForceBaseline`
   * because they carry a DIFFERENT asymmetry equation than this run's
   * (VW-295) — a percentage from a different equation is not comparable, so
   * a stored direction or peak force computed under one cannot join a series
   * read under another. A row with NO equation at all is not "other equation"
   * and stays in; only a genuine mismatch is counted here.
   */
  otherEquation: number;
  /**
   * Set only when no `VMCP_MOUNT_RATING_LBS` is configured (VW-274): the
   * anchor's load envelope is UNKNOWN, not unlimited. `null` once a rating is
   * configured — configured-and-fine reports nothing extra. Checked once for
   * both sides: the isometric mode peak and the configured rating are the
   * same regardless of which slot is pulling.
   */
  mountLoadWarning: string | null;
  totalElapsedMs: number;
  /**
   * Id of the persisted `isometric_measurements` row, or `null` when the write
   * failed. Reported rather than thrown: a bilateral assessment costs the user
   * ten-plus minutes of maximal effort, so a store hiccup must not discard the
   * result the protocol just produced. A `null` here says "these numbers exist
   * only in this response".
   */
  measurementId: string | null;
}

/**
 * Version of the trial-analysis algorithm whose output gets persisted
 * (`analyzeTrial` in state/isometric-protocol.ts: the 500 ms plateau window and
 * the continuous-rise / peak-after-1s / plateau-≥90%-of-peak validity gates).
 *
 * BUMP THIS whenever those change. The stored per-trial peak/plateau/valid
 * numbers are derived from raw force samples that are NOT persisted, so they
 * can never be recomputed — without a version stamp, rows measured under old
 * rules would sit next to rows measured under new ones with nothing to tell
 * them apart.
 */
const ISOMETRIC_ANALYSIS_VERSION = 1;

/**
 * Trial index reported for a one-hold run. `analyzeTrial` numbers trials
 * from 1 within a side, and a single hold is trial 1 of its own run — the
 * caller sequences the holds, so the server has no run to count within.
 */
const SINGLE_HOLD_TRIAL_INDEX = 1;

/**
 * One hold, then return (VW-154). The 2026-08-01 bench found the multi-trial
 * tools unusable for a human-paced sitting: the call blocks through both the
 * holds and the 90s rests, so permission prompts land mid-hold and the athlete
 * gets no go/stop signal. This runs exactly one capture and hands pacing back
 * to the caller between holds.
 *
 * Nothing is persisted: a single hold is not an assessment. The trend series
 * comes from `isometric.measure_imbalance`, which aggregates over its trials
 * before it writes.
 */
async function measureHold(
  state: ServerState,
  input: MeasureHoldInput,
): Promise<MeasureHoldResult> {
  const slotId = input.slot ?? PRIMARY_SLOT;
  const mountLoadWarning = enforceIsometricMountLoad(state);
  const jointAngleGate = enforceJointAngleGate(input);
  const startedAt = Date.now();
  const trial = await withLeaseFence(state, 'isometric.measure_hold', [slotId], (leaseFence) =>
    captureSingleHold(
      state,
      slotId,
      {
        holdMs: input.holdMs,
        trial: SINGLE_HOLD_TRIAL_INDEX,
        ...(input.side !== undefined ? { side: input.side } : {}),
        ...(input.label !== undefined ? { label: input.label } : {}),
      },
      leaseFence,
    ),
  );
  return {
    ok: true,
    slot: slotId,
    side: input.side ?? null,
    label: input.label ?? null,
    holdMs: input.holdMs,
    trial,
    peakForceLbs: trial.peakForceLbs,
    mountLoadWarning,
    jointAngleGate,
    totalElapsedMs: Date.now() - startedAt,
  };
}

/**
 * Refuse or warn before a hold begins when the declared setup angle
 * materially differs from the exercise's known peak-force angle (VW-296).
 * `strict` (default false) is what decides which: a mismatch WARNS by
 * default (the returned verdict rides along on the result, and the hold still
 * runs) and only REFUSES as `INVALID_INPUT` when the caller opted into
 * `strict`. Runs before the lease fence claims the slot, alongside the
 * mount-load check — a refusal here should cost nothing.
 */
function enforceJointAngleGate(input: MeasureHoldInput): JointAngleGateVerdict {
  const verdict = evaluateJointAngleGate(input.exerciseId, input.setupAngleDeg);
  if (input.strict && verdict.comparability === 'angle_mismatch') {
    throw new ToolError('INVALID_INPUT', verdict.reason);
  }
  return verdict;
}

/**
 * Refuse or warn before any isometric hold begins (VW-274). Isometric mode
 * measures up to {@link ISOMETRIC_MAX_PEAK_LBS_PER_UNIT} on a single unit
 * regardless of the commanded weight — a MODE-driven peak the caller's input
 * does not control — so the check runs unconditionally, before the lease
 * fence claims the slot, on every call.
 */
function enforceIsometricMountLoad(state: ServerState): string | null {
  const verdict = checkMountLoad(
    state.config.mountRatingLbs,
    ISOMETRIC_MAX_PEAK_LBS_PER_UNIT,
    `isometric max force, up to ${ISOMETRIC_MAX_PEAK_LBS_PER_UNIT} lb per unit`,
  );
  if (verdict.refused) {
    throw new ToolError('INVALID_INPUT', verdict.refusalMessage as string);
  }
  return verdict.warning ?? null;
}

async function measureMax(state: ServerState, input: MeasureMaxInput): Promise<MeasureMaxResult> {
  const slotId = input.slot ?? PRIMARY_SLOT;
  const mountLoadWarning = enforceIsometricMountLoad(state);
  const startedAt = Date.now();
  const result = await withLeaseFence(state, 'isometric.measure_max', [slotId], (leaseFence) =>
    runSideProtocol(
      state,
      slotId,
      { ...input, warmupEffortLevels: input.warmup ? WARMUP_EFFORT_LEVELS : undefined },
      leaseFence,
    ),
  );
  const keys = measurementKeys(state, slotId);
  // Read BEFORE persisting, so this run's own result never leaks into its own
  // baseline (VW-271) — the opposite of the direction history, which wants
  // the current run included.
  const history = await readKeyedHistory(state, keys, 'isometric.measure_max');
  const filtered = excludeOtherEquations(history);
  const peakForceBaseline = baselineFrom(filtered);
  const changeFromBaseline =
    peakForceBaseline !== null && result.analysis.meanPeakForceLbs !== null
      ? evaluatePeakForceChange(result.analysis.meanPeakForceLbs, peakForceBaseline)
      : null;
  const measurementId = await persistMeasurement(state, keys, {
    durationMs: input.durationMs,
    trialsRequested: input.trials,
    restMs: input.restMs,
    asymmetryEquation: asymmetryEquationFor('unilateral-max'),
    sides: [{ slotId, trials: result.analysis.trials }],
  });
  publishMaxResult(state, { slot: slotId, peakForceLbs: result.analysis.meanPeakForceLbs });
  return {
    ok: true,
    slot: slotId,
    warmup: result.warmup,
    trials: result.analysis.trials,
    validTrialCount: result.analysis.validTrialCount,
    meanPeakForceLbs: result.analysis.meanPeakForceLbs,
    cvPct: result.analysis.cvPct,
    inferredWorkingWeightLbs: result.analysis.inferredWorkingWeightLbs,
    inferredWorkingWeightBasis: INFERRED_WORKING_WEIGHT_BASIS,
    peakForceBaseline,
    changeFromBaseline,
    legacyUnkeyed: history?.legacyUnkeyed ?? 0,
    otherEquation: filtered?.otherEquation ?? 0,
    measurementId,
    mountLoadWarning,
    totalElapsedMs: Date.now() - startedAt,
  };
}

async function measureImbalance(
  state: ServerState,
  input: MeasureImbalanceInput,
): Promise<MeasureImbalanceResult> {
  // Resolve slots up front so any unbound slot fails fast before we burn
  // any trial time.
  const primary = getSlot(state, input.primarySlot);
  const secondary = getSlot(state, input.secondarySlot);
  ensureSlotConnected(input.primarySlot, primary);
  ensureSlotConnected(input.secondarySlot, secondary);
  // Each side runs the same single-unit isometric hold measure_max does, so
  // it carries the same per-unit mount-load risk (VW-274) — the gate cannot
  // depend on which tool triggered the hold. One check covers both sides:
  // the mode-driven peak and the configured rating are the same regardless
  // of slot.
  const mountLoadWarning = enforceIsometricMountLoad(state);

  const secondarySide: 'left' | 'right' = input.primarySide === 'left' ? 'right' : 'left';
  const order = decideTestOrder(
    input.primarySide,
    secondarySide,
    input.testNonDominantFirst,
    input.dominantSide,
  );
  // Map each side label → slot id so we can drive the protocol in test order.
  const slotForSide: Record<'left' | 'right', string> = {
    [input.primarySide]: input.primarySlot,
    [secondarySide]: input.secondarySlot,
  } as Record<'left' | 'right', string>;

  const startedAt = Date.now();
  const sideResults = new Map<'left' | 'right', SideAnalysis>();

  await withLeaseFence(
    state,
    'isometric.measure_imbalance',
    [input.primarySlot, input.secondarySlot],
    async (leaseFence) => {
      for (let i = 0; i < order.length; i++) {
        const sideLabel = order[i];
        const slotId = slotForSide[sideLabel];
        const sideResult = await runSideProtocol(state, slotId, input, leaseFence);
        sideResults.set(sideLabel, sideResult.analysis);
        if (i < order.length - 1) {
          await waitFenced(input.betweenSidesRestMs, leaseFence, slotId);
        }
      }
    },
  );

  const leftAnalysis = sideResults.get('left');
  const rightAnalysis = sideResults.get('right');
  const leftSlotId = slotForSide.left;
  const rightSlotId = slotForSide.right;

  const keys = measurementKeys(state, input.primarySlot);
  // Read BEFORE persisting, so this run's own result never leaks into its own
  // baseline (VW-271) — the opposite of the direction history below, which
  // wants the current run included.
  const peakForceBaseline = baselineFrom(
    excludeOtherEquations(await readKeyedHistory(state, keys, 'isometric.measure_imbalance')),
  );
  const left: SideSummary = sideAsSummary(leftSlotId, leftAnalysis, peakForceBaseline);
  const right: SideSummary = sideAsSummary(rightSlotId, rightAnalysis, peakForceBaseline);

  // Setup geometry before the verdict (VW-284): a confounded rig makes the raw
  // asymmetry meaningless, so the gate has to run before the verdict is built,
  // not after.
  const setupGate = await readSetupComparability(state, leftSlotId, rightSlotId);
  const rawImbalance = computeImbalance(left, right);
  const imbalance: ReportedImbalance =
    setupGate.comparability === 'setup_confounded'
      ? withholdImbalanceVerdict(rawImbalance, setupGate)
      : rawImbalance;

  const measurementId = await persistMeasurement(state, keys, {
    firstSideTested: order[0],
    durationMs: input.durationMs,
    trialsRequested: input.trials,
    restMs: input.restMs,
    betweenSidesRestMs: input.betweenSidesRestMs,
    asymmetryEquation: asymmetryEquationFor('bilateral-imbalance'),
    sides: [
      { side: 'left', slotId: leftSlotId, trials: leftAnalysis?.trials ?? [] },
      { side: 'right', slotId: rightSlotId, trials: rightAnalysis?.trials ?? [] },
    ],
  });
  publishImbalanceResult(state, {
    sides: [
      { side: 'left', slot: leftSlotId, peakForceLbs: left.meanPeakForceLbs },
      { side: 'right', slot: rightSlotId, peakForceLbs: right.meanPeakForceLbs },
    ],
    imbalance,
    setup: setupGate,
  });

  // Re-read AFTER persisting so the run just completed is in its own series.
  const directionRead = await readKeyedHistory(state, keys, 'isometric.measure_imbalance');
  const directionFiltered = excludeOtherEquations(directionRead);

  return {
    ok: true,
    testOrder: order as TestOrder,
    left,
    right,
    imbalance,
    setupComparability: setupGate.comparability,
    setupSignatures: { left: setupGate.left, right: setupGate.right },
    setupReason: setupGate.reason,
    directionHistory: summarizeDirection(directionFiltered),
    inferredWorkingWeightBasis: INFERRED_WORKING_WEIGHT_BASIS,
    peakForceBaseline,
    legacyUnkeyed: directionRead?.legacyUnkeyed ?? 0,
    otherEquation: directionFiltered?.otherEquation ?? 0,
    mountLoadWarning,
    totalElapsedMs: Date.now() - startedAt,
    measurementId,
  };
}

/**
 * How many past assessments the direction series reads. Generous rather than
 * tuned: there is no published re-test cadence for asymmetry, so the series is
 * "the recent tests", not a window someone claimed was correct.
 */
const DIRECTION_HISTORY_LIMIT = 20;

/**
 * The recent assessments for ONE lifter's tests of ONE exercise (VW-280).
 *
 * Every cross-run aggregate below reads through this, so none of them can mix
 * two lifters or two joints the way the unfiltered read did. Assessments
 * stored before the keying landed carry no lifter and cannot join any series;
 * `legacyUnkeyed` reports how many, because a three-test history reads
 * differently once you know nine older tests exist that could not be placed.
 *
 * Never throws, for the same reason `persistMeasurement` does not: the
 * measurement in hand cost the athlete ten-plus minutes of maximal effort and
 * must not be lost to a read that failed. A `null` says the history is unknown,
 * which the caller can tell apart from a short-but-read history.
 */
async function readKeyedHistory(
  state: ServerState,
  keys: MeasurementKeys,
  tool: string,
): Promise<IsometricMeasurementHistory | null> {
  try {
    return await state.store.listRecentIsometricMeasurements({
      limit: DIRECTION_HISTORY_LIMIT,
      filter: { userId: keys.userId, exerciseId: keys.exerciseId },
    });
  } catch (err) {
    log.warn(`${tool}: reading the keyed isometric history failed`, err);
    return null;
  }
}

/** A keyed history page with rows under a different asymmetry equation pulled out. */
interface FilteredIsometricHistory {
  measurements: StoredIsometricMeasurement[];
  /** Rows excluded because their equation is SET and differs from this run's (VW-295). */
  otherEquation: number;
}

/**
 * Pull out stored rows whose asymmetry equation is a MISMATCH with the current
 * one (VW-295) — `directionHistory` and the peak-force baseline both read
 * through this, because a percentage or a direction computed under a
 * different equation cannot join a series read under this one.
 *
 * A row with NO equation at all is not a mismatch: every `measure_max` row
 * computes no comparison and stores none by design, and a pre-VW-295 row
 * never named one either. Both stay in — this excludes a genuine conflict,
 * not an absence.
 */
function excludeOtherEquations(
  history: IsometricMeasurementHistory | null,
): FilteredIsometricHistory | null {
  if (history === null) return null;
  let otherEquation = 0;
  const measurements = history.measurements.filter((m) => {
    if (m.asymmetryEquation === undefined || m.asymmetryEquation === ASYMMETRY_EQUATION) {
      return true;
    }
    otherEquation += 1;
    return false;
  });
  return { measurements, otherEquation };
}

/**
 * Summarize limb dominance over this lifter's stored assessments of this
 * exercise, including the one this run just wrote (VW-270/VW-280).
 */
function summarizeDirection(history: FilteredIsometricHistory | null): DirectionHistory | null {
  if (history === null) return null;
  return summarizeDirectionHistory(
    history.measurements.map((m) => ({
      measuredAt: m.measuredAt,
      direction: directionOfMeasurement(m),
    })),
  );
}

/**
 * Whether the two sides' setups may be compared at all (VW-284). Reads each
 * side's own confirmed-setup signature, then asks the shared VW-272 gate.
 */
async function readSetupComparability(
  state: ServerState,
  leftSlotId: string,
  rightSlotId: string,
): Promise<SetupComparabilityVerdict> {
  const [left, right] = await Promise.all([
    confirmedSetupSignature(state, 'left', leftSlotId),
    confirmedSetupSignature(state, 'right', rightSlotId),
  ]);
  return compareSetupSignatures(left, right);
}

/**
 * One side's setup signature, read off its CONFIRMED `exercise_setups` row for
 * the exercise active on that slot's session (VW-284) — never an inferred-but-
 * unconfirmed cluster. An isometric hold has no reps of its own to cluster a
 * setup from, so this reads the same signal `progression.get_for_exercise`'s
 * `sideSplit` does (median concentric ROM over the side's working sets) but
 * scoped to whichever setup a human actually vouched for, via the sets
 * currently stamped with it.
 *
 * No active exercise on the slot, or no confirmed setup for this side, both
 * come back as a signature with no `medianRomM` — `compareSetupSignatures`
 * reads that as `setup_unverified`, never as a mismatch.
 *
 * Never throws, on the same posture as `readDirectionHistory`: a read failure
 * here must not cost the athlete the assessment they just produced.
 */
async function confirmedSetupSignature(
  state: ServerState,
  side: 'left' | 'right',
  slotId: string,
): Promise<SetupSignature> {
  const exerciseId = getSlot(state, slotId).live.session?.exerciseId;
  if (exerciseId === undefined) return { side };
  try {
    const [setups, sets] = await Promise.all([
      state.store.listExerciseSetups({ userId: LOCAL_USER_ID, exerciseId }),
      state.store.getSetsForExercise({
        userId: LOCAL_USER_ID,
        exerciseId,
        side,
        purpose: ['working'],
      }),
    ]);
    const confirmedIds = new Set(
      setups
        .filter((s) => s.confirmedAt !== undefined && s.retiredAt === undefined)
        .map((s) => s.id),
    );
    const confirmedSets = sets.filter(
      (set) => set.setupId !== undefined && confirmedIds.has(set.setupId),
    );
    const medianRomM = medianRomMetres(
      confirmedSets
        .map((set) => setMedianRomM(set))
        .filter((rom): rom is number => rom !== undefined),
    );
    const setupIds = new Set(confirmedSets.map((set) => set.setupId));
    return {
      side,
      ...(medianRomM !== undefined ? { medianRomM } : {}),
      ...(setupIds.size === 1 ? { setupId: [...setupIds][0] } : {}),
    };
  } catch (err) {
    log.warn(`isometric.measure_imbalance: reading the confirmed setup for ${side} failed`, err);
    return { side };
  }
}

/**
 * The pure `computeImbalance` verdict with `real`/`direction` withheld (VW-284):
 * a `setup_confounded` gate means a left-vs-right difference here is at least
 * partly the rig, so the interpretive call is replaced with why it was
 * withheld. `asymmetryPct` and the CVs stay — they are facts about what was
 * measured, not a claim about what it means.
 */
function withholdImbalanceVerdict(
  imbalance: ImbalanceVerdict,
  gate: SetupComparabilityVerdict,
): ReportedImbalance {
  return {
    ...imbalance,
    real: null,
    direction: null,
    interpretation: `Verdict withheld: ${gate.reason}`,
  };
}

/**
 * This athlete's peak-force baseline over their own past occasions of this
 * exercise (VW-271/VW-280) — the SEM it yields is a claim about one athlete's
 * measurement spread, so pooling a second lifter's pulls into it inflated the
 * spread and hid real changes.
 */
function baselineFrom(history: FilteredIsometricHistory | null): PeakForceBaseline | null {
  if (history === null) return null;
  return computePeakForceBaseline(occasionPeakForcesLbs(history.measurements));
}

/**
 * Who is being tested, on what, during which session (VW-280) — stamped on the
 * stored row and used as the filter for every cross-run read in the same call.
 */
interface MeasurementKeys {
  userId: string;
  exerciseId: string | null;
  sessionId: string | null;
}

/**
 * Resolve the keys off the slot's own live session.
 *
 * `userId` follows VW-169's identity split: a guest working in carries the
 * session's lifter LABEL, and the owner is {@link LOCAL_USER_ID}, so a guest's
 * assessments never join the owner's series. No open session means the owner
 * tested themselves off the books — the exercise and session stay null rather
 * than being invented, and the run still keys to a lifter so it is not written
 * as another unreadable legacy row.
 *
 * `measure_imbalance` resolves from its PRIMARY slot: both slots run one
 * assessment of one movement, and the primary slot is the one whose side the
 * caller declared.
 */
function measurementKeys(state: ServerState, slotId: string): MeasurementKeys {
  const session = getSlot(state, slotId).live.session;
  return {
    userId: session?.lifter ?? LOCAL_USER_ID,
    exerciseId: session?.exerciseId ?? null,
    sessionId: session?.sessionId ?? null,
  };
}

interface PersistSideInput {
  /** Absent for a single-slot `measure_max` run, which declares no limb. */
  side?: 'left' | 'right';
  slotId: string;
  trials: TrialAnalysis[];
}

/**
 * Write the assessment to the store (VMCP-04.11). Until this landed the tool
 * computed a real left/right asymmetry and dropped it on the floor, so nothing
 * about limb asymmetry survived the response — the one question bilateral
 * training exists to answer had no history behind it. `isometric.measure_max`
 * writes through the same path (VW-271) with a single, side-less entry — the
 * `sides` array shape was chosen for exactly this so no schema change was
 * needed when it landed.
 *
 * What goes in: the per-trial measurements, plus the protocol parameters they
 * were collected under. What stays out: the asymmetry percentage and its
 * flagged/meaningful verdicts, and the peak-force baseline verdict. Those are
 * conclusions — arithmetic away from the stored trials — and `computeImbalance`
 * / `computePeakForceBaseline` recompute them on read for free, always against
 * current thresholds. A stored verdict would be indistinguishable from a fresh
 * one the day the thresholds move.
 *
 * `asymmetry_equation` (VW-295) is the one exception: it is stamped, not
 * recomputed, because it is not a function of the stored trials at all — it is
 * fixed by which tool ran (`asymmetryEquationFor`), and a future equation
 * change must not silently reinterpret an old row's percentage under the new
 * one. Absent for `measure_max`, which computes no comparison to name.
 *
 * Identity, run level (VW-280): `user_id` / `exercise_id` / `session_id` say
 * who was tested, on what, and during which session — see
 * {@link measurementKeys}. They are what makes a stored assessment joinable to
 * a series at all; without them every test on the rig fell into one.
 *
 * Identity, side level: each side's trials carry the DEVICE ID read from that slot's
 * connected client at measurement time. That is the join key. `slot` rides
 * along for diagnostics only — `slot.swap` reassigns slot ids between physical
 * units, so a series keyed on slot would flip limbs mid-history with nothing
 * erroring. `side` is the limb the caller declared for this run (the whole
 * premise of the call: `primarySide` says which slot is on which limb), absent
 * for a single-slot `measure_max` run, and frozen at write time for the same
 * reason `set.end` freezes it.
 *
 * Never throws. See `measurementId` on the result for why a store failure must
 * not take the measurement down with it.
 */
async function persistMeasurement(
  state: ServerState,
  keys: MeasurementKeys,
  args: {
    firstSideTested?: 'left' | 'right';
    durationMs: number;
    trialsRequested: number;
    restMs: number;
    betweenSidesRestMs?: number;
    /** The equation this run's asymmetry math used, fixed per test type (VW-295); null for a run with no comparison to name one for. */
    asymmetryEquation: AsymmetryEquation | null;
    sides: PersistSideInput[];
  },
): Promise<string | null> {
  const measurement: StoredIsometricMeasurement = {
    id: randomUUID(),
    measuredAt: new Date().toISOString(),
    analysisVersion: ISOMETRIC_ANALYSIS_VERSION,
    userId: keys.userId,
    ...(keys.exerciseId !== null ? { exerciseId: keys.exerciseId } : {}),
    ...(keys.sessionId !== null ? { sessionId: keys.sessionId } : {}),
    ...(args.firstSideTested !== undefined ? { firstSideTested: args.firstSideTested } : {}),
    durationMs: args.durationMs,
    trialsRequested: args.trialsRequested,
    restMs: args.restMs,
    ...(args.betweenSidesRestMs !== undefined
      ? { betweenSidesRestMs: args.betweenSidesRestMs }
      : {}),
    ...(args.asymmetryEquation !== null ? { asymmetryEquation: args.asymmetryEquation } : {}),
    sides: args.sides.map((s) => toStoredSide(state, s)),
  };
  try {
    await state.store.putIsometricMeasurement(measurement);
    return measurement.id;
  } catch (err) {
    log.warn('isometric: persisting the measurement failed', err);
    return null;
  }
}

function toStoredSide(state: ServerState, side: PersistSideInput): StoredIsometricSideMeasurement {
  // Absent — never defaulted — when the slot has no connected device id (mock
  // adapter, or a device that dropped mid-assessment). A gap reads downstream
  // as "we don't know which unit measured this"; a placeholder device id would
  // be indistinguishable from a real one and would pollute every per-device
  // series it landed in.
  const deviceId = getSlot(state, side.slotId).client.connectedDeviceId;
  return {
    ...(side.side !== undefined ? { side: side.side } : {}),
    ...(typeof deviceId === 'string' ? { deviceId } : {}),
    slot: side.slotId,
    trials: side.trials.map((t) => ({
      id: randomUUID(),
      index: t.index,
      peakForceLbs: t.peakForceLbs,
      plateauForceLbs: t.plateauForceLbs,
      plateauStartMs: t.plateauStartMs,
      plateauEndMs: t.plateauEndMs,
      valid: t.valid,
      ...(t.invalidReason !== undefined ? { invalidReason: t.invalidReason } : {}),
    })),
  };
}

/** One warm-up pull's own reading (VW-294) — never a trial, never persisted. */
interface WarmupPullResult {
  /** Cued effort as a fraction of max (0.5, 0.75, …) — not a controlled variable. */
  effortLevel: number;
  peakForceLbs: number;
  holdMs: number;
}

interface RunSideResult {
  analysis: SideAnalysis;
  /** Empty unless `opts.warmupEffortLevels` was given (VW-294). */
  warmup: WarmupPullResult[];
}

/** What one hold needs: how long, which hold of the run, and how to name it. */
interface SingleHoldOptions {
  holdMs: number;
  trial: number;
  side?: 'left' | 'right' | undefined;
  label?: string | undefined;
}

function warmupLabel(effortLevel: number): string {
  return `warm-up (${Math.round(effortLevel * 100)}% effort)`;
}

/**
 * Run the warm-up ramp's own pulls, one per `effortLevel`, each followed by
 * the SAME `restMs` gap the max trials use (VW-294) — a single rest concept
 * governs the whole ready-then-test sequence rather than inventing a second,
 * unstated ramp-specific interval. Every pull uses the same `durationMs` a
 * max trial does for the same reason. Called with an EMPTY array for every
 * flow that predates the ramp (`measure_imbalance`), which leaves the
 * sequence and timing of those flows unchanged.
 */
async function runWarmupPulls(
  state: ServerState,
  slotId: string,
  opts: { durationMs: number; restMs: number; effortLevels: readonly number[] },
  leaseFence: LeaseFence,
): Promise<WarmupPullResult[]> {
  const results: WarmupPullResult[] = [];
  for (let i = 0; i < opts.effortLevels.length; i++) {
    const effortLevel = opts.effortLevels[i]!;
    const analysis = await captureSingleHold(
      state,
      slotId,
      { holdMs: opts.durationMs, trial: i + 1, label: warmupLabel(effortLevel) },
      leaseFence,
    );
    results.push({ effortLevel, peakForceLbs: analysis.peakForceLbs, holdMs: opts.durationMs });
    await waitFenced(opts.restMs, leaseFence, slotId);
  }
  return results;
}

async function runSideProtocol(
  state: ServerState,
  slotId: string,
  opts: {
    durationMs: number;
    trials: number;
    restMs: number;
    warmupEffortLevels?: readonly number[] | undefined;
  },
  leaseFence: LeaseFence,
): Promise<RunSideResult> {
  const slot = getSlot(state, slotId);
  ensureSlotConnected(slotId, slot);

  const warmup = await runWarmupPulls(
    state,
    slotId,
    {
      durationMs: opts.durationMs,
      restMs: opts.restMs,
      effortLevels: opts.warmupEffortLevels ?? [],
    },
    leaseFence,
  );

  const trialAnalyses: TrialAnalysis[] = [];
  for (let i = 0; i < opts.trials; i++) {
    trialAnalyses.push(
      await captureSingleHold(state, slotId, { holdMs: opts.durationMs, trial: i + 1 }, leaseFence),
    );
    if (i < opts.trials - 1) {
      await waitFenced(opts.restMs, leaseFence, slotId);
    }
  }
  return { analysis: aggregateSide(trialAnalyses), warmup };
}

/**
 * Run an isometric flow under a lease fence (VW-200).
 *
 * These tools issue no BLE command of their own, but they BLOCK — a single
 * hold for seconds, the full protocol for minutes — and until this landed a
 * steal could not interrupt them: the assessment kept measuring, and kept
 * publishing `isometric_phase` cues at an athlete whose device another session
 * now owned. The fence turns every wait inside into an abortable one.
 *
 * On an abort the device is left UNLOADED through `unloadSlot`, the same exit
 * path `surrenderDevice` and the voice stop-phrase use. The caller was told to
 * pre-configure the cable for the hold, so the athlete may be pulling against
 * real resistance at the moment the lease goes; dropping that load is the one
 * write worth making, and it is load-REDUCING, which `lease-guard.ts` keeps
 * ungated for exactly this reason. Best-effort: a failed unload must not
 * replace `LEASE_LOST` with a less useful error.
 */
async function withLeaseFence<T>(
  state: ServerState,
  tool: string,
  slotIds: readonly string[],
  body: (leaseFence: LeaseFence) => Promise<T>,
): Promise<T> {
  const leaseFence = fence(state, tool);
  try {
    return await body(leaseFence);
  } catch (err) {
    if (err instanceof LeaseLostError) {
      await unloadAfterAbort(state, slotIds);
    }
    throw err;
  } finally {
    leaseFence.dispose();
  }
}

async function unloadAfterAbort(state: ServerState, slotIds: readonly string[]): Promise<void> {
  for (const slotId of slotIds) {
    if (!getSlot(state, slotId).client.isConnected) continue;
    try {
      await unloadSlot(state, slotId);
    } catch (err) {
      log.warn(`isometric: could not unload slot ${slotId} after a lease steal`, err);
    }
  }
}

/**
 * Capture ONE hold on `slotId` and analyze it — the single unit every
 * isometric flow is built from. Subscribes to the slot client's `onFrame`
 * for `holdMs`, detaches, and hands the samples to `analyzeTrial`.
 *
 * Never rests and never loops: the multi-trial tools own the trial loop and
 * the rest between trials, so a caller that wants one human-paced hold
 * (`isometric.measure_hold`) gets exactly that and nothing else.
 */
async function captureSingleHold(
  state: ServerState,
  slotId: string,
  opts: SingleHoldOptions,
  leaseFence: LeaseFence,
): Promise<TrialAnalysis> {
  const slot = getSlot(state, slotId);
  ensureSlotConnected(slotId, slot);
  const publishPhase = phasePublisher(state, slotId, opts);

  publishPhase('ready');
  const samples: ForceSample[] = [];
  const unsubscribe = subscribeForceSamples(slot.client, samples);
  publishPhase('go');
  try {
    await waitHoldWindow(opts.holdMs, () => publishPhase('hold'), leaseFence, slotId);
  } finally {
    if (typeof unsubscribe === 'function') {
      unsubscribe();
    }
    // `stop` on the way out however the hold ends. An athlete pulling maximally
    // is owed the stop cue even when the hold was cut short by a lease steal —
    // more so, because the device is about to be unloaded underneath them.
    publishPhase('stop');
  }
  return analyzeTrial(samples, opts.trial);
}

/**
 * Wait out the hold, calling `onHold` once the ramp-up is over. Splitting the
 * wait at `PEAK_AFTER_MS` — the point at which a peak starts counting toward
 * validity — is what gives the `hold` phase its meaning: before it the athlete
 * is still building force, after it they are holding the plateau the analysis
 * measures. The two sleeps sum to `holdMs`, so the capture window is unchanged.
 */
async function waitHoldWindow(
  holdMs: number,
  onHold: () => void,
  leaseFence: LeaseFence,
  slotId: string,
): Promise<void> {
  const rampMs = Math.min(PEAK_AFTER_MS, holdMs);
  await waitFenced(rampMs, leaseFence, slotId);
  onHold();
  await waitFenced(holdMs - rampMs, leaseFence, slotId);
}

/**
 * Bind a phase-push emitter for one hold. Publishing through
 * `channels.forSlot` tags every push with the originating slot (and the
 * emit-time `at`), which is what lets a bilateral surface tell a left-arm
 * hold from a right-arm one.
 */
function phasePublisher(
  state: ServerState,
  slotId: string,
  opts: SingleHoldOptions,
): (phase: IsometricPhase) => void {
  const channels = state.channels.forSlot(slotId);
  return (phase: IsometricPhase): void => {
    channels.publish(
      buildIsometricPhasePayload({
        phase,
        trial: opts.trial,
        holdMs: opts.holdMs,
        ...(opts.side !== undefined ? { side: opts.side } : {}),
        ...(opts.label !== undefined ? { label: opts.label } : {}),
      }),
    );
  };
}

/**
 * Push `{ tMs, forceLbs }` samples into `samples` for every frame the client
 * emits, relative to subscription time. Returns the unsubscribe handle;
 * callers invoke it in a `finally` so the bridge's other subscribers don't
 * compete with stale isometric listeners after the hold ends.
 */
function subscribeForceSamples(
  client: { onFrame: (cb: (frame: TelemetryFrame) => void) => () => void },
  samples: ForceSample[],
): () => void {
  const startMs = Date.now();
  return client.onFrame((frame: TelemetryFrame) => {
    // Same tenths→lb conversion as the main telemetry bridge, applied here
    // because the isometric flow builds its own force samples and never routes
    // through event-bridge. CALIBRATION CAVEAT: the isometric assessment's
    // empirical validity (plateau detection, inferred working weight) has NOT
    // been re-verified against hardware after this scale change — it is flagged
    // for a separate isometric-hold calibration ticket.
    samples.push({
      tMs: Date.now() - startMs,
      forceLbs: Math.abs(frame.force) / FRAME_FORCE_TENTHS_PER_LB,
    });
  });
}

function ensureSlotConnected(slotId: string, slot: ReturnType<typeof getSlot>): void {
  if (!slot.client.isConnected) {
    throw new ToolError(
      'SLOT_NOT_BOUND',
      `Slot \`${slotId}\` is not connected. Connect a device first via device.connect.`,
    );
  }
}

function sideAsSummary(
  slotId: string,
  analysis: SideAnalysis | undefined,
  peakForceBaseline: PeakForceBaseline | null,
): SideSummary {
  if (analysis === undefined) {
    return {
      slot: slotId,
      meanPeakForceLbs: null,
      inferredWorkingWeightLbs: null,
      cvPct: null,
      validTrialCount: 0,
      changeFromBaseline: null,
    };
  }
  return {
    slot: slotId,
    meanPeakForceLbs: analysis.meanPeakForceLbs,
    inferredWorkingWeightLbs: analysis.inferredWorkingWeightLbs,
    cvPct: analysis.cvPct,
    validTrialCount: analysis.validTrialCount,
    changeFromBaseline:
      peakForceBaseline !== null && analysis.meanPeakForceLbs !== null
        ? evaluatePeakForceChange(analysis.meanPeakForceLbs, peakForceBaseline)
        : null,
  };
}
