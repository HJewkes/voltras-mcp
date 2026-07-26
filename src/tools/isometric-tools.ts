// `isometric.measure_max` and `isometric.measure_imbalance` tools.
//
// These tools drive a multi-trial isometric assessment protocol against a
// connected Voltra device (or pair of devices for the bilateral imbalance
// flow). The pure analysis math lives in `src/state/isometric-protocol.ts`;
// this module owns the protocol orchestration: subscribe to the SDK's
// `onFrame` telemetry stream for each trial window, accumulate samples,
// rest between trials, and assemble the response.
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
import type { StoredIsometricMeasurement, StoredIsometricSideMeasurement } from '../store/types.js';

import {
  IsometricMeasureMaxInput,
  IsometricMeasureImbalanceInput,
  IsometricMeasureImbalanceInputRefined,
} from '../schemas/isometric.js';
import { type ServerState, PRIMARY_SLOT, getSlot } from '../state/server-state.js';
import { FRAME_FORCE_TENTHS_PER_LB } from '../state/live-signal.js';
import {
  aggregateSide,
  analyzeTrial,
  computeImbalance,
  decideTestOrder,
  type ForceSample,
  type SideAnalysis,
  type TrialAnalysis,
} from '../state/isometric-protocol.js';
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

const MEASURE_MAX_DESCRIPTION = [
  'Run the isometric maximum-force assessment protocol on one device slot.',
  'Performs N trials (default 3) of M-second max-effort holds (default 5s)',
  'with rest between trials (default 90s). Caller must pre-configure the',
  'device into Isometric mode and set resistance to a low value (or 0 lb if',
  'supported) before invoking — this tool does NOT change device settings.',
  '',
  'Returns per-trial peak/plateau forces, validity flags (continuous rise,',
  'peak after 1s, plateau ≥ 90% of peak), and the mean plateau force of',
  'the best 2 of N valid trials. The mean drives a 70% inferred working',
  'weight (rounded to 5 lb) for downstream programming.',
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
  'Asymmetry is reported as (stronger − weaker) / stronger × 100. Per the',
  'protocol brief, ≥ 10% is flagged as noteworthy and ≥ 15% is flagged as',
  'a meaningful deficit; within 1% is reported as a tie.',
  '',
  'Both slots must be connected before invoking. Each side runs the same',
  'measurement protocol as isometric.measure_max.',
  '',
  'The per-trial measurements are persisted (keyed on the device id of the',
  'unit that recorded them) so asymmetry can be trended across sessions;',
  'the response carries the resulting measurementId, or null if the write',
  'failed. The asymmetry percentage itself is not stored — it is recomputed',
  'from the stored trials.',
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

interface MeasureMaxInput {
  slot?: string | undefined;
  durationMs: number;
  trials: number;
  restMs: number;
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

interface MeasureMaxResult {
  ok: true;
  slot: string;
  trials: TrialAnalysis[];
  validTrialCount: number;
  meanPlateauForceLbs: number | null;
  cvPct: number | null;
  inferredWorkingWeightLbs: number | null;
  totalElapsedMs: number;
}

interface SideSummary {
  slot: string;
  meanPlateauForceLbs: number | null;
  inferredWorkingWeightLbs: number | null;
  cvPct: number | null;
  validTrialCount: number;
}

type TestOrder = ['left', 'right'] | ['right', 'left'];

interface MeasureImbalanceResult {
  ok: true;
  testOrder: TestOrder;
  left: SideSummary;
  right: SideSummary;
  imbalance: ReturnType<typeof computeImbalance>;
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

async function measureMax(state: ServerState, input: MeasureMaxInput): Promise<MeasureMaxResult> {
  const slotId = input.slot ?? PRIMARY_SLOT;
  const startedAt = Date.now();
  const result = await runSideProtocol(state, slotId, input);
  return {
    ok: true,
    slot: slotId,
    trials: result.analysis.trials,
    validTrialCount: result.analysis.validTrialCount,
    meanPlateauForceLbs: result.analysis.meanPlateauForceLbs,
    cvPct: result.analysis.cvPct,
    inferredWorkingWeightLbs: result.analysis.inferredWorkingWeightLbs,
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

  for (let i = 0; i < order.length; i++) {
    const sideLabel = order[i];
    const slotId = slotForSide[sideLabel];
    const sideResult = await runSideProtocol(state, slotId, input);
    sideResults.set(sideLabel, sideResult.analysis);
    if (i < order.length - 1) {
      await sleep(input.betweenSidesRestMs);
    }
  }

  const leftAnalysis = sideResults.get('left');
  const rightAnalysis = sideResults.get('right');
  const leftSlotId = slotForSide.left;
  const rightSlotId = slotForSide.right;

  const left: SideSummary = sideAsSummary(leftSlotId, leftAnalysis);
  const right: SideSummary = sideAsSummary(rightSlotId, rightAnalysis);
  const imbalance = computeImbalance(left, right);

  const measurementId = await persistMeasurement(state, {
    firstSideTested: order[0],
    input,
    sides: [
      { side: 'left', slotId: leftSlotId, trials: leftAnalysis?.trials ?? [] },
      { side: 'right', slotId: rightSlotId, trials: rightAnalysis?.trials ?? [] },
    ],
  });

  return {
    ok: true,
    testOrder: order as TestOrder,
    left,
    right,
    imbalance,
    totalElapsedMs: Date.now() - startedAt,
    measurementId,
  };
}

interface PersistSideInput {
  side: 'left' | 'right';
  slotId: string;
  trials: TrialAnalysis[];
}

/**
 * Write the assessment to the store (VMCP-04.11). Until this landed the tool
 * computed a real left/right asymmetry and dropped it on the floor, so nothing
 * about limb asymmetry survived the response — the one question bilateral
 * training exists to answer had no history behind it.
 *
 * What goes in: the per-trial measurements, plus the protocol parameters they
 * were collected under. What stays out: the asymmetry percentage and its
 * flagged/meaningful verdicts. Those are conclusions — one division and two
 * threshold comparisons away from the stored trials — and `computeImbalance`
 * recomputes them on read for free, always against current thresholds. A stored
 * verdict would be indistinguishable from a fresh one the day the thresholds
 * move.
 *
 * Identity: each side's trials carry the DEVICE ID read from that slot's
 * connected client at measurement time. That is the join key. `slot` rides
 * along for diagnostics only — `slot.swap` reassigns slot ids between physical
 * units, so a series keyed on slot would flip limbs mid-history with nothing
 * erroring. `side` is the limb the caller declared for this run (the whole
 * premise of the call: `primarySide` says which slot is on which limb), and it
 * is frozen at write time for the same reason `set.end` freezes it.
 *
 * Never throws. See `measurementId` on the result for why a store failure must
 * not take the measurement down with it.
 */
async function persistMeasurement(
  state: ServerState,
  args: {
    firstSideTested: 'left' | 'right';
    input: MeasureImbalanceInput;
    sides: PersistSideInput[];
  },
): Promise<string | null> {
  const measurement: StoredIsometricMeasurement = {
    id: randomUUID(),
    measuredAt: new Date().toISOString(),
    analysisVersion: ISOMETRIC_ANALYSIS_VERSION,
    firstSideTested: args.firstSideTested,
    durationMs: args.input.durationMs,
    trialsRequested: args.input.trials,
    restMs: args.input.restMs,
    betweenSidesRestMs: args.input.betweenSidesRestMs,
    sides: args.sides.map((s) => toStoredSide(state, s)),
  };
  try {
    await state.store.putIsometricMeasurement(measurement);
    return measurement.id;
  } catch (err) {
    log.warn('isometric.measure_imbalance: persisting the measurement failed', err);
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
    side: side.side,
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

interface RunSideResult {
  analysis: SideAnalysis;
}

async function runSideProtocol(
  state: ServerState,
  slotId: string,
  opts: { durationMs: number; trials: number; restMs: number },
): Promise<RunSideResult> {
  const slot = getSlot(state, slotId);
  ensureSlotConnected(slotId, slot);

  const trialAnalyses: TrialAnalysis[] = [];
  for (let i = 0; i < opts.trials; i++) {
    const samples = await captureTrial(slot.client, opts.durationMs);
    trialAnalyses.push(analyzeTrial(samples, i + 1));
    if (i < opts.trials - 1) {
      await sleep(opts.restMs);
    }
  }
  return { analysis: aggregateSide(trialAnalyses) };
}

/**
 * Subscribe to the slot client's `onFrame` for `durationMs`, accumulating
 * `{ tMs, forceLbs }` samples relative to the trial start. Always removes
 * the listener on completion (the `finally` block invokes the unsubscribe
 * handle returned by `onFrame`) so the bridge's other subscribers don't
 * compete with stale isometric listeners after the trial ends.
 */
async function captureTrial(
  client: { onFrame: (cb: (frame: TelemetryFrame) => void) => () => void },
  durationMs: number,
): Promise<ForceSample[]> {
  const samples: ForceSample[] = [];
  const startMs = Date.now();
  const unsubscribe = client.onFrame((frame: TelemetryFrame) => {
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
  try {
    await sleep(durationMs);
  } finally {
    if (typeof unsubscribe === 'function') {
      unsubscribe();
    }
  }
  return samples;
}

function ensureSlotConnected(slotId: string, slot: ReturnType<typeof getSlot>): void {
  if (!slot.client.isConnected) {
    throw new ToolError(
      'SLOT_NOT_BOUND',
      `Slot \`${slotId}\` is not connected. Connect a device first via device.connect.`,
    );
  }
}

function sideAsSummary(slotId: string, analysis: SideAnalysis | undefined): SideSummary {
  if (analysis === undefined) {
    return {
      slot: slotId,
      meanPlateauForceLbs: null,
      inferredWorkingWeightLbs: null,
      cvPct: null,
      validTrialCount: 0,
    };
  }
  return {
    slot: slotId,
    meanPlateauForceLbs: analysis.meanPlateauForceLbs,
    inferredWorkingWeightLbs: analysis.inferredWorkingWeightLbs,
    cvPct: analysis.cvPct,
    validTrialCount: analysis.validTrialCount,
  };
}

/**
 * Promise-based sleep that uses `setTimeout`. Tests use vitest fake
 * timers (`vi.useFakeTimers()`) and `vi.advanceTimersByTimeAsync(...)` to
 * drive the rest periods deterministically.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
