// Tool-layer integration tests for isometric.measure_hold,
// isometric.measure_max and isometric.measure_imbalance.
//
// Strategy: drive the registered tool callbacks with a fake VoltraClient
// that exposes only the surface the tool consumes (`isConnected`, `onFrame`).
// The tool subscribes to `onFrame` once per trial; the test harness fires
// synthetic TelemetryFrames during the trial window via `vi.useFakeTimers()`
// so a 5-second trial completes in microseconds. Rest periods are likewise
// driven by `vi.advanceTimersByTimeAsync`.
//
// Listener-leak guard: each test asserts that the unsubscribe handle
// returned from `onFrame` was called exactly once per trial. If the tool
// ever forgets to detach, the count diverges and the suite fails.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';

class FakeVoltraSDKError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'VoltraSDKError';
    this.code = code;
  }
}

vi.mock('@voltras/node-sdk', () => ({
  VoltraSDKError: FakeVoltraSDKError,
}));

const { registerIsometricTools } = await import('../isometric-tools.js');
const { makeFakeLease } = await import('../../state/__tests__/fixtures/lease-fence.js');
type FakeLease = ReturnType<typeof makeFakeLease>;

import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerState } from '../../state/server-state.js';
import type { TelemetryFrame } from '@voltras/node-sdk';
import { FRAME_FORCE_TENTHS_PER_LB } from '../../state/live-signal.js';
import type { ToolResult } from '../helpers.js';
import type { Rep } from '@voltras/workout-analytics';
import { LOCAL_USER_ID } from '../../store/types.js';
import type {
  IsometricHistoryFilter,
  IsometricMeasurementHistory,
  StoredExerciseSetup,
  StoredIsometricMeasurement,
  StoredSet,
} from '../../store/types.js';
import {
  McpChannelPublisher,
  noopChannelPublisher,
  type ChannelPublisher,
} from '../../state/channel-publisher.js';
import { DEFAULT_DURATION_MS, DEFAULT_MAX_REST_MS } from '../../schemas/isometric.js';

type Callback = (args: unknown, extra?: unknown) => Promise<ToolResult>;

interface Slot {
  callback: Callback;
  description?: string;
}

function buildPlaceholders(names: readonly string[]): {
  placeholders: Map<string, RegisteredTool>;
  slots: Map<string, Slot>;
} {
  const slots = new Map<string, Slot>();
  const placeholders = new Map<string, RegisteredTool>();
  for (const name of names) {
    const slot: Slot = {
      callback: async () => ({ content: [{ type: 'text', text: 'placeholder' }] }),
    };
    slots.set(name, slot);
    placeholders.set(name, {
      update: ({ description, callback }: { description?: string; callback?: Callback }) => {
        if (description !== undefined) slot.description = description;
        if (callback !== undefined) slot.callback = callback;
      },
    } as unknown as RegisteredTool);
  }
  return { placeholders, slots };
}

function payload(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

interface FrameListener {
  cb: (frame: TelemetryFrame) => void;
  unsubscribed: boolean;
}

interface FakeClient {
  isConnected: boolean;
  onFrame: Mock<(cb: (frame: TelemetryFrame) => void) => () => void>;
  /** VW-200: the abort path drops the load through `unloadSlot`. */
  unloadDevice: Mock<() => Promise<void>>;
  exitGuidedLoad: Mock<() => Promise<void>>;
  guidedLoadState: { phase: string };
  /** Every device write this client was asked to make, in order. */
  writes: string[];
  /** Active frame listeners, in subscription order. */
  listeners: FrameListener[];
  /** Lifetime count of calls to onFrame (subscription count). */
  subscribeCount: number;
  /** Lifetime count of unsubscribe calls. */
  unsubscribeCount: number;
}

function makeFakeClient(opts: { isConnected: boolean } = { isConnected: true }): FakeClient {
  const listeners: FrameListener[] = [];
  const writes: string[] = [];
  const fc = {
    isConnected: opts.isConnected,
    listeners,
    writes,
    guidedLoadState: { phase: 'idle' },
    unloadDevice: vi.fn(async (): Promise<void> => {
      writes.push('unloadDevice');
    }),
    exitGuidedLoad: vi.fn(async (): Promise<void> => {
      writes.push('exitGuidedLoad');
    }),
    subscribeCount: 0,
    unsubscribeCount: 0,
    onFrame: vi.fn((cb: (frame: TelemetryFrame) => void): (() => void) => {
      const entry: FrameListener = { cb, unsubscribed: false };
      listeners.push(entry);
      fc.subscribeCount += 1;
      return () => {
        if (!entry.unsubscribed) {
          entry.unsubscribed = true;
          fc.unsubscribeCount += 1;
        }
      };
    }),
  } as FakeClient;
  return fc;
}

interface FakeSlot {
  slotId: string;
  client: FakeClient;
  live: { session?: FakeSession };
}

/** The live session fields the tools read: the VW-284 exercise and the VW-280 keys. */
interface FakeSession {
  sessionId?: string;
  exerciseId?: string;
  lifter?: string;
}

/**
 * Records what `isometric.measure_imbalance` persists (VMCP-04.11) without
 * touching SQLite — the store contract is what the tool depends on, and the
 * SQLite half of it is covered by the v5→v6 migration suite.
 */
interface FakeStore {
  putIsometricMeasurement: Mock<(m: StoredIsometricMeasurement) => Promise<void>>;
  listRecentIsometricMeasurements: Mock<
    (opts?: {
      limit?: number;
      filter?: IsometricHistoryFilter;
    }) => Promise<IsometricMeasurementHistory>
  >;
  written: StoredIsometricMeasurement[];
  /** Measurements already on disk before this run; the direction series reads them. */
  seeded: StoredIsometricMeasurement[];
  /** Set to make every write reject, standing in for a broken DB. */
  failWith: Error | null;
  /** `exercise_setups` rows the VW-284 setup gate reads (`listExerciseSetups`). */
  listExerciseSetups: Mock<
    (f: { userId: string; exerciseId: string }) => Promise<StoredExerciseSetup[]>
  >;
  /** Working sets the VW-284 setup gate reads to derive a confirmed setup's ROM. */
  getSetsForExercise: Mock<
    (f: { userId: string; exerciseId: string; side?: 'left' | 'right' }) => Promise<StoredSet[]>
  >;
  /** Backing rows for the two mocks above. */
  exerciseSetups: StoredExerciseSetup[];
  sets: StoredSet[];
}

function makeFakeStore(): FakeStore {
  const store = {
    written: [],
    seeded: [],
    failWith: null,
    exerciseSetups: [],
    sets: [],
  } as unknown as FakeStore;
  store.putIsometricMeasurement = vi.fn(async (m: StoredIsometricMeasurement): Promise<void> => {
    if (store.failWith !== null) throw store.failWith;
    store.written.push(m);
    return Promise.resolve();
  });
  store.listRecentIsometricMeasurements = vi.fn(
    async (
      opts: { limit?: number; filter?: IsometricHistoryFilter } = {},
    ): Promise<IsometricMeasurementHistory> => {
      const all = [...store.seeded, ...store.written].sort(
        (a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt),
      );
      const { filter } = opts;
      // Mirrors the SQLite half (VW-280): a filter naming no exercise matches
      // the runs captured with no exercise, never every exercise.
      const matched =
        filter === undefined
          ? all
          : all.filter(
              (m) => m.userId === filter.userId && (m.exerciseId ?? null) === filter.exerciseId,
            );
      return Promise.resolve({
        measurements: matched.slice(0, opts.limit ?? 50),
        legacyUnkeyed: filter === undefined ? 0 : all.filter((m) => m.userId === undefined).length,
      });
    },
  );
  store.listExerciseSetups = vi.fn(async (f: { exerciseId: string }) =>
    store.exerciseSetups.filter((s) => s.exerciseId === f.exerciseId),
  );
  store.getSetsForExercise = vi.fn(async (f: { exerciseId: string; side?: 'left' | 'right' }) =>
    store.sets.filter(
      (s) => s.exerciseId === f.exerciseId && (f.side === undefined || s.side === f.side),
    ),
  );
  return store;
}

/** A minimal `Rep` whose concentric range of motion is exactly `romM`. */
function makeRep(repNumber: number, romM: number): Rep {
  const phase = {
    samples: [],
    startTime: 0,
    endTime: 0,
    startPosition: 0,
    endPosition: romM,
    _totalVelocity: 0,
    _totalForce: 0,
    _totalLoad: 0,
    _movementSampleCount: 0,
    _totalHoldDuration: 0,
    peakVelocity: 0,
    peakForce: 0,
    peakLoad: 0,
  };
  return { repNumber, concentric: phase, eccentric: phase };
}

/**
 * A confirmed `exercise_setups` row, feeding the VW-284 gate's "who vouched
 * for this?" check. `confirmedAt` absent models an inferred-but-unconfirmed
 * cluster, which the gate treats the same as no setup at all.
 */
function makeExerciseSetup(
  id: string,
  exerciseId: string,
  opts: { confirmed?: boolean } = {},
): StoredExerciseSetup {
  return {
    id,
    userId: 'local',
    exerciseId,
    label: id,
    ...(opts.confirmed !== false ? { confirmedAt: '2026-09-01T00:00:00.000Z' } : {}),
  };
}

/** A working set stamped with one confirmed setup's id, at a given cable-travel ROM. */
function makeExerciseSet(
  id: string,
  exerciseId: string,
  side: 'left' | 'right',
  setupId: string,
  romM: number,
): StoredSet {
  return {
    id,
    sessionId: `${id}-session`,
    startedAt: '2026-09-01T00:00:00.000Z',
    endedAt: '2026-09-01T00:05:00.000Z',
    partial: false,
    exerciseId,
    side,
    setupId,
    reps: [1, 2, 3].map((n) => ({
      ...makeRep(n, romM),
      id: `${id}-r${n}`,
      setId: id,
      index: n - 1,
    })),
  } as StoredSet;
}

/**
 * A past assessment on disk, reduced to what the direction series reads: two
 * valid trials per side at the given plateau forces. `aggregateSide` needs two
 * valid trials before a side has a mean at all.
 *
 * Keyed to the owner with no exercise by default (VW-280), which is what a run
 * on a slot with no open session resolves to — so a plain seed lands in the
 * series of a plain run. `keys` places a seed in someone else's series; omit
 * `userId` outright for a row written before the keying existed.
 */
function seededMeasurement(
  measuredAt: string,
  leftLbs: number,
  rightLbs: number,
  keys: { userId?: string; exerciseId?: string; asymmetryEquation?: string } = {
    userId: LOCAL_USER_ID,
  },
): StoredIsometricMeasurement {
  const trials = (lbs: number) =>
    [1, 2].map((index) => ({
      id: `${measuredAt}-${lbs}-${index}`,
      index,
      peakForceLbs: lbs + 2,
      plateauForceLbs: lbs,
      plateauStartMs: 1500,
      plateauEndMs: 2000,
      valid: true,
    }));
  return {
    id: `seed-${measuredAt}-${keys.userId ?? 'unkeyed'}-${keys.exerciseId ?? 'none'}`,
    measuredAt,
    analysisVersion: 1,
    firstSideTested: 'left',
    durationMs: 3000,
    trialsRequested: 2,
    restMs: 30_000,
    betweenSidesRestMs: 60_000,
    ...(keys.userId !== undefined ? { userId: keys.userId } : {}),
    ...(keys.exerciseId !== undefined ? { exerciseId: keys.exerciseId } : {}),
    ...(keys.asymmetryEquation !== undefined
      ? {
          asymmetryEquation:
            keys.asymmetryEquation as StoredIsometricMeasurement['asymmetryEquation'],
        }
      : {}),
    sides: [
      { side: 'left', slot: 'left', trials: trials(leftLbs) },
      { side: 'right', slot: 'right', trials: trials(rightLbs) },
    ],
  };
}

interface PublishedEvent {
  content: string;
  meta: Record<string, string>;
}

/**
 * A real `McpChannelPublisher` over a fake notification sink, so the phase
 * assertions see the same envelope production does — including the `slot` and
 * `at` meta keys `forSlot` injects, which no payload builder sets itself.
 */
function makeChannels(published: PublishedEvent[]): ChannelPublisher {
  const server = {
    server: {
      notification: (n: { params: PublishedEvent }): Promise<void> => {
        published.push(n.params);
        return Promise.resolve();
      },
    },
  } as unknown as McpServer;
  return new McpChannelPublisher(server);
}

function makeState(
  slots: Record<string, FakeClient>,
  opts: {
    store?: FakeStore;
    deviceIds?: Record<string, string | null>;
    channels?: ChannelPublisher;
    lease?: FakeLease;
    mountRatingLbs?: number;
    /** Per-slot active-session exerciseId, for the VW-284 setup gate. */
    exerciseIds?: Record<string, string | undefined>;
    /** Per-slot active session, for the VW-280 keys. Wins over `exerciseIds`. */
    sessions?: Record<string, FakeSession | undefined>;
  } = {},
): ServerState {
  const slotMap = new Map<string, FakeSlot>();
  for (const [slotId, client] of Object.entries(slots)) {
    // `connectedDeviceId` is the ground-truth identity the tool stamps onto the
    // persisted measurement; `null` models the mock adapter / a dropped unit.
    (client as unknown as { connectedDeviceId: string | null }).connectedDeviceId =
      opts.deviceIds?.[slotId] ?? null;
    const exerciseId = opts.exerciseIds?.[slotId];
    const session =
      opts.sessions?.[slotId] ?? (exerciseId !== undefined ? { exerciseId } : undefined);
    slotMap.set(slotId, { slotId, client, live: { session } });
  }
  return {
    slots: slotMap,
    store: opts.store,
    channels: opts.channels ?? noopChannelPublisher,
    lease: opts.lease ?? makeFakeLease(),
    // Unconfigured (VW-274) by default — most tests do not care about the
    // mount-rating gate and get the warning-only path automatically.
    config: { mountRatingLbs: opts.mountRatingLbs },
  } as unknown as ServerState;
}

/**
 * Build a force-rise → plateau → release shape spanning `durationMs` and
 * fire frames into every active listener at the supplied cadence. Consumes
 * fake-timer ticks via `vi.advanceTimersByTimeAsync` so a measurement
 * trial completes deterministically within the test.
 */
async function pumpTrialFrames(
  client: FakeClient,
  durationMs: number,
  peakLbs: number,
  cadenceMs: number = 25,
): Promise<void> {
  const ticks = Math.floor(durationMs / cadenceMs);
  for (let i = 0; i <= ticks; i++) {
    const t = (i * cadenceMs) / durationMs;
    let forceLbs: number;
    if (t < 0.4) forceLbs = peakLbs * (t / 0.4);
    else if (t < 0.9) forceLbs = peakLbs;
    else forceLbs = peakLbs * Math.max(0, 1 - (t - 0.9) * 5);
    const frame: TelemetryFrame = {
      sequence: i,
      phase: 0 as TelemetryFrame['phase'],
      position: 0,
      velocity: 0,
      // Frames carry the raw device unit (tenths of a pound); the isometric
      // tool converts tenths→lb, so emit peakLbs × FRAME_FORCE_TENTHS_PER_LB
      // to land plateau/inferred-weight assertions back on the intended lbs.
      force: forceLbs * FRAME_FORCE_TENTHS_PER_LB,
      timestamp: Date.now(),
    };
    for (const l of client.listeners) {
      if (!l.unsubscribed) l.cb(frame);
    }
    await vi.advanceTimersByTimeAsync(cadenceMs);
  }
}

const TOOL_NAMES = [
  'isometric.measure_hold',
  'isometric.measure_max',
  'isometric.measure_imbalance',
] as const;

/** Phase names, in publish order, from the recorded `isometric_phase` events. */
function phasesOf(published: PublishedEvent[]): string[] {
  return published.filter((e) => e.meta.event_type === 'isometric_phase').map((e) => e.meta.phase);
}

/** The `isometric_result` push body (VW-264), as a consumer reads it off `content`. */
interface IsometricResultBody {
  tool: string;
  sides: { side: string | null; slot: string; peakForceLbs: number | null }[];
  asymmetryPct: number | null;
  verdict: string | null;
  comparability: string | null;
  setupReason: string | null;
}

/** Trial numbers off the phase pushes only — `isometric_result` belongs to no trial. */
function trialsOf(published: PublishedEvent[]): string[] {
  return published.filter((e) => e.meta.event_type === 'isometric_phase').map((e) => e.meta.trial);
}

/** The `label` carried on each `isometric_phase` push's content (VW-294: distinguishes warm-up pulls from real trials). */
function labelsOf(published: PublishedEvent[]): (string | null)[] {
  return published
    .filter((e) => e.meta.event_type === 'isometric_phase')
    .map((e) => (JSON.parse(e.content) as { isometric: { label: string | null } }).isometric.label);
}

interface MeasureHoldBody {
  ok: boolean;
  slot: string;
  side: string | null;
  label: string | null;
  holdMs: number;
  trial: { index: number; valid: boolean; peakForceLbs: number };
  peakForceLbs: number;
  jointAngleGate: {
    comparability: string;
    reason: string;
    exercisePeakAngleDeg: number | null;
    setupAngleDeg: number | null;
    deltaDeg: number | null;
  };
}

describe('the advertised isometric hold default', () => {
  // The tool descriptions state the default in seconds as a literal, and the
  // published capability reference is generated from them. Deriving the
  // expected wording from the constant is what ties the two together: change
  // the constant alone and the prose no longer describes the tool.
  it('matches the duration the schema actually defaults to', () => {
    const { placeholders, slots } = buildPlaceholders(TOOL_NAMES);
    registerIsometricTools({} as McpServer, makeState({ primary: makeFakeClient() }), placeholders);

    expect(DEFAULT_DURATION_MS).toBe(5_000);
    for (const name of ['isometric.measure_hold', 'isometric.measure_max'] as const) {
      expect(slots.get(name)!.description).toContain(`default ${DEFAULT_DURATION_MS / 1000}s`);
    }
  });
});

describe('isometric.measure_hold', () => {
  let measureHoldCb: Callback;
  let client: FakeClient;
  let published: PublishedEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    client = makeFakeClient();
    published = [];
    const state = makeState({ primary: client }, { channels: makeChannels(published) });
    const { placeholders, slots } = buildPlaceholders(TOOL_NAMES);
    registerIsometricTools({} as McpServer, state, placeholders);
    measureHoldCb = slots.get('isometric.measure_hold')!.callback;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('captures exactly one hold and returns its analysis', async () => {
    const promise = measureHoldCb({ holdMs: 3000 });
    await pumpTrialFrames(client, 3000, 200);

    const body = payload(await promise) as MeasureHoldBody;
    expect(body.ok).toBe(true);
    expect(body.slot).toBe('primary');
    expect(body.trial.index).toBe(1);
    expect(body.trial.valid).toBe(true);
    // The top-level peak echoes the analysis, so a hold that fails a gate
    // still reports what the athlete pulled.
    expect(body.peakForceLbs).toBe(body.trial.peakForceLbs);
    expect(body.peakForceLbs).toBeGreaterThan(190);
    // One subscription, one detach: no trial loop, no listener left behind.
    expect(client.subscribeCount).toBe(1);
    expect(client.unsubscribeCount).toBe(1);
  });

  it('returns at the end of the hold, with no rest wait', async () => {
    const promise = measureHoldCb({ holdMs: 3000 });
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(settled).toBe(true);
  });

  it('publishes ready → go → hold → stop, slot-scoped and stamped', async () => {
    const promise = measureHoldCb({ holdMs: 3000, side: 'left', label: 'left knee ext' });
    await pumpTrialFrames(client, 3000, 200);
    await promise;

    expect(phasesOf(published)).toEqual(['ready', 'go', 'hold', 'stop']);
    for (const event of published) {
      expect(event.meta.slot).toBe('primary');
      expect(Date.parse(event.meta.at)).not.toBeNaN();
      expect(event.meta.trial).toBe('1');
      expect(event.meta.hold_ms).toBe('3000');
      expect(event.meta.side).toBe('left');
    }
    const go = JSON.parse(published[1].content) as {
      summary: string;
      isometric: Record<string, unknown>;
    };
    expect(go.isometric).toEqual({
      phase: 'go',
      trial: 1,
      hold_ms: 3000,
      side: 'left',
      label: 'left knee ext',
    });
    expect(go.summary).toContain('left knee ext');
  });

  it('leaves side and label out of the pushes when the caller states neither', async () => {
    const promise = measureHoldCb({ holdMs: 3000 });
    await pumpTrialFrames(client, 3000, 200);
    const body = payload(await promise) as MeasureHoldBody;

    expect(body.side).toBeNull();
    expect(body.label).toBeNull();
    expect(published[0].meta).not.toHaveProperty('side');
    const ready = JSON.parse(published[0].content) as { isometric: Record<string, unknown> };
    expect(ready.isometric).toMatchObject({ side: null, label: null });
  });

  it('holds for the protocol default duration when holdMs is omitted', async () => {
    const promise = measureHoldCb({});
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_DURATION_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const body = payload(await promise) as MeasureHoldBody;
    expect(body.holdMs).toBe(DEFAULT_DURATION_MS);
    expect(published[0].meta.hold_ms).toBe(String(DEFAULT_DURATION_MS));
  });

  it('returns SLOT_NOT_BOUND, and pushes nothing, when the slot is not connected', async () => {
    client.isConnected = false;
    const result = await measureHoldCb({ holdMs: 3000 });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'SLOT_NOT_BOUND' });
    // A `ready` push for a hold that can never happen would signal the athlete
    // to get set for nothing.
    expect(published).toEqual([]);
  });
});

// VW-296: joint angle dominates what an isometric hold predicts about the
// dynamic lift (Lum, Haff & Barbosa 2020). `isometric.measure_hold` compares
// a declared setup angle against the exercise's known peak-force angle and
// warns (default) or refuses (`strict: true`) on a material mismatch.
describe('isometric.measure_hold — joint-angle gate (VW-296)', () => {
  let measureHoldCb: Callback;
  let client: FakeClient;
  let published: PublishedEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    client = makeFakeClient();
    published = [];
    const state = makeState({ primary: client }, { channels: makeChannels(published) });
    const { placeholders, slots } = buildPlaceholders(TOOL_NAMES);
    registerIsometricTools({} as McpServer, state, placeholders);
    measureHoldCb = slots.get('isometric.measure_hold')!.callback;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('matched angle: comparable, and the hold runs normally', async () => {
    const promise = measureHoldCb({ holdMs: 3000, exerciseId: 'cable-squat', setupAngleDeg: 92 });
    await pumpTrialFrames(client, 3000, 200);
    const body = payload(await promise) as MeasureHoldBody;

    expect(body.ok).toBe(true);
    expect(body.jointAngleGate).toMatchObject({
      comparability: 'comparable',
      exercisePeakAngleDeg: 90,
      setupAngleDeg: 92,
      deltaDeg: 2,
    });
  });

  it('mismatched angle: warns by default, but the hold still runs', async () => {
    const promise = measureHoldCb({ holdMs: 3000, exerciseId: 'cable-squat', setupAngleDeg: 120 });
    await pumpTrialFrames(client, 3000, 200);
    const body = payload(await promise) as MeasureHoldBody;

    expect(body.ok).toBe(true);
    expect(body.jointAngleGate).toMatchObject({
      comparability: 'angle_mismatch',
      exercisePeakAngleDeg: 90,
      setupAngleDeg: 120,
      deltaDeg: 30,
    });
    expect(body.jointAngleGate.reason).toContain('Lum, Haff & Barbosa 2020');
    // The gate warned, not refused — a hold was actually captured.
    expect(phasesOf(published)).toEqual(['ready', 'go', 'hold', 'stop']);
  });

  it('mismatched angle with strict: true refuses INVALID_INPUT before the hold begins', async () => {
    const result = await measureHoldCb({
      holdMs: 3000,
      exerciseId: 'cable-squat',
      setupAngleDeg: 120,
      strict: true,
    });

    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(published).toEqual([]);
  });

  it('unknown exercise: angle_unverified, no gate, hold still runs', async () => {
    const promise = measureHoldCb({
      holdMs: 3000,
      exerciseId: 'cable-row',
      setupAngleDeg: 90,
    });
    await pumpTrialFrames(client, 3000, 200);
    const body = payload(await promise) as MeasureHoldBody;

    expect(body.jointAngleGate).toMatchObject({
      comparability: 'angle_unverified',
      exercisePeakAngleDeg: null,
      deltaDeg: null,
    });
  });

  it('no exerciseId given: angle_unverified — the pre-VW-296 call shape still works', async () => {
    const promise = measureHoldCb({ holdMs: 3000 });
    await pumpTrialFrames(client, 3000, 200);
    const body = payload(await promise) as MeasureHoldBody;

    expect(body.jointAngleGate).toMatchObject({
      comparability: 'angle_unverified',
      exercisePeakAngleDeg: null,
      setupAngleDeg: null,
      deltaDeg: null,
    });
  });
});

// VW-274: no wall/rack anchor rating is published for any mount, so isometric
// max force (up to 400 lb per unit) must be gated against a configured
// rating, refused before any hold begins when it exceeds one, and flagged as
// UNKNOWN — not safe — when no rating is configured.
describe('isometric mount-load gate — measure_hold and measure_max', () => {
  let client: FakeClient;

  function build(mountRatingLbs: number | undefined): {
    measureHoldCb: Callback;
    measureMaxCb: Callback;
  } {
    vi.useFakeTimers();
    client = makeFakeClient();
    const state = makeState({ primary: client }, { mountRatingLbs });
    const { placeholders, slots } = buildPlaceholders(TOOL_NAMES);
    registerIsometricTools({} as McpServer, state, placeholders);
    return {
      measureHoldCb: slots.get('isometric.measure_hold')!.callback,
      measureMaxCb: slots.get('isometric.measure_max')!.callback,
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('measure_hold: proceeds and reports the peak when the rating covers it', async () => {
    const { measureHoldCb } = build(500);
    const promise = measureHoldCb({ holdMs: 3000 });
    await pumpTrialFrames(client, 3000, 200);
    const body = payload(await promise) as MeasureHoldBody & { mountLoadWarning: string | null };
    expect(body.ok).toBe(true);
    expect(body.mountLoadWarning).toBeNull();
  });

  it('measure_hold: refuses INVALID_INPUT before any hold when the rating is exceeded', async () => {
    const { measureHoldCb } = build(350);
    const result = await measureHoldCb({ holdMs: 3000 });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
    // Refused before the hold: no subscription, no phase push at all.
    expect(client.subscribeCount).toBe(0);
  });

  it('measure_hold: warns, and still proceeds, when no rating is configured', async () => {
    const { measureHoldCb } = build(undefined);
    const promise = measureHoldCb({ holdMs: 3000 });
    await pumpTrialFrames(client, 3000, 200);
    const body = payload(await promise) as MeasureHoldBody & { mountLoadWarning: string | null };
    expect(body.ok).toBe(true);
    expect(body.mountLoadWarning).toContain('UNKNOWN');
  });

  it('measure_max: proceeds and reports null warning when the rating covers it', async () => {
    const { measureMaxCb } = build(500);
    const promise = measureMaxCb({ durationMs: 3000, trials: 2, restMs: 30_000, warmup: false });
    await pumpTrialFrames(client, 3000, 200);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(client, 3000, 195);
    const body = payload(await promise) as { ok: boolean; mountLoadWarning: string | null };
    expect(body.ok).toBe(true);
    expect(body.mountLoadWarning).toBeNull();
  });

  it('measure_max: refuses INVALID_INPUT before any trial when the rating is exceeded', async () => {
    const { measureMaxCb } = build(350);
    const result = await measureMaxCb({
      durationMs: 3000,
      trials: 2,
      restMs: 30_000,
      warmup: false,
    });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(client.subscribeCount).toBe(0);
  });

  it('measure_max: warns, and still proceeds, when no rating is configured', async () => {
    const { measureMaxCb } = build(undefined);
    const promise = measureMaxCb({ durationMs: 3000, trials: 2, restMs: 30_000, warmup: false });
    await pumpTrialFrames(client, 3000, 200);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(client, 3000, 195);
    const body = payload(await promise) as { ok: boolean; mountLoadWarning: string | null };
    expect(body.ok).toBe(true);
    expect(body.mountLoadWarning).toContain('UNKNOWN');
  });
});

describe('isometric.measure_max', () => {
  let measureMaxCb: Callback;
  let client: FakeClient;
  let published: PublishedEvent[];
  let store: FakeStore;

  beforeEach(() => {
    vi.useFakeTimers();
    client = makeFakeClient();
    published = [];
    store = makeFakeStore();
    const state = makeState(
      { primary: client },
      { channels: makeChannels(published), store, deviceIds: { primary: 'device-1' } },
    );
    const { placeholders, slots } = buildPlaceholders(TOOL_NAMES);
    registerIsometricTools({} as McpServer, state, placeholders);
    measureMaxCb = slots.get('isometric.measure_max')!.callback;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  interface MeasureMaxBody {
    ok: boolean;
    slot: string;
    trials: Array<{
      valid: boolean;
      peakForceLbs: number;
      plateauForceLbs: number;
      diagnostic: { rfdLbPerS: number; impulseLbS: number };
    }>;
    validTrialCount: number;
    meanPeakForceLbs: number | null;
    inferredWorkingWeightLbs: number | null;
    peakForceBaseline: {
      sampleSize: number;
      meanLbs: number;
      semLbs: number;
      cvPct: number;
    } | null;
    changeFromBaseline: { changed: boolean; deltaLbs: number; thresholdLbs: number } | null;
    measurementId: string | null;
  }

  it('happy path: returns valid trials, mean peak force, inferred working weight', async () => {
    // Use minimum-allowed durations to keep the test fast even at fake-time
    // resolution (3s × 2 trials, 30s rest = 36s of fake time).
    const promise = measureMaxCb({
      durationMs: 3000,
      trials: 2,
      restMs: 30_000,
      warmup: false,
    });

    // Pump frames for trial 1.
    await pumpTrialFrames(client, 3000, 200);
    // Drain the rest period.
    await vi.advanceTimersByTimeAsync(30_000);
    // Pump frames for trial 2.
    await pumpTrialFrames(client, 3000, 195);

    const result = await promise;
    const body = payload(result) as MeasureMaxBody;
    expect(body.ok).toBe(true);
    expect(body.slot).toBe('primary');
    expect(body.trials).toHaveLength(2);
    expect(body.trials.every((t) => t.valid)).toBe(true);
    expect(body.validTrialCount).toBe(2);
    expect(body.meanPeakForceLbs).toBeGreaterThan(170);
    expect(body.meanPeakForceLbs).toBeLessThanOrEqual(200);
    expect(body.inferredWorkingWeightLbs).toBeGreaterThan(110);
    // Every trial reports diagnostic-only RFD/impulse alongside peak/plateau.
    for (const trial of body.trials) {
      expect(trial.diagnostic.rfdLbPerS).toBeGreaterThan(0);
      expect(trial.diagnostic.impulseLbS).toBeGreaterThan(0);
    }
    // Two onFrame subscriptions, two unsubscribe calls — no listener leak.
    expect(client.subscribeCount).toBe(2);
    expect(client.unsubscribeCount).toBe(2);
  });

  it('persists the run and reports null baseline with fewer than 3 past occasions', async () => {
    const promise = measureMaxCb({ durationMs: 3000, trials: 2, restMs: 30_000, warmup: false });
    await pumpTrialFrames(client, 3000, 200);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(client, 3000, 195);
    const body = payload(await promise) as MeasureMaxBody;

    expect(body.measurementId).not.toBeNull();
    expect(store.written).toHaveLength(1);
    expect(store.written[0]!.sides).toHaveLength(1);
    expect(store.written[0]!.sides[0]!.side).toBeUndefined();
    expect(store.written[0]!.sides[0]!.deviceId).toBe('device-1');
    expect(body.peakForceBaseline).toBeNull();
    expect(body.changeFromBaseline).toBeNull();
  });

  it('flags a change against the baseline only when it clears the adjusted SEM', async () => {
    // Seed 3 past occasions around 100 lb (tight spread) so the baseline is
    // established before this run, which pulls to ~200 lb — far outside any
    // plausible adjusted SEM off a ~100 lb baseline.
    store.seeded = [
      seededMeasurement('2026-09-01T00:00:00.000Z', 100, 100),
      seededMeasurement('2026-09-03T00:00:00.000Z', 101, 101),
      seededMeasurement('2026-09-05T00:00:00.000Z', 99, 99),
    ];
    const promise = measureMaxCb({ durationMs: 3000, trials: 2, restMs: 30_000, warmup: false });
    await pumpTrialFrames(client, 3000, 200);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(client, 3000, 200);
    const body = payload(await promise) as MeasureMaxBody;

    expect(body.peakForceBaseline).not.toBeNull();
    expect(body.peakForceBaseline!.sampleSize).toBe(6); // 3 occasions × 2 sides, pooled
    expect(body.changeFromBaseline).not.toBeNull();
    expect(body.changeFromBaseline!.changed).toBe(true);
    // This run's own trials must not have leaked into the baseline it was
    // judged against — it was read before persisting.
    expect(body.peakForceBaseline!.meanLbs).toBeLessThan(150);
  });

  it('runs N holds over the same primitive, one phase cycle per trial', async () => {
    const promise = measureMaxCb({ durationMs: 3000, trials: 2, restMs: 30_000, warmup: false });
    await pumpTrialFrames(client, 3000, 200);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(client, 3000, 195);
    const body = payload(await promise) as { trials: unknown[] };

    expect(body.trials).toHaveLength(2);
    // The multi-trial path is the single-hold path, twice — and the trial
    // number on the pushes is what tells the two cycles apart.
    expect(phasesOf(published)).toEqual([
      'ready',
      'go',
      'hold',
      'stop',
      'ready',
      'go',
      'hold',
      'stop',
    ]);
    expect(trialsOf(published)).toEqual(['1', '1', '1', '1', '2', '2', '2', '2']);
  });

  it('publishes one isometric_result after the last trial (VW-264)', async () => {
    const promise = measureMaxCb({ durationMs: 3000, trials: 2, restMs: 30_000, warmup: false });
    await pumpTrialFrames(client, 3000, 200);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(client, 3000, 195);
    await promise;

    const results = published.filter((e) => e.meta.event_type === 'isometric_result');
    expect(results).toHaveLength(1);
    // Single-sided: one peak, no asymmetry to report and so no verdict to give.
    const body = (JSON.parse(results[0].content) as { isometric_result: Record<string, unknown> })
      .isometric_result;
    expect(body.tool).toBe('isometric.measure_max');
    expect(body.asymmetryPct).toBeNull();
    expect(body.verdict).toBeNull();
    expect(body.sides).toHaveLength(1);
  });

  it('returns null mean when fewer than 2 trials are valid', async () => {
    // Use 2 trials but fire NO frames during them — every trial fails the
    // "no samples captured" gate, so 0 valid → mean is null.
    const promise = measureMaxCb({
      durationMs: 3000,
      trials: 2,
      restMs: 30_000,
      warmup: false,
    });
    await vi.advanceTimersByTimeAsync(3000); // trial 1 elapses with no frames
    await vi.advanceTimersByTimeAsync(30_000); // rest
    await vi.advanceTimersByTimeAsync(3000); // trial 2 elapses with no frames
    const result = await promise;
    const body = payload(result) as {
      validTrialCount: number;
      meanPeakForceLbs: number | null;
      inferredWorkingWeightLbs: number | null;
    };
    expect(body.validTrialCount).toBe(0);
    expect(body.meanPeakForceLbs).toBeNull();
    expect(body.inferredWorkingWeightLbs).toBeNull();
  });

  it('rejects durationMs out of range with INVALID_INPUT', async () => {
    const result = await measureMaxCb({ durationMs: 1000 });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects trials out of range with INVALID_INPUT', async () => {
    const result = await measureMaxCb({ trials: 10 });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('returns SLOT_NOT_BOUND when the slot is not connected', async () => {
    client.isConnected = false;
    const result = await measureMaxCb({
      durationMs: 3000,
      trials: 2,
      restMs: 30_000,
      warmup: false,
    });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'SLOT_NOT_BOUND' });
  });

  it('honors restMs between trials (vi.useFakeTimers + advance asserts the wait)', async () => {
    // Kick off a 2-trial measurement with a 90s rest. Verify that after
    // trial 1's frames + duration, advancing by 89,999ms does NOT complete
    // the call, but advancing the final 1ms + trial 2's window does.
    const promise = measureMaxCb({
      durationMs: 3000,
      trials: 2,
      restMs: 90_000,
      warmup: false,
    });
    await pumpTrialFrames(client, 3000, 200);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    // Drain the rest period less one ms.
    await vi.advanceTimersByTimeAsync(89_999);
    expect(settled).toBe(false);
    // Final ms + trial 2.
    await vi.advanceTimersByTimeAsync(1);
    await pumpTrialFrames(client, 3000, 195);
    await promise;
    expect(settled).toBe(true);
  });
});

describe('isometric.measure_max — warm-up ramp (VW-294)', () => {
  let measureMaxCb: Callback;
  let client: FakeClient;
  let published: PublishedEvent[];
  let store: FakeStore;

  beforeEach(() => {
    vi.useFakeTimers();
    client = makeFakeClient();
    published = [];
    store = makeFakeStore();
    const state = makeState(
      { primary: client },
      { channels: makeChannels(published), store, deviceIds: { primary: 'device-1' } },
    );
    const { placeholders, slots } = buildPlaceholders(TOOL_NAMES);
    registerIsometricTools({} as McpServer, state, placeholders);
    measureMaxCb = slots.get('isometric.measure_max')!.callback;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  interface WarmupBody {
    warmup: { effortLevel: number; peakForceLbs: number; holdMs: number }[];
    trials: unknown[];
    validTrialCount: number;
    meanPeakForceLbs: number | null;
  }

  /** Drive the default-on ramp (2 warm-up pulls) then 2 real trials, all at `restMs`. */
  async function driveDefaultWarmupRun(restMs: number): Promise<{
    promise: Promise<ToolResult>;
  }> {
    const promise = measureMaxCb({ durationMs: 3000, trials: 2, restMs });
    await pumpTrialFrames(client, 3000, 100); // warm-up pull 1 (~50% effort)
    await vi.advanceTimersByTimeAsync(restMs);
    await pumpTrialFrames(client, 3000, 150); // warm-up pull 2 (~75% effort)
    await vi.advanceTimersByTimeAsync(restMs);
    await pumpTrialFrames(client, 3000, 200); // trial 1
    await vi.advanceTimersByTimeAsync(restMs);
    await pumpTrialFrames(client, 3000, 195); // trial 2
    return { promise };
  }

  it('runs the ramp (50%, then 75% effort) and the inter-hold rest unprompted, by default', async () => {
    const { promise } = await driveDefaultWarmupRun(DEFAULT_MAX_REST_MS);
    const body = payload(await promise) as WarmupBody;

    // Ramp + 2 real trials = 4 ready/go/hold/stop cycles, with no coach call
    // in between — the whole sequence ran off one measure_max invocation.
    expect(phasesOf(published)).toEqual([
      'ready',
      'go',
      'hold',
      'stop',
      'ready',
      'go',
      'hold',
      'stop',
      'ready',
      'go',
      'hold',
      'stop',
      'ready',
      'go',
      'hold',
      'stop',
    ]);
    expect(labelsOf(published)).toEqual([
      'warm-up (50% effort)',
      'warm-up (50% effort)',
      'warm-up (50% effort)',
      'warm-up (50% effort)',
      'warm-up (75% effort)',
      'warm-up (75% effort)',
      'warm-up (75% effort)',
      'warm-up (75% effort)',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);

    expect(body.warmup).toHaveLength(2);
    expect(body.warmup[0]!.effortLevel).toBe(0.5);
    expect(body.warmup[0]!.peakForceLbs).toBeGreaterThan(80);
    expect(body.warmup[1]!.effortLevel).toBe(0.75);
    expect(body.warmup[1]!.peakForceLbs).toBeGreaterThan(130);

    // The warm-up pulls (100/150 lb) never join the real trials (200/195 lb).
    expect(body.trials).toHaveLength(2);
    expect(body.validTrialCount).toBe(2);
    expect(body.meanPeakForceLbs).toBeGreaterThan(190);
  });

  it('defaults restMs to DEFAULT_MAX_REST_MS (2 min) when the caller gives none', async () => {
    // No restMs at all, and warmup off so exactly ONE rest gap is in play —
    // isolates the schema default the same way the pre-VW-294 restMs test
    // isolates an explicit value. 1ms short of DEFAULT_MAX_REST_MS must NOT
    // be enough; this is what catches a default that silently reverts to
    // the old 90s (a shorter rest completes, and trial 2 — needing no more
    // frames to finish an invalid hold — settles well before this checkpoint).
    const promise = measureMaxCb({ durationMs: 3000, trials: 2, warmup: false });
    await pumpTrialFrames(client, 3000, 200);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_MAX_REST_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pumpTrialFrames(client, 3000, 195);
    await promise;
    expect(settled).toBe(true);
  });

  it('warmup: false skips the ramp entirely — only the real trials run', async () => {
    const promise = measureMaxCb({
      durationMs: 3000,
      trials: 2,
      restMs: 30_000,
      warmup: false,
    });
    await pumpTrialFrames(client, 3000, 200);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(client, 3000, 195);
    const body = payload(await promise) as WarmupBody;

    expect(body.warmup).toEqual([]);
    expect(phasesOf(published)).toEqual([
      'ready',
      'go',
      'hold',
      'stop',
      'ready',
      'go',
      'hold',
      'stop',
    ]);
    expect(labelsOf(published)).toEqual([null, null, null, null, null, null, null, null]);
    expect(body.trials).toHaveLength(2);
  });

  it('does not persist the warm-up pulls — only the real trials are stored', async () => {
    const { promise } = await driveDefaultWarmupRun(30_000);
    await promise;

    expect(store.written).toHaveLength(1);
    expect(store.written[0]!.sides).toHaveLength(1);
    // 2 real trials stored, not 4 — the 2 warm-up pulls never joined them.
    expect(store.written[0]!.sides[0]!.trials).toHaveLength(2);
  });
});

describe('isometric.measure_imbalance', () => {
  let measureImbalanceCb: Callback;
  let leftClient: FakeClient;
  let rightClient: FakeClient;
  let store: FakeStore;
  let published: PublishedEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    leftClient = makeFakeClient();
    rightClient = makeFakeClient();
    store = makeFakeStore();
    published = [];
    const state = makeState(
      { left: leftClient, right: rightClient },
      {
        store,
        deviceIds: { left: 'AA:BB:CC:01', right: 'AA:BB:CC:02' },
        channels: makeChannels(published),
      },
    );
    const { placeholders, slots } = buildPlaceholders(TOOL_NAMES);
    registerIsometricTools({} as McpServer, state, placeholders);
    measureImbalanceCb = slots.get('isometric.measure_imbalance')!.callback;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('happy path: both sides return valid → imbalance computed', async () => {
    const promise = measureImbalanceCb({
      primarySlot: 'left',
      secondarySlot: 'right',
      primarySide: 'left',
      durationMs: 3000,
      trials: 2,
      restMs: 30_000,
      betweenSidesRestMs: 60_000,
      testNonDominantFirst: false,
      dominantSide: 'unknown',
    });

    // Order is [left, right]. Pump left's two trials, then between-sides
    // rest, then right's two trials.
    await pumpTrialFrames(leftClient, 3000, 200);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(leftClient, 3000, 195);
    await vi.advanceTimersByTimeAsync(60_000);
    await pumpTrialFrames(rightClient, 3000, 180);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(rightClient, 3000, 175);

    const result = await promise;
    const body = payload(result) as {
      ok: boolean;
      testOrder: string[];
      left: { meanPeakForceLbs: number | null };
      right: { meanPeakForceLbs: number | null };
      imbalance: { direction: string | null; equation: string; real: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.testOrder).toEqual(['left', 'right']);
    expect(body.left.meanPeakForceLbs).toBeGreaterThan(170);
    expect(body.right.meanPeakForceLbs).toBeGreaterThan(150);
    expect(body.imbalance.direction).toBe('left');
    expect(body.imbalance.equation).toBe('standard-percentage-difference');
    // No listener leaks on either client (2 trials × 1 sub each).
    expect(leftClient.subscribeCount).toBe(2);
    expect(leftClient.unsubscribeCount).toBe(2);
    expect(rightClient.subscribeCount).toBe(2);
    expect(rightClient.unsubscribeCount).toBe(2);

    // VW-264: one result push, after both sides ran, carrying both peaks and the
    // same verdict the tool result reports. No slot on the envelope — a two-slot
    // answer cannot honestly be stamped with either one.
    const results = published.filter((e) => e.meta.event_type === 'isometric_result');
    expect(results).toHaveLength(1);
    expect(results[0].meta).not.toHaveProperty('slot');
    const pushed = (JSON.parse(results[0].content) as { isometric_result: IsometricResultBody })
      .isometric_result;
    expect(pushed.tool).toBe('isometric.measure_imbalance');
    expect(pushed.verdict).toBe(body.imbalance.real ? 'meaningful' : 'flagged');
    expect(pushed.sides.map((s) => s.side)).toEqual(['left', 'right']);
    expect(pushed.sides[0].peakForceLbs).toBeGreaterThan(170);
    expect(pushed.asymmetryPct).toBeGreaterThan(0);
  });

  it('testNonDominantFirst with primary=left + dominantSide=left swaps test order', async () => {
    const promise = measureImbalanceCb({
      primarySlot: 'left',
      secondarySlot: 'right',
      primarySide: 'left',
      durationMs: 3000,
      trials: 2,
      restMs: 30_000,
      betweenSidesRestMs: 60_000,
      testNonDominantFirst: true,
      dominantSide: 'left',
    });

    // testOrder should be [right, left] — fire frames in that order.
    await pumpTrialFrames(rightClient, 3000, 180);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(rightClient, 3000, 175);
    await vi.advanceTimersByTimeAsync(60_000);
    await pumpTrialFrames(leftClient, 3000, 200);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(leftClient, 3000, 195);

    const result = await promise;
    const body = payload(result) as { testOrder: string[] };
    expect(body.testOrder).toEqual(['right', 'left']);
  });

  it('returns SLOT_NOT_BOUND when one slot is not connected', async () => {
    rightClient.isConnected = false;
    const result = await measureImbalanceCb({
      primarySlot: 'left',
      secondarySlot: 'right',
      durationMs: 3000,
      trials: 2,
      restMs: 30_000,
      betweenSidesRestMs: 60_000,
    });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'SLOT_NOT_BOUND' });
  });

  it('rejects primarySlot === secondarySlot with INVALID_INPUT', async () => {
    // Arrange: same device for both limbs — a bilateral test needs two.
    // Act
    const result = await measureImbalanceCb({
      primarySlot: 'left',
      secondarySlot: 'left',
      durationMs: 3000,
      trials: 2,
      restMs: 30_000,
      betweenSidesRestMs: 60_000,
    });
    // Assert: rejected at validation before any trial runs.
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(leftClient.subscribeCount).toBe(0);
  });

  // --- persistence (VMCP-04.11) ---------------------------------------
  //
  // The protocol computed a real asymmetry and dropped it before this landed.
  // These cases pin down WHAT is written: the per-trial observations, keyed on
  // the device id — not the verdict, and not the slot.

  /** Drive a full 2-trial-per-side run with left stronger than right. */
  async function runImbalance(): Promise<unknown> {
    const promise = measureImbalanceCb({
      primarySlot: 'left',
      secondarySlot: 'right',
      primarySide: 'left',
      durationMs: 3000,
      trials: 2,
      restMs: 30_000,
      betweenSidesRestMs: 60_000,
      testNonDominantFirst: false,
      dominantSide: 'unknown',
    });
    await pumpTrialFrames(leftClient, 3000, 200);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(leftClient, 3000, 195);
    await vi.advanceTimersByTimeAsync(60_000);
    await pumpTrialFrames(rightClient, 3000, 180);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(rightClient, 3000, 175);
    return payload(await promise);
  }

  it('persists both sides trials keyed on device_id, with a timestamp', async () => {
    const body = (await runImbalance()) as { measurementId: string | null };

    expect(store.putIsometricMeasurement).toHaveBeenCalledTimes(1);
    const written = store.written[0];
    expect(body.measurementId).toBe(written.id);
    expect(Date.parse(written.measuredAt)).not.toBeNaN();
    expect(written.analysisVersion).toBeGreaterThanOrEqual(1);
    // Protocol parameters ride along: the numbers are only interpretable
    // against the hold duration and trial count they were collected under.
    expect(written.durationMs).toBe(3000);
    expect(written.trialsRequested).toBe(2);
    expect(written.restMs).toBe(30_000);
    expect(written.betweenSidesRestMs).toBe(60_000);
    expect(written.firstSideTested).toBe('left');

    const left = written.sides.find((s) => s.side === 'left');
    const right = written.sides.find((s) => s.side === 'right');
    // Ground truth is the device id, and each limb carries its own.
    expect(left?.deviceId).toBe('AA:BB:CC:01');
    expect(right?.deviceId).toBe('AA:BB:CC:02');
    // Slot is recorded for diagnostics but is never the identity.
    expect(left?.slot).toBe('left');
    expect(right?.slot).toBe('right');
    // Both sides values, per trial.
    expect(left?.trials).toHaveLength(2);
    expect(right?.trials).toHaveLength(2);
    expect(left?.trials.map((t) => t.index)).toEqual([1, 2]);
    expect(left?.trials.every((t) => t.plateauForceLbs > 0)).toBe(true);
    // The stronger limb is stronger in the STORED numbers too, not just in the
    // response — the write must not scramble which side is which.
    const meanOf = (trials: { plateauForceLbs: number }[]) =>
      trials.reduce((sum, t) => sum + t.plateauForceLbs, 0) / trials.length;
    expect(meanOf(left?.trials ?? [])).toBeGreaterThan(meanOf(right?.trials ?? []));
  });

  it('stores observations only — no asymmetry verdict', async () => {
    // The asymmetry %, the direction and the real/not-real call are recomputed
    // from the stored trials on read. Persisting them would freeze a verdict
    // that the rules can move out from under — as VW-270 just moved them.
    //
    // `asymmetryEquation` (VW-295) is the one exception — it names which
    // equation the verdict was computed under, not the verdict itself, and is
    // excluded from this leak check for exactly that reason.
    const body = (await runImbalance()) as { imbalance: { direction: string } };
    expect(body.imbalance.direction).toBe('left');

    const { asymmetryEquation: _equation, ...rest } = store.written[0];
    const written = JSON.stringify(rest);
    for (const leaked of ['asymmetry', 'direction', 'real', 'noiseFloor', 'inferred']) {
      expect(written).not.toContain(leaked);
    }
  });

  it('records a device-less side as a gap, never a placeholder id', async () => {
    // Mock adapter / dropped unit: no connected device id to stamp.
    (rightClient as unknown as { connectedDeviceId: string | null }).connectedDeviceId = null;
    await runImbalance();

    const right = store.written[0].sides.find((s) => s.side === 'right');
    expect(right).not.toHaveProperty('deviceId');
    // The trials are still recorded — the measurement happened, only the
    // attribution is missing.
    expect(right?.trials).toHaveLength(2);
  });

  it('reports the measurement even when the store write fails', async () => {
    // A bilateral assessment costs the user ten-plus minutes of maximal
    // effort; a DB failure must not throw it away.
    store.failWith = new Error('database is locked');
    const body = (await runImbalance()) as {
      ok: boolean;
      measurementId: string | null;
      imbalance: { direction: string };
    };
    expect(body.ok).toBe(true);
    expect(body.imbalance.direction).toBe('left');
    // …and says so, rather than implying it was saved.
    expect(body.measurementId).toBeNull();
  });

  // VW-270: direction across sessions is the interpretable signal, so the run
  // reads its own history back and labels it.
  it('labels dominance consistent when past tests named the same limb', async () => {
    store.seeded = [
      seededMeasurement('2026-09-01T10:00:00.000Z', 200, 170),
      seededMeasurement('2026-09-05T10:00:00.000Z', 205, 172),
    ];
    const body = (await runImbalance()) as {
      directionHistory: { label: string; testsCompared: number; agreementPct: number | null };
    };
    // Two seeded left-dominant tests plus this run, which is also left-dominant.
    expect(body.directionHistory.testsCompared).toBe(3);
    expect(body.directionHistory.label).toBe('consistent-left');
    expect(body.directionHistory.agreementPct).toBe(100);
  });

  it('labels dominance fluctuating when the direction flips between tests', async () => {
    store.seeded = [
      seededMeasurement('2026-09-01T10:00:00.000Z', 170, 200),
      seededMeasurement('2026-09-05T10:00:00.000Z', 205, 172),
    ];
    const body = (await runImbalance()) as { directionHistory: { label: string } };
    expect(body.directionHistory.label).toBe('fluctuating');
  });

  it('withholds a dominance label until three tests have a direction', async () => {
    const body = (await runImbalance()) as {
      directionHistory: { label: string; testsCompared: number };
    };
    expect(body.directionHistory.testsCompared).toBe(1);
    expect(body.directionHistory.label).toBe('insufficient-history');
  });

  it('reports the measurement when the history read fails', async () => {
    // Rejects every call: `measureImbalance` reads the store twice now — the
    // peak-force baseline (before persisting) and the direction history
    // (after) — and both must degrade to null independently.
    store.listRecentIsometricMeasurements.mockRejectedValue(new Error('database is locked'));
    const body = (await runImbalance()) as {
      ok: boolean;
      directionHistory: unknown;
      peakForceBaseline: unknown;
      measurementId: string | null;
    };
    expect(body.ok).toBe(true);
    expect(body.measurementId).not.toBeNull();
    expect(body.peakForceBaseline).toBeNull();
    // `null` says the history is unknown — distinct from a short-but-read one.
    expect(body.directionHistory).toBeNull();
  });
});

// VW-284: an isometric hold has no reps of its own to cluster a setup from,
// so the gate reads each side's CONFIRMED `exercise_setups` signature for the
// exercise active on that slot's session — the same cable-geometry question
// VW-272 asks of `progression.get_for_exercise`'s `sideSplit`.
describe('isometric.measure_imbalance — setup geometry gate (VW-284)', () => {
  let leftClient: FakeClient;
  let rightClient: FakeClient;
  let store: FakeStore;
  let measureImbalanceCb: Callback;
  let published: PublishedEvent[];

  const EXERCISE_ID = 'cable-row';

  function build(exerciseIds: Record<string, string | undefined>): void {
    vi.useFakeTimers();
    leftClient = makeFakeClient();
    rightClient = makeFakeClient();
    store = makeFakeStore();
    published = [];
    const state = makeState(
      { left: leftClient, right: rightClient },
      { store, exerciseIds, channels: makeChannels(published) },
    );
    const { placeholders, slots } = buildPlaceholders(TOOL_NAMES);
    registerIsometricTools({} as McpServer, state, placeholders);
    measureImbalanceCb = slots.get('isometric.measure_imbalance')!.callback;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  interface Body {
    ok: boolean;
    setupComparability: string;
    setupSignatures: {
      left: { medianRomM?: number };
      right: { medianRomM?: number };
    };
    setupReason: string;
    imbalance: { real: boolean | null; direction: string | null; asymmetryPct: number | null };
    left: { meanPeakForceLbs: number | null };
    right: { meanPeakForceLbs: number | null };
  }

  /** Drive a full 2-trial-per-side run with left pulling harder than right. */
  async function runImbalance(): Promise<Body> {
    const promise = measureImbalanceCb({
      primarySlot: 'left',
      secondarySlot: 'right',
      primarySide: 'left',
      durationMs: 3000,
      trials: 2,
      restMs: 30_000,
      betweenSidesRestMs: 60_000,
      testNonDominantFirst: false,
      dominantSide: 'unknown',
    });
    await pumpTrialFrames(leftClient, 3000, 200);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(leftClient, 3000, 195);
    await vi.advanceTimersByTimeAsync(60_000);
    await pumpTrialFrames(rightClient, 3000, 180);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(rightClient, 3000, 175);
    return payload(await promise) as unknown as Body;
  }

  it('matching confirmed setups: comparable, verdict unchanged', async () => {
    build({ left: EXERCISE_ID, right: EXERCISE_ID });
    store.exerciseSetups = [
      makeExerciseSetup('setup-left', EXERCISE_ID),
      makeExerciseSetup('setup-right', EXERCISE_ID),
    ];
    store.sets = [
      makeExerciseSet('set-l1', EXERCISE_ID, 'left', 'setup-left', 0.5),
      makeExerciseSet('set-r1', EXERCISE_ID, 'right', 'setup-right', 0.52),
    ];

    const body = await runImbalance();

    expect(body.setupComparability).toBe('comparable');
    expect(body.imbalance.real).not.toBeNull();
    expect(body.imbalance.direction).toBe('left');
    expect(body.left.meanPeakForceLbs).toBeGreaterThan(170);
    expect(body.right.meanPeakForceLbs).toBeGreaterThan(150);
  });

  it('mismatched confirmed setups: confounded, verdict withheld, per-side peaks still reported', async () => {
    build({ left: EXERCISE_ID, right: EXERCISE_ID });
    store.exerciseSetups = [
      makeExerciseSetup('setup-left', EXERCISE_ID),
      makeExerciseSetup('setup-right', EXERCISE_ID),
    ];
    // 0.9 / 0.5 = 1.8x apart — past the 1.15x geometry-split ratio.
    store.sets = [
      makeExerciseSet('set-l1', EXERCISE_ID, 'left', 'setup-left', 0.5),
      makeExerciseSet('set-r1', EXERCISE_ID, 'right', 'setup-right', 0.9),
    ];

    const body = await runImbalance();

    expect(body.setupComparability).toBe('setup_confounded');
    expect(body.setupReason).toContain('joint torque');
    expect(body.imbalance.real).toBeNull();
    expect(body.imbalance.direction).toBeNull();
    // Facts about what was measured survive the withholding.
    expect(body.imbalance.asymmetryPct).not.toBeNull();
    expect(body.left.meanPeakForceLbs).toBeGreaterThan(170);
    expect(body.right.meanPeakForceLbs).toBeGreaterThan(150);

    // VW-264: the wall is told the same thing the tool result says. The gate's BARE
    // wording rides as `setupReason` so the card can prefix it without doubling up.
    const pushed = (
      JSON.parse(published.filter((e) => e.meta.event_type === 'isometric_result')[0].content) as {
        isometric_result: IsometricResultBody;
      }
    ).isometric_result;
    expect(pushed.verdict).toBeNull();
    expect(pushed.comparability).toBe('setup_confounded');
    expect(pushed.setupReason).toBe(body.setupReason);
    expect(pushed.asymmetryPct).not.toBeNull();
  });

  it('one side has no confirmed setup: setup_unverified, verdict still reported', async () => {
    build({ left: EXERCISE_ID, right: EXERCISE_ID });
    store.exerciseSetups = [
      makeExerciseSetup('setup-left', EXERCISE_ID),
      // Right's setup was inferred but never confirmed.
      makeExerciseSetup('setup-right', EXERCISE_ID, { confirmed: false }),
    ];
    store.sets = [
      makeExerciseSet('set-l1', EXERCISE_ID, 'left', 'setup-left', 0.5),
      makeExerciseSet('set-r1', EXERCISE_ID, 'right', 'setup-right', 0.9),
    ];

    const body = await runImbalance();

    expect(body.setupComparability).toBe('setup_unverified');
    expect(body.setupSignatures.right.medianRomM).toBeUndefined();
    // A check that never ran is not evidence of a mismatch: the verdict is
    // reported exactly as `computeImbalance` produced it.
    expect(body.imbalance.real).not.toBeNull();
    expect(body.imbalance.direction).toBe('left');
  });

  it('no active exercise on either slot: setup_unverified, never comparable by default', async () => {
    build({});

    const body = await runImbalance();

    expect(body.setupComparability).toBe('setup_unverified');
    expect(body.imbalance.real).not.toBeNull();
  });
});

// VW-274: each side of measure_imbalance runs the same single-unit isometric
// hold measure_max does, so it carries the same per-unit mount-load risk —
// the gate cannot depend on which tool triggered the hold.
describe('isometric mount-load gate — measure_imbalance', () => {
  let leftClient: FakeClient;
  let rightClient: FakeClient;

  function build(
    mountRatingLbs: number | undefined,
    store?: FakeStore,
  ): { measureImbalanceCb: Callback } {
    vi.useFakeTimers();
    leftClient = makeFakeClient();
    rightClient = makeFakeClient();
    const state = makeState(
      { left: leftClient, right: rightClient },
      { mountRatingLbs, store, exerciseIds: { left: 'cable-row', right: 'cable-row' } },
    );
    const { placeholders, slots } = buildPlaceholders(TOOL_NAMES);
    registerIsometricTools({} as McpServer, state, placeholders);
    return { measureImbalanceCb: slots.get('isometric.measure_imbalance')!.callback };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  const baseInput = {
    primarySlot: 'left',
    secondarySlot: 'right',
    primarySide: 'left' as const,
    durationMs: 3000,
    trials: 2,
    restMs: 30_000,
    betweenSidesRestMs: 60_000,
    testNonDominantFirst: false,
    dominantSide: 'unknown' as const,
  };

  it('proceeds and reports null warning when the rating covers it', async () => {
    const { measureImbalanceCb } = build(500);
    const promise = measureImbalanceCb(baseInput);
    await pumpTrialFrames(leftClient, 3000, 200);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(leftClient, 3000, 195);
    await vi.advanceTimersByTimeAsync(60_000);
    await pumpTrialFrames(rightClient, 3000, 180);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(rightClient, 3000, 175);
    const body = payload(await promise) as { ok: boolean; mountLoadWarning: string | null };
    expect(body.ok).toBe(true);
    expect(body.mountLoadWarning).toBeNull();
  });

  it('refuses INVALID_INPUT before either side runs when the rating is exceeded', async () => {
    const { measureImbalanceCb } = build(350);
    const result = await measureImbalanceCb(baseInput);
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(leftClient.subscribeCount).toBe(0);
    expect(rightClient.subscribeCount).toBe(0);
  });

  // VW-284: the setup gate reads `exercise_setups`/sets AFTER the protocol has
  // run, so a mount-load refusal — which happens before any trial — must never
  // reach that read either.
  it('refuses before the VW-284 setup gate reads exercise_setups', async () => {
    const store = makeFakeStore();
    const { measureImbalanceCb } = build(350, store);
    const result = await measureImbalanceCb(baseInput);
    expect(result.isError).toBe(true);
    expect(store.listExerciseSetups).not.toHaveBeenCalled();
    expect(store.getSetsForExercise).not.toHaveBeenCalled();
  });

  it('warns, and still proceeds, when no rating is configured', async () => {
    const { measureImbalanceCb } = build(undefined);
    const promise = measureImbalanceCb(baseInput);
    await pumpTrialFrames(leftClient, 3000, 200);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(leftClient, 3000, 195);
    await vi.advanceTimersByTimeAsync(60_000);
    await pumpTrialFrames(rightClient, 3000, 180);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(rightClient, 3000, 175);
    const body = payload(await promise) as { ok: boolean; mountLoadWarning: string | null };
    expect(body.ok).toBe(true);
    expect(body.mountLoadWarning).toContain('UNKNOWN');
  });
});

// VW-200: these tools issue no BLE command of their own, but they BLOCK — a
// hold for seconds, the full protocol for minutes. Until the fence they kept
// measuring, and kept cueing the athlete, on a device another session owned.
describe('the lease fence over an isometric assessment', () => {
  let measureHoldCb: Callback;
  let measureMaxCb: Callback;
  let client: FakeClient;
  let lease: FakeLease;
  let published: PublishedEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    client = makeFakeClient();
    published = [];
    lease = makeFakeLease();
    const state = makeState({ primary: client }, { channels: makeChannels(published), lease });
    const { placeholders, slots } = buildPlaceholders(TOOL_NAMES);
    registerIsometricTools({} as McpServer, state, placeholders);
    measureHoldCb = slots.get('isometric.measure_hold')!.callback;
    measureMaxCb = slots.get('isometric.measure_max')!.callback;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function leaseLostEvents(): PublishedEvent[] {
    return published.filter((e) => e.meta.event_type === 'lease_lost');
  }

  it('measure_hold: a steal mid-hold fails the call with LEASE_LOST', async () => {
    const promise = measureHoldCb({ holdMs: 5000 });
    await vi.advanceTimersByTimeAsync(2000);

    lease.steal();
    const result = await promise;

    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'LEASE_LOST' });
  });

  it('measure_hold: publishes one lease_lost naming the tool and the slot', async () => {
    const promise = measureHoldCb({ holdMs: 5000 });
    lease.steal();
    await promise;

    const events = leaseLostEvents();
    expect(events).toHaveLength(1);
    expect(events[0].meta.tool).toBe('isometric.measure_hold');
    expect(events[0].meta.slot).toBe('primary');
  });

  it('measure_hold: detaches the frame listener and still cues stop', async () => {
    const promise = measureHoldCb({ holdMs: 5000 });
    await vi.advanceTimersByTimeAsync(2000);
    lease.steal();
    await promise;

    expect(client.unsubscribeCount).toBe(1);
    // The athlete is mid-pull against a cable that is about to be unloaded —
    // the stop cue matters more here than on the happy path, not less.
    expect(phasesOf(published)).toEqual(['ready', 'go', 'hold', 'stop']);
  });

  it('measure_hold: leaves the device unloaded, and writes nothing else', async () => {
    const promise = measureHoldCb({ holdMs: 5000 });
    lease.steal();
    await promise;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(client.writes).toEqual(['unloadDevice']);
  });

  it('measure_max: a steal during the rest stops the remaining trials', async () => {
    const promise = measureMaxCb({ durationMs: 3000, trials: 3, restMs: 30_000, warmup: false });
    await pumpTrialFrames(client, 3000, 200);
    await vi.advanceTimersByTimeAsync(5000);

    lease.steal();
    const result = await promise;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(payload(result)).toMatchObject({ code: 'LEASE_LOST' });
    // One trial ran, and no fourth hold subscribed after the steal.
    expect(client.subscribeCount).toBe(1);
    expect(client.unsubscribeCount).toBe(1);
    expect(leaseLostEvents()).toHaveLength(1);
  });

  it('measure_max: runs to completion when the holder keeps the lease', async () => {
    // The sanity case: a notification that leaves the generation where it was
    // — the holder refreshing its own claim — aborts nothing.
    const promise = measureMaxCb({ durationMs: 3000, trials: 2, restMs: 30_000, warmup: false });
    await pumpTrialFrames(client, 3000, 200);
    lease.touch();
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(client, 3000, 195);

    const body = payload(await promise) as { ok: boolean; validTrialCount: number };
    expect(body.ok).toBe(true);
    expect(body.validTrialCount).toBe(2);
    expect(leaseLostEvents()).toHaveLength(0);
    expect(client.writes).toEqual([]);
  });
});

// VW-280: `isometric_measurements` now records who was tested, on what, and
// during which session. Before that, every test on the rig fell into one
// series — a guest's pull and the owner's pull at a different joint decided
// each other's dominance label and each other's SEM.
describe('isometric — the lifter / exercise / session key (VW-280)', () => {
  let measureMaxCb: Callback;
  let measureImbalanceCb: Callback;
  let leftClient: FakeClient;
  let rightClient: FakeClient;
  let store: FakeStore;

  /** Register the tools with the given per-slot live sessions. */
  function register(sessions: Record<string, FakeSession | undefined>): void {
    const state = makeState(
      { primary: leftClient, left: leftClient, right: rightClient },
      { store, deviceIds: { left: 'AA:BB:CC:01', right: 'AA:BB:CC:02' }, sessions },
    );
    const { placeholders, slots } = buildPlaceholders(TOOL_NAMES);
    registerIsometricTools({} as McpServer, state, placeholders);
    measureMaxCb = slots.get('isometric.measure_max')!.callback;
    measureImbalanceCb = slots.get('isometric.measure_imbalance')!.callback;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    leftClient = makeFakeClient();
    rightClient = makeFakeClient();
    store = makeFakeStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drive a full 2-trial-per-side imbalance run with left stronger than right. */
  async function runImbalance(): Promise<Record<string, unknown>> {
    const promise = measureImbalanceCb({
      primarySlot: 'left',
      secondarySlot: 'right',
      primarySide: 'left',
      durationMs: 3000,
      trials: 2,
      restMs: 30_000,
      betweenSidesRestMs: 60_000,
      testNonDominantFirst: false,
      dominantSide: 'unknown',
    });
    await pumpTrialFrames(leftClient, 3000, 200);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(leftClient, 3000, 195);
    await vi.advanceTimersByTimeAsync(60_000);
    await pumpTrialFrames(rightClient, 3000, 180);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(rightClient, 3000, 175);
    return payload(await promise) as Record<string, unknown>;
  }

  /** Drive a 2-trial `measure_max` run on the primary slot at ~200 lb. */
  async function runMax(): Promise<MeasureMaxBody & { legacyUnkeyed: number }> {
    const promise = measureMaxCb({ durationMs: 3000, trials: 2, restMs: 30_000, warmup: false });
    await pumpTrialFrames(leftClient, 3000, 200);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(leftClient, 3000, 200);
    return payload(await promise) as MeasureMaxBody & { legacyUnkeyed: number };
  }

  it('stamps the active lifter, exercise and session at capture', async () => {
    register({
      left: { sessionId: 'sess-1', exerciseId: 'seated-row', lifter: 'Jordan' },
      right: { sessionId: 'sess-1', exerciseId: 'seated-row', lifter: 'Jordan' },
    });
    await runImbalance();

    expect(store.written[0]).toMatchObject({
      userId: 'Jordan',
      exerciseId: 'seated-row',
      sessionId: 'sess-1',
    });
  });

  it('keys an off-the-books test to the owner, with no exercise or session', async () => {
    // No open session: the owner tested themselves between programs. The
    // exercise and the session stay absent rather than being invented, but the
    // run is still keyed, so it does not land as another unreadable row.
    register({});
    await runMax();

    expect(store.written[0]!.userId).toBe(LOCAL_USER_ID);
    expect(store.written[0]).not.toHaveProperty('exerciseId');
    expect(store.written[0]).not.toHaveProperty('sessionId');
  });

  it('never mixes two lifters into one direction history or baseline', async () => {
    // The guest's three past tests are all RIGHT-dominant and pull ~100 lb.
    // Unkeyed, they would have decided the owner's label and the owner's SEM.
    store.seeded = [
      seededMeasurement('2026-09-01T00:00:00.000Z', 100, 130, { userId: 'Jordan' }),
      seededMeasurement('2026-09-03T00:00:00.000Z', 101, 131, { userId: 'Jordan' }),
      seededMeasurement('2026-09-05T00:00:00.000Z', 99, 129, { userId: 'Jordan' }),
    ];
    register({});
    const body = (await runImbalance()) as unknown as {
      directionHistory: { label: string; testsCompared: number };
      peakForceBaseline: unknown;
      legacyUnkeyed: number;
    };

    // Only this run, which is left-dominant: the guest's right-dominant series
    // is out of scope entirely.
    expect(body.directionHistory.testsCompared).toBe(1);
    expect(body.directionHistory.label).toBe('insufficient-history');
    expect(body.peakForceBaseline).toBeNull();
    // Excluded by the key, not by the legacy gap — they carry a lifter.
    expect(body.legacyUnkeyed).toBe(0);
  });

  it('never mixes two exercises into one direction history or baseline', async () => {
    // Same lifter, a different joint. Joint angle dominates what an isometric
    // maximum means, so pooling the two makes both numbers meaningless.
    store.seeded = [
      seededMeasurement('2026-09-01T00:00:00.000Z', 100, 130, {
        userId: LOCAL_USER_ID,
        exerciseId: 'overhead-press',
      }),
      seededMeasurement('2026-09-03T00:00:00.000Z', 101, 131, {
        userId: LOCAL_USER_ID,
        exerciseId: 'overhead-press',
      }),
      seededMeasurement('2026-09-05T00:00:00.000Z', 99, 129, {
        userId: LOCAL_USER_ID,
        exerciseId: 'overhead-press',
      }),
    ];
    register({
      left: { sessionId: 'sess-2', exerciseId: 'seated-row' },
      right: { sessionId: 'sess-2', exerciseId: 'seated-row' },
    });
    const body = (await runImbalance()) as unknown as {
      directionHistory: { testsCompared: number };
      peakForceBaseline: unknown;
    };

    expect(body.directionHistory.testsCompared).toBe(1);
    expect(body.peakForceBaseline).toBeNull();
  });

  it('reads the series for the lifter and exercise that are actually active', async () => {
    // The same seeds as the two cases above, now keyed to THIS run's lifter
    // and exercise: the filter includes as well as it excludes.
    store.seeded = [
      seededMeasurement('2026-09-01T00:00:00.000Z', 130, 100, {
        userId: 'Jordan',
        exerciseId: 'seated-row',
      }),
      seededMeasurement('2026-09-03T00:00:00.000Z', 131, 101, {
        userId: 'Jordan',
        exerciseId: 'seated-row',
      }),
      seededMeasurement('2026-09-05T00:00:00.000Z', 129, 99, {
        userId: 'Jordan',
        exerciseId: 'seated-row',
      }),
    ];
    register({
      left: { sessionId: 'sess-3', exerciseId: 'seated-row', lifter: 'Jordan' },
      right: { sessionId: 'sess-3', exerciseId: 'seated-row', lifter: 'Jordan' },
    });
    const body = (await runImbalance()) as unknown as {
      directionHistory: { label: string; testsCompared: number };
      peakForceBaseline: { sampleSize: number } | null;
    };

    // Three seeded left-dominant tests plus this run, also left-dominant.
    expect(body.directionHistory.testsCompared).toBe(4);
    expect(body.directionHistory.label).toBe('consistent-left');
    expect(body.peakForceBaseline!.sampleSize).toBe(6); // 3 occasions × 2 sides
  });

  it('excludes pre-keying assessments from both series and counts them', async () => {
    // No userId at all: rows written before the keying landed. Nothing says
    // whose tests they were, so no filter can place them in anyone's series.
    store.seeded = [
      seededMeasurement('2026-09-01T00:00:00.000Z', 100, 130, {}),
      seededMeasurement('2026-09-03T00:00:00.000Z', 101, 131, {}),
      seededMeasurement('2026-09-05T00:00:00.000Z', 99, 129, {}),
    ];
    register({});
    const body = (await runImbalance()) as unknown as {
      directionHistory: { testsCompared: number };
      peakForceBaseline: unknown;
      legacyUnkeyed: number;
    };

    expect(body.directionHistory.testsCompared).toBe(1);
    expect(body.peakForceBaseline).toBeNull();
    // Counted rather than dropped silently: a one-test series reads
    // differently once you know three older tests could not join it.
    expect(body.legacyUnkeyed).toBe(3);
  });

  it('measure_max reports the legacy count alongside its own baseline', async () => {
    store.seeded = [
      seededMeasurement('2026-09-01T00:00:00.000Z', 100, 100, {}),
      seededMeasurement('2026-09-03T00:00:00.000Z', 101, 101, {}),
    ];
    register({});
    const body = await runMax();

    expect(body.peakForceBaseline).toBeNull();
    expect(body.legacyUnkeyed).toBe(2);
  });
});

describe('isometric — the persisted asymmetry equation (VW-295)', () => {
  let measureMaxCb: Callback;
  let measureImbalanceCb: Callback;
  let leftClient: FakeClient;
  let rightClient: FakeClient;
  let store: FakeStore;

  function register(sessions: Record<string, FakeSession | undefined>): void {
    const state = makeState(
      { primary: leftClient, left: leftClient, right: rightClient },
      { store, deviceIds: { left: 'AA:BB:CC:01', right: 'AA:BB:CC:02' }, sessions },
    );
    const { placeholders, slots } = buildPlaceholders(TOOL_NAMES);
    registerIsometricTools({} as McpServer, state, placeholders);
    measureMaxCb = slots.get('isometric.measure_max')!.callback;
    measureImbalanceCb = slots.get('isometric.measure_imbalance')!.callback;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    leftClient = makeFakeClient();
    rightClient = makeFakeClient();
    store = makeFakeStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runImbalance(): Promise<Record<string, unknown>> {
    const promise = measureImbalanceCb({
      primarySlot: 'left',
      secondarySlot: 'right',
      primarySide: 'left',
      durationMs: 3000,
      trials: 2,
      restMs: 30_000,
      betweenSidesRestMs: 60_000,
      testNonDominantFirst: false,
      dominantSide: 'unknown',
    });
    await pumpTrialFrames(leftClient, 3000, 200);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(leftClient, 3000, 195);
    await vi.advanceTimersByTimeAsync(60_000);
    await pumpTrialFrames(rightClient, 3000, 180);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(rightClient, 3000, 175);
    return payload(await promise) as Record<string, unknown>;
  }

  async function runMax(): Promise<Record<string, unknown>> {
    const promise = measureMaxCb({ durationMs: 3000, trials: 2, restMs: 30_000, warmup: false });
    await pumpTrialFrames(leftClient, 3000, 200);
    await vi.advanceTimersByTimeAsync(30_000);
    await pumpTrialFrames(leftClient, 3000, 200);
    return payload(await promise) as Record<string, unknown>;
  }

  it('measure_imbalance always persists the same fixed equation label', async () => {
    register({});
    await runImbalance();
    await runImbalance();

    expect(store.written).toHaveLength(2);
    expect(store.written[0].asymmetryEquation).toBe('standard-percentage-difference');
    expect(store.written[1].asymmetryEquation).toBe('standard-percentage-difference');
  });

  it('measure_max persists no equation — it computes no comparison to name one for', async () => {
    register({});
    await runMax();

    expect(store.written).toHaveLength(1);
    expect(store.written[0]).not.toHaveProperty('asymmetryEquation');
  });

  it('excludes a stored occasion computed under a different equation from directionHistory', async () => {
    store.seeded = [
      seededMeasurement('2026-09-01T00:00:00.000Z', 100, 130, {
        userId: LOCAL_USER_ID,
        asymmetryEquation: 'standard-percentage-difference',
      }),
      seededMeasurement('2026-09-03T00:00:00.000Z', 101, 131, {
        userId: LOCAL_USER_ID,
        asymmetryEquation: 'some-other-equation',
      }),
      seededMeasurement('2026-09-05T00:00:00.000Z', 99, 129, {
        userId: LOCAL_USER_ID,
        asymmetryEquation: 'standard-percentage-difference',
      }),
    ];
    register({});
    const body = (await runImbalance()) as unknown as {
      directionHistory: { testsCompared: number };
      otherEquation: number;
    };

    // 2 matching-equation seeds + this run = 3; the mismatched seed is out.
    expect(body.directionHistory.testsCompared).toBe(3);
    expect(body.otherEquation).toBe(1);
  });

  it('does not treat an unkeyed-equation row (measure_max) as an equation mismatch', async () => {
    store.seeded = [
      // No asymmetryEquation at all — a measure_max row, or a pre-VW-295 row.
      // Its peak forces still belong in the pooled baseline.
      seededMeasurement('2026-09-01T00:00:00.000Z', 100, 100, { userId: LOCAL_USER_ID }),
      seededMeasurement('2026-09-03T00:00:00.000Z', 101, 101, { userId: LOCAL_USER_ID }),
    ];
    register({});
    const body = (await runMax()) as unknown as {
      peakForceBaseline: { sampleSize: number } | null;
      otherEquation: number;
    };

    expect(body.otherEquation).toBe(0);
    // 2 seeded occasions × 2 sides each.
    expect(body.peakForceBaseline?.sampleSize).toBe(4);
  });
});
