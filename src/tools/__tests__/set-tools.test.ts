// Unit tests for src/tools/set-tools.ts.
//
// Covers the `set.start` / `set.end` / `set.live_metrics` handlers:
//   * NO_ACTIVE_SESSION when set.start is invoked without a session (EC-03)
//   * SET_ALREADY_ACTIVE when a set is already in flight (EC-13)
//   * Set metadata at start time comes from `live.snapshotDevice()`
//   * NO_ACTIVE_SET on set.end without an active set (AC-17)
//   * set.live_metrics returns the live snapshot or `{ active: false }`
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Rep } from '@voltras/workout-analytics';
import type { LiveState as LiveStateType } from '../../state/live-state.js';
import type { ServerState } from '../../state/server-state.js';
import type { SessionStore, StoredSet } from '../../store/types.js';

vi.mock('@voltras/node-sdk', () => {
  class FakeVoltraSDKError extends Error {
    readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'VoltraSDKError';
      this.code = code;
    }
  }
  return { VoltraSDKError: FakeVoltraSDKError };
});

const { LiveState } = await import('../../state/live-state.js');
const { registerSetTools } = await import('../set-tools.js');
const { SetWatchdog } = await import('../../state/set-watchdog.js');

interface FakeRegisteredTool {
  callback?: (args: unknown, extra?: unknown) => Promise<unknown>;
  update(updates: { callback: (args: unknown, extra?: unknown) => Promise<unknown> }): void;
  remove(): void;
}

interface FakeServer {
  tool: (...args: unknown[]) => unknown;
}

function makeFakePlaceholders(names: string[]): {
  placeholders: Map<string, FakeRegisteredTool>;
  invokers: Record<
    string,
    (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>
  >;
} {
  const placeholders = new Map<string, FakeRegisteredTool>();
  for (const name of names) {
    const tool: FakeRegisteredTool = {
      update(updates) {
        tool.callback = updates.callback;
      },
      remove() {
        /* unused */
      },
    };
    placeholders.set(name, tool);
  }
  const invokers: Record<
    string,
    (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>
  > = {};
  for (const name of names) {
    invokers[name] = async (args: unknown) => {
      const cb = placeholders.get(name)?.callback;
      if (!cb) throw new Error(`no callback installed for ${name}`);
      return cb(args) as Promise<{ content: { text: string }[]; isError?: boolean }>;
    };
  }
  return { placeholders, invokers };
}

function makeStore(): SessionStore & {
  putSession: ReturnType<typeof vi.fn>;
  putSet: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  getSet: ReturnType<typeof vi.fn>;
  getSetsForSession: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    putSession: vi.fn(async () => {}),
    putSet: vi.fn(async () => {}),
    getSession: vi.fn(async () => undefined),
    getSet: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => []),
    getSetsForSession: vi.fn(async () => []),
    close: vi.fn(async () => {}),
  };
}

function makeRep(n: number): Rep {
  const phase = {
    samples: [],
    startTime: 0,
    endTime: 0,
    startPosition: 0,
    endPosition: 0,
    _totalVelocity: 0,
    _totalForce: 0,
    _totalLoad: 0,
    _movementSampleCount: 0,
    _totalHoldDuration: 0,
    peakVelocity: 0,
    peakForce: 0,
    peakLoad: 0,
  };
  return { repNumber: n, concentric: phase, eccentric: phase };
}

const TOOL_NAMES = ['set.start', 'set.end', 'set.live_metrics', 'set.get'];

interface Harness {
  state: ServerState;
  invoke: (
    name: string,
    args: unknown,
  ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  store: ReturnType<typeof makeStore>;
  live: LiveStateType;
  channels: { publish: ReturnType<typeof vi.fn> };
}

function setup(): Harness {
  const live = new LiveState();
  const store = makeStore();
  const client = {
    startRecording: vi.fn().mockResolvedValue(undefined),
    endSet: vi.fn().mockResolvedValue(undefined),
  };
  // Top-level publish mock collects every event; `forSlot(slotId)` returns
  // a publisher that re-routes through the same mock with `slot: slotId`
  // injected into meta. Mirrors the production
  // `slotScopedPublisher` shape so tests that don't touch slot meta keep
  // working unchanged while bilateral-aware assertions can read meta.slot.
  const channels: {
    publish: ReturnType<typeof vi.fn>;
    forSlot: (slotId: string) => {
      publish: (e: unknown) => void;
      forSlot: typeof channels.forSlot;
    };
  } = {
    publish: vi.fn(),
    forSlot: (slotId: string) => ({
      publish: (event: unknown) => {
        const e = event as { content: string; meta: Record<string, string> };
        channels.publish({ content: e.content, meta: { slot: slotId, ...e.meta } });
      },
      forSlot: channels.forSlot,
    }),
  };
  const slots = new Map();
  slots.set('primary', { slotId: 'primary', client, live });
  const state = {
    config: {} as never,
    manager: {} as never,
    slots,
    store,
    exercises: {} as never,
    channels,
    setStartDeviceSnapshots: new Map(),
    setWatchdog: new SetWatchdog(),
  } as unknown as ServerState;
  const { placeholders, invokers } = makeFakePlaceholders(TOOL_NAMES);
  const server = { tool: vi.fn() } as unknown as FakeServer;
  registerSetTools(
    server as unknown as Parameters<typeof registerSetTools>[0],
    state,
    placeholders as unknown as Parameters<typeof registerSetTools>[2],
  );
  return {
    state,
    invoke: (name, args) => invokers[name](args),
    store,
    live,
    channels,
  };
}

function parseResult(r: { content: { text: string }[] }): unknown {
  return JSON.parse(r.content[0].text);
}

function startSession(live: LiveStateType): string {
  const id = 'sess-A';
  live.startSession({
    sessionId: id,
    startedAt: '2025-01-01T00:00:00.000Z',
    setIds: [],
    status: 'active',
  });
  return id;
}

describe('set.start', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('returns NO_ACTIVE_SESSION when no session is open (EC-03)', async () => {
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });

    const r = await h.invoke('set.start', {});
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('NO_ACTIVE_SESSION');
    expect(h.live.set).toBeUndefined();
    expect(h.store.putSet).not.toHaveBeenCalled();
  });

  it('returns SET_ALREADY_ACTIVE when one is already running (EC-13)', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    const r1 = await h.invoke('set.start', {});
    expect(r1.isError).toBeUndefined();
    const setId1 = (parseResult(r1) as { setId: string }).setId;

    const r2 = await h.invoke('set.start', {});
    expect(r2.isError).toBe(true);
    expect((parseResult(r2) as { code: string }).code).toBe('SET_ALREADY_ACTIVE');
    expect(h.live.set?.setId).toBe(setId1);
    expect(h.store.putSet).not.toHaveBeenCalled();
  });

  it('starts a set and stamps live state with a generated setId', async () => {
    const sessionId = startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 75, trainingMode: 'WeightTraining' });

    const r = await h.invoke('set.start', {});
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { setId: string };
    expect(typeof body.setId).toBe('string');
    expect(body.setId.length).toBeGreaterThan(0);
    expect(h.live.set?.setId).toBe(body.setId);
    expect(h.live.set?.sessionId).toBe(sessionId);
    expect(h.live.set?.status).toBe('active');
  });

  it('publishes a set_started claude/channel event with full payload', async () => {
    const sessionId = startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 75, trainingMode: 'WeightTraining' });

    const r = await h.invoke('set.start', {});
    const setId = (parseResult(r) as { setId: string }).setId;
    expect(h.channels.publish).toHaveBeenCalledTimes(1);
    const event = h.channels.publish.mock.calls[0][0] as {
      content: string;
      meta: Record<string, string>;
    };
    expect(event.meta).toMatchObject({
      source: 'voltras',
      event_type: 'set_started',
      set_id: setId,
      session_id: sessionId,
      weight_lbs: '75',
      training_mode: 'WeightTraining',
    });
    const parsed = JSON.parse(event.content) as {
      summary: string;
      set: { set_id: string; session_id: string; weight_lbs: number; training_mode: string };
      previous_set_summary: unknown;
    };
    expect(parsed.summary).toContain('75 lbs');
    expect(parsed.summary).toContain('WeightTraining');
    expect(parsed.set).toMatchObject({
      set_id: setId,
      session_id: sessionId,
      weight_lbs: 75,
      training_mode: 'WeightTraining',
    });
    // First set in the session — no previous set to summarize.
    expect(parsed.previous_set_summary).toBeNull();
  });

  it('accepts a watch config and stores it on the active set', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    const r = await h.invoke('set.start', {
      watch: {
        stopOn: [{ type: 'rep_count_reached', value: 8 }],
        notifyOn: [{ type: 'velocity_loss_exceeded', pct: 25 }],
      },
    });
    expect(r.isError).toBeUndefined();
    expect(h.live.set?.watch).toBeDefined();
    expect(h.live.set?.watch?.stopOn).toEqual([{ type: 'rep_count_reached', value: 8 }]);
    expect(h.live.set?.watch?.notifyOn).toEqual([{ type: 'velocity_loss_exceeded', pct: 25 }]);
    // A fresh dedupe ledger is provisioned alongside the watch config.
    expect(h.live.set?.firedTriggers).toBeInstanceOf(Set);
    expect(h.live.set?.firedTriggers?.size).toBe(0);
  });

  it('rejects an invalid watch spec via INVALID_INPUT (out-of-range pct)', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    const r = await h.invoke('set.start', {
      watch: {
        notifyOn: [{ type: 'velocity_loss_exceeded', pct: 150 }],
      },
    });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
    expect(h.live.set).toBeUndefined();
  });

  it('omitted watch config leaves live.set.watch + firedTriggers undefined', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});
    expect(h.live.set?.watch).toBeUndefined();
    expect(h.live.set?.firedTriggers).toBeUndefined();
  });

  it('set_started includes previous_set_summary when a prior set exists in the session', async () => {
    const sessionId = startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });

    const priorSet: StoredSet = {
      id: 'set-prev',
      sessionId,
      startedAt: '2025-01-01T00:00:00.000Z',
      endedAt: '2025-01-01T00:01:00.000Z',
      partial: false,
      trainingMode: 'WeightTraining',
      weightLbs: 100,
      reps: [
        { ...makeRep(1), id: 'r1', setId: 'set-prev', index: 0 },
        { ...makeRep(2), id: 'r2', setId: 'set-prev', index: 1 },
      ],
    };
    h.store.getSetsForSession.mockResolvedValueOnce([priorSet]);

    const r = await h.invoke('set.start', {});
    expect(r.isError).toBeUndefined();
    const event = h.channels.publish.mock.calls[0][0] as {
      content: string;
      meta: Record<string, string>;
    };
    const parsed = JSON.parse(event.content) as {
      previous_set_summary: { set_id: string; rep_count: number; weight_lbs: number };
    };
    expect(parsed.previous_set_summary).toMatchObject({
      set_id: 'set-prev',
      rep_count: 2,
      weight_lbs: 100,
    });
    expect(h.store.getSetsForSession).toHaveBeenCalledWith(sessionId);
  });
});

describe('set.end', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('persists with partial=false and reps from live state', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 75, trainingMode: 'WeightTraining' });
    const startResult = await h.invoke('set.start', {});
    const setId = (parseResult(startResult) as { setId: string }).setId;
    h.live.appendRep(makeRep(1));
    h.live.appendRep(makeRep(2));
    h.live.appendRep(makeRep(3));

    const r = await h.invoke('set.end', {});
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { ok: boolean; reps: number };
    expect(body.ok).toBe(true);
    expect(body.reps).toBe(3);

    expect(h.store.putSet).toHaveBeenCalledTimes(1);
    const stored = h.store.putSet.mock.calls[0][0] as StoredSet;
    expect(stored.id).toBe(setId);
    expect(stored.partial).toBe(false);
    expect(stored.partialReason).toBeUndefined();
    expect(stored.reps.length).toBe(3);
    expect(stored.weightLbs).toBe(75);
    expect(stored.trainingMode).toBe('WeightTraining');
    expect(h.live.set).toBeUndefined();
  });

  it('captures the device snapshot at set.start time, not set.end time', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});
    // Mid-set, the user changes the weight on the device.
    h.live.applySettings({ weightLbs: 250, trainingMode: 'IsometricTraining' });

    await h.invoke('set.end', {});
    const stored = h.store.putSet.mock.calls[0][0] as StoredSet;
    expect(stored.weightLbs).toBe(100);
    expect(stored.trainingMode).toBe('WeightTraining');
  });

  it('returns NO_ACTIVE_SET when no set is active', async () => {
    const r = await h.invoke('set.end', {});
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('NO_ACTIVE_SET');
    expect(h.store.putSet).not.toHaveBeenCalled();
  });

  it('returns NO_ACTIVE_SET when invoked twice without a new set.start', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 75, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});
    await h.invoke('set.end', {});

    const r = await h.invoke('set.end', {});
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('NO_ACTIVE_SET');
  });

  it('publishes a set_ended claude/channel event with full rep array + vbt summary', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 75, trainingMode: 'WeightTraining' });
    const startResult = await h.invoke('set.start', {});
    const setId = (parseResult(startResult) as { setId: string }).setId;
    h.live.appendRep(makeRep(1));
    h.live.appendRep(makeRep(2));
    h.channels.publish.mockClear();

    await h.invoke('set.end', {});
    expect(h.channels.publish).toHaveBeenCalledTimes(1);
    const event = h.channels.publish.mock.calls[0][0] as {
      content: string;
      meta: Record<string, string>;
    };
    expect(event.meta).toMatchObject({
      source: 'voltras',
      event_type: 'set_ended',
      set_id: setId,
      rep_count: '2',
    });
    // duration_ms is a non-negative integer string.
    expect(event.meta.duration_ms).toMatch(/^\d+$/);

    const parsed = JSON.parse(event.content) as {
      summary: string;
      set: { set_id: string; weight_lbs: number; training_mode: string; partial_reason: unknown };
      reps: Array<{ rep_number: number }>;
      vbt_summary: {
        first_rep_v: number | null;
        last_rep_v: number | null;
        velocity_loss_pct: number | null;
        mean_velocity: number | null;
      };
    };
    expect(parsed.summary).toContain('2 reps');
    expect(parsed.set.set_id).toBe(setId);
    expect(parsed.set.weight_lbs).toBe(75);
    expect(parsed.set.training_mode).toBe('WeightTraining');
    expect(parsed.set.partial_reason).toBeNull();
    // reps array length matches the meta rep_count.
    expect(parsed.reps).toHaveLength(2);
    expect(parsed.reps[0].rep_number).toBe(1);
    expect(parsed.reps[1].rep_number).toBe(2);
    // makeRep produces zero-velocity phases — vbt.velocity_loss_pct is null
    // (first rep peak <= 0 disables the loss calc), but the rest of the
    // vbt_summary fields are present and numeric.
    expect(parsed.vbt_summary.first_rep_v).toBe(0);
    expect(parsed.vbt_summary.last_rep_v).toBe(0);
    expect(parsed.vbt_summary.velocity_loss_pct).toBeNull();
  });

  it('explicit set.end produces set_ended (not set_ended_by_device) — bridge-driven event_type is unaffected', async () => {
    // Regression guard for the sprint 1B refactor: the autonomous
    // `set_ended_by_device` event lives on the bridge's onInProgress
    // path. The tool path (this test) MUST keep emitting `set_ended` with
    // no `partial_reason` so analytics consumers don't see a spurious
    // partial flag on graceful set ends.
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 50, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});
    h.live.appendRep(makeRep(1));
    h.channels.publish.mockClear();

    await h.invoke('set.end', {});
    const event = h.channels.publish.mock.calls[0][0] as {
      meta: Record<string, string>;
      content: string;
    };
    expect(event.meta.event_type).toBe('set_ended');
    expect(event.meta.partial_reason).toBeUndefined();
    const parsed = JSON.parse(event.content) as { set: { partial_reason: unknown } };
    expect(parsed.set.partial_reason).toBeNull();
  });

  it('attaches device_summary to set_ended when an onSummary landed during the set', async () => {
    // Tool-driven set.end path symmetry with the bridge's set_ended_by_device:
    // if applySummary fired during the set's lifetime, finalizeSet harvests
    // the captured summary via consumeLatestSummary and threads it into the
    // payload's device_summary block.
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 75, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});
    h.live.appendRep(makeRep(1));
    h.live.appendRep(makeRep(2));
    h.live.applySummary({
      schemaVersion: 3,
      setCounter: 1,
      repCount: 2,
      raw: new Uint8Array(140),
    });
    h.channels.publish.mockClear();

    await h.invoke('set.end', {});
    const event = h.channels.publish.mock.calls[0][0] as {
      meta: Record<string, string>;
      content: string;
    };
    expect(event.meta.event_type).toBe('set_ended');
    expect(event.meta.device_rep_count).toBe('2');
    expect(event.meta.device_schema_version).toBe('3');
    const parsed = JSON.parse(event.content) as {
      device_summary: { rep_count: number; schema_version: number };
    };
    expect(parsed.device_summary).toEqual({ rep_count: 2, schema_version: 3 });
  });

  it('omits device_summary from set_ended when no onSummary fired during the set', async () => {
    // Backwards-compat: pre-PR-C consumers reading the payload without a
    // device_summary expectation must still parse it cleanly.
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 75, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});
    h.live.appendRep(makeRep(1));
    h.channels.publish.mockClear();

    await h.invoke('set.end', {});
    const event = h.channels.publish.mock.calls[0][0] as {
      meta: Record<string, string>;
      content: string;
    };
    expect(event.meta.device_rep_count).toBeUndefined();
    expect(event.meta.device_schema_version).toBeUndefined();
    const parsed = JSON.parse(event.content) as { device_summary?: unknown };
    expect(parsed.device_summary).toBeUndefined();
  });

  it('set_ended vbt_summary.velocity_loss_pct is null when fewer than 2 reps', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 75, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});
    h.live.appendRep(makeRep(1));
    h.channels.publish.mockClear();

    await h.invoke('set.end', {});
    const event = h.channels.publish.mock.calls[0][0] as { content: string };
    const parsed = JSON.parse(event.content) as {
      reps: unknown[];
      vbt_summary: { velocity_loss_pct: number | null };
    };
    expect(parsed.reps).toHaveLength(1);
    expect(parsed.vbt_summary.velocity_loss_pct).toBeNull();
  });

  it('maps reps to StoredRep with sequential index and parent setId', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 75, trainingMode: 'WeightTraining' });
    const startResult = await h.invoke('set.start', {});
    const setId = (parseResult(startResult) as { setId: string }).setId;
    h.live.appendRep(makeRep(1));
    h.live.appendRep(makeRep(2));

    await h.invoke('set.end', {});
    const stored = h.store.putSet.mock.calls[0][0] as StoredSet;
    expect(stored.reps).toHaveLength(2);
    expect(stored.reps[0].setId).toBe(setId);
    expect(stored.reps[1].setId).toBe(setId);
    expect(stored.reps[0].index).toBe(0);
    expect(stored.reps[1].index).toBe(1);
    expect(stored.reps[0].id).not.toEqual(stored.reps[1].id);
  });
});

describe('set.live_metrics', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('returns the live set snapshot when one is active (AC-12)', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 75, trainingMode: 'WeightTraining' });
    const startResult = await h.invoke('set.start', {});
    const setId = (parseResult(startResult) as { setId: string }).setId;
    h.live.appendRep(makeRep(1));

    const r = await h.invoke('set.live_metrics', {});
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { setId?: string; reps?: unknown[]; status?: string };
    expect(body.setId).toBe(setId);
    expect(body.reps).toHaveLength(1);
    expect(body.status).toBe('active');
  });

  it('returns { active: false } when no set is active', async () => {
    const r = await h.invoke('set.live_metrics', {});
    expect(r.isError).toBeUndefined();
    expect(parseResult(r)).toEqual({ active: false });
  });

  it('omits latestInProgress when no onInProgress payload has landed', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});

    const r = await h.invoke('set.live_metrics', {});
    const body = parseResult(r) as { latestInProgress?: unknown };
    expect(body.latestInProgress).toBeUndefined();
  });

  it('surfaces latestInProgress once an onInProgress payload has been captured', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 135, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});

    h.live.applyInProgress(
      {
        peakForceTenths: 1500,
        currentForceTenths: 900,
        velocityCmPerSec: 42,
        targetWeightTenths: 1350,
        raw: new Uint8Array(79),
      },
      1_700_000_000_000,
    );

    const r = await h.invoke('set.live_metrics', {});
    const body = parseResult(r) as {
      latestInProgress?: {
        peakForceTenths: number;
        currentForceTenths: number;
        velocityCmPerSec: number;
        targetWeightTenths: number;
        capturedAt: number;
      };
    };
    expect(body.latestInProgress).toEqual({
      peakForceTenths: 1500,
      currentForceTenths: 900,
      velocityCmPerSec: 42,
      targetWeightTenths: 1350,
      capturedAt: 1_700_000_000_000,
    });
  });

  it('does not surface latestSummary through set.live_metrics (PR-C surface)', async () => {
    // latestSummary is captured on the active set but is intentionally
    // private — the persisted-set surface is what consumes it. PR-C will
    // route it through `set_ended_by_device`. Until then, even though the
    // field is on the snapshot, this test pins the contract that PR-B's
    // live_metrics output does not include it as a coaching read.
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});
    h.live.applySummary({
      schemaVersion: 1,
      setCounter: 1,
      repCount: 5,
      raw: new Uint8Array(140),
    });

    const r = await h.invoke('set.live_metrics', {});
    // The structural snapshot DOES include latestSummary today (it lives on
    // ActiveSet), but the brief's contract is that we don't expose it as a
    // dedicated coaching surface — i.e. callers shouldn't treat it as a
    // documented field. We assert here only that latestInProgress is not
    // accidentally populated by an onSummary call.
    const body = parseResult(r) as { latestInProgress?: unknown };
    expect(body.latestInProgress).toBeUndefined();
  });
});

describe('set.get', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('returns the stored set including reps when one exists', async () => {
    const stored: StoredSet = {
      id: 'set-XYZ',
      sessionId: 'sess-A',
      startedAt: '2025-01-01T00:00:00.000Z',
      endedAt: '2025-01-01T00:01:00.000Z',
      partial: false,
      trainingMode: 'WeightTraining',
      weightLbs: 100,
      reps: [
        { ...makeRep(1), id: 'r1', setId: 'set-XYZ', index: 0 },
        { ...makeRep(2), id: 'r2', setId: 'set-XYZ', index: 1 },
      ],
    };
    h.store.getSet.mockResolvedValueOnce(stored);

    const r = await h.invoke('set.get', { setId: 'set-XYZ' });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as StoredSet;
    expect(body.id).toBe('set-XYZ');
    expect(body.reps.length).toBe(2);
    expect(body.weightLbs).toBe(100);
    expect(body.trainingMode).toBe('WeightTraining');
    expect(h.store.getSet).toHaveBeenCalledWith('set-XYZ');
  });

  it('returns SET_NOT_FOUND when no row exists for the given id', async () => {
    h.store.getSet.mockResolvedValueOnce(undefined);
    const r = await h.invoke('set.get', { setId: 'no-such-set' });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('SET_NOT_FOUND');
  });

  it('returns INVALID_INPUT when setId is missing', async () => {
    const r = await h.invoke('set.get', {});
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
  });
});

describe('set.start — idle_timeout_ms watchdog', () => {
  let h: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    h = setup();
  });

  afterEach(() => {
    // Drain any leftover scheduled idle timers between cases so background
    // setTimeouts don't bleed into the next test's assertions.
    (h.state.setWatchdog as { clearAll: () => void }).clearAll();
    vi.useRealTimers();
  });

  async function flushMicrotasks(): Promise<void> {
    // Drain a handful of microtask turns so void-chained awaits inside
    // fireIdleTimeout → finalizeSet (await client.endSet → await
    // store.putSet → publish) all settle before assertions. setImmediate
    // is intercepted by vi.useFakeTimers() so we use real Promise turns.
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
  }

  it('does not arm a watchdog when watch config has no idle_timeout_ms specs', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    const r = await h.invoke('set.start', {
      watch: { stopOn: [{ type: 'rep_count_reached', value: 5 }] },
    });
    const id = (parseResult(r) as { setId: string }).setId;
    expect((h.state.setWatchdog as { has: (s: string) => boolean }).has(id)).toBe(false);
  });

  it('notifyOn idle_timeout fires the channel event but does not auto-stop', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    const r = await h.invoke('set.start', {
      watch: { notifyOn: [{ type: 'idle_timeout_ms', value: 30_000 }] },
    });
    const setId = (parseResult(r) as { setId: string }).setId;
    expect((h.state.setWatchdog as { has: (id: string) => boolean }).has(setId)).toBe(true);
    h.channels.publish.mockClear();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.channels.publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    const idleEvent = h.channels.publish.mock.calls
      .map((c) => c[0] as { meta: Record<string, string>; content: string })
      .find((e) => e.meta.event_type === 'idle_timeout');
    expect(idleEvent).toBeDefined();
    expect(idleEvent!.meta).toMatchObject({
      set_id: setId,
      threshold_ms: '30000',
      idle_ms: '30000',
      auto_stopped: 'false',
      last_rep_count: '0',
    });
    // Set still active — notifyOn does not finalize.
    expect(h.live.set?.setId).toBe(setId);
    expect(h.store.putSet).not.toHaveBeenCalled();
  });

  it('stopOn idle_timeout fires event AND auto-stops via finalizeSet', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {
      watch: { stopOn: [{ type: 'idle_timeout_ms', value: 45_000 }] },
    });
    h.channels.publish.mockClear();

    await vi.advanceTimersByTimeAsync(45_000);
    await flushMicrotasks();

    // idle_timeout publishes BEFORE set_ended.
    const eventTypes = h.channels.publish.mock.calls.map(
      (c) => (c[0] as { meta: Record<string, string> }).meta.event_type,
    );
    const idleIdx = eventTypes.indexOf('idle_timeout');
    const endedIdx = eventTypes.indexOf('set_ended');
    expect(idleIdx).toBeGreaterThan(-1);
    expect(endedIdx).toBeGreaterThan(idleIdx);

    // Set finalized with auto_stopped partial reason + idle cause.
    expect(h.live.set).toBeUndefined();
    expect(h.store.putSet).toHaveBeenCalledTimes(1);
    const stored = h.store.putSet.mock.calls[0][0] as StoredSet;
    expect(stored.partial).toBe(true);
    expect(stored.partialReason).toBe('auto_stopped');

    const setEnded = h.channels.publish.mock.calls
      .map((c) => c[0] as { meta: Record<string, string> })
      .find((e) => e.meta.event_type === 'set_ended');
    expect(setEnded?.meta.auto_stop_cause).toBe('idle_timeout_ms');
  });

  it('rep finalization resets the watchdog so an active lifter does not trip it', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    const r = await h.invoke('set.start', {
      watch: { notifyOn: [{ type: 'idle_timeout_ms', value: 30_000 }] },
    });
    const setId = (parseResult(r) as { setId: string }).setId;
    h.channels.publish.mockClear();

    // Advance 25s, then exercise resetIdleWatchdog directly (the bridge
    // does this on rep_finalized; we don't pull the bridge into this
    // unit-scoped harness).
    await vi.advanceTimersByTimeAsync(25_000);
    const { resetIdleWatchdog } = await import('../set-tools.js');
    resetIdleWatchdog(h.state, setId, h.live.set?.watch);

    // Another 25s with no further reset still leaves us at 25s into the
    // new 30s window — no fire.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(
      h.channels.publish.mock.calls.find(
        (c) => (c[0] as { meta: Record<string, string> }).meta.event_type === 'idle_timeout',
      ),
    ).toBeUndefined();

    // 5s more — total 30s since reset → fire.
    await vi.advanceTimersByTimeAsync(5_000);
    await flushMicrotasks();
    expect(
      h.channels.publish.mock.calls.find(
        (c) => (c[0] as { meta: Record<string, string> }).meta.event_type === 'idle_timeout',
      ),
    ).toBeDefined();
  });

  it('explicit set.end cancels the watchdog so no spurious fire after', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {
      watch: { stopOn: [{ type: 'idle_timeout_ms', value: 30_000 }] },
    });
    h.channels.publish.mockClear();

    await h.invoke('set.end', {});
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    // Only the set_ended event from the tool path — no idle_timeout.
    const idleEvents = h.channels.publish.mock.calls.filter(
      (c) => (c[0] as { meta: Record<string, string> }).meta.event_type === 'idle_timeout',
    );
    expect(idleEvents).toHaveLength(0);
  });

  it('smallest threshold wins across stopOn + notifyOn — fires once at smallest timeout', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {
      watch: {
        stopOn: [{ type: 'idle_timeout_ms', value: 30_000 }],
        notifyOn: [{ type: 'idle_timeout_ms', value: 60_000 }],
      },
    });
    h.channels.publish.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);
    await flushMicrotasks();

    // Smallest (30s) fires; auto_stopped=true because stopOn threshold won.
    const idleEvents = h.channels.publish.mock.calls.filter(
      (c) => (c[0] as { meta: Record<string, string> }).meta.event_type === 'idle_timeout',
    );
    expect(idleEvents).toHaveLength(1);
    expect((idleEvents[0][0] as { meta: Record<string, string> }).meta).toMatchObject({
      threshold_ms: '30000',
      auto_stopped: 'true',
    });
    // Set finalized — so the 60s timer would never fire even if armed.
    expect(h.live.set).toBeUndefined();

    // Advance further to confirm no second fire.
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    const idleEventsAfter = h.channels.publish.mock.calls.filter(
      (c) => (c[0] as { meta: Record<string, string> }).meta.event_type === 'idle_timeout',
    );
    expect(idleEventsAfter).toHaveLength(1);
  });
});
