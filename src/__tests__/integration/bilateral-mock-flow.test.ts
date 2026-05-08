// Integration test: bilateral (dual-device) mock flow exercising the
// per-slot event bridge end-to-end (Step 4 of P0 dual-Voltras support).
//
// Boots an in-process VMCP server with the same harness pattern as
// `full-mock-flow.test.ts`, but configures the fake manager with TWO
// discoverable devices and drives parallel sessions / sets / rep streams
// through the `'left'` and `'right'` slots.
//
// What this test pins:
//   - device.connect with explicit `slot: 'left'` and `slot: 'right'`
//     allocates a second slot and bridges its events independently.
//   - session.start / set.start with explicit `slot` route to the right
//     slot's LiveState.
//   - Per-slot LiveState pipelines stay fully isolated — reps appended to
//     the left slot are absent from the right slot's set, and vice versa.
//   - Every channel event carries `slot` meta — `set_started`, `set_ended`,
//     `rep_finalized` (driven by direct LiveState mutation rather than
//     frame injection because the harness's FakeVoltraClient never emits
//     real frames; see file header on full-mock-flow.test.ts for the
//     rationale on direct-mutation rep injection).
//   - device.disconnect on a non-primary slot tears down its slot entry
//     and unwires the bridge; bootstrap's primary slot persists.
//
// Architectural deviations: same as `full-mock-flow.test.ts` (mocked SDK,
// direct `live.appendRep` to inject reps). The set_ended payload is built
// off the LiveState snapshot at finalize time, so the slot-specific rep
// counts surface in the assertions even though the bridge's onFrame path
// isn't exercised.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class FakeVoltraSDKError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'VoltraSDKError';
    this.code = code;
  }
}

class FakeVoltraClient {
  isConnected = false;
  connectionState: 'disconnected' | 'connecting' | 'authenticating' | 'connected' = 'disconnected';
  connectedDeviceId: string | null = null;
  settings: Record<string, unknown> | undefined = undefined;

  onPerRep(_cb: (event: unknown) => void): () => void {
    return () => undefined;
  }
  onInProgress(_cb: (event: unknown) => void): () => void {
    return () => undefined;
  }
  onSummary(_cb: (event: unknown) => void): () => void {
    return () => undefined;
  }
  onPreSummary(_cb: (event: unknown) => void): () => void {
    return () => undefined;
  }
  onSettingsUpdate(_cb: (s: unknown) => void): () => void {
    return () => undefined;
  }
  onConnectionStateChange(_cb: (s: unknown) => void): () => void {
    return () => undefined;
  }
  onFrame(_cb: (frame: unknown) => void): () => void {
    return () => undefined;
  }
  setWeight(_lbs: number): Promise<void> {
    return Promise.resolve();
  }
  setMode(_mode: number): Promise<void> {
    return Promise.resolve();
  }
  setChains(_lbs: number): Promise<void> {
    return Promise.resolve();
  }
  setEccentric(_pct: number): Promise<void> {
    return Promise.resolve();
  }
  startRecording(): Promise<void> {
    return Promise.resolve();
  }
  endSet(): Promise<void> {
    return Promise.resolve();
  }
  async connect(device: { id: string }): Promise<void> {
    this.isConnected = true;
    this.connectionState = 'connected';
    this.connectedDeviceId = device.id;
  }
  async disconnect(): Promise<void> {
    this.isConnected = false;
    this.connectionState = 'disconnected';
    this.connectedDeviceId = null;
  }
}

class FakeVoltraManager {
  // Two devices so `device.scan` + two `device.connect(slot=...)` calls
  // succeed against distinct deviceIds — the bilateral lift's left/right
  // arms run on physically separate Voltras.
  readonly devices = [
    { id: 'mock-voltra-LEFT', name: 'VTR-Left', rssi: -50 },
    { id: 'mock-voltra-RIGHT', name: 'VTR-Right', rssi: -52 },
  ];
  readonly clients = new Map<string, FakeVoltraClient>();

  static forMock(): FakeVoltraManager {
    return new FakeVoltraManager();
  }
  static forNode(): FakeVoltraManager {
    return new FakeVoltraManager();
  }
  scan(): Promise<typeof this.devices> {
    return Promise.resolve(this.devices);
  }
  async connect(device: { id: string }): Promise<FakeVoltraClient> {
    const c = new FakeVoltraClient();
    await c.connect(device);
    this.clients.set(device.id, c);
    return c;
  }
  async disconnect(deviceId: string): Promise<void> {
    await this.clients.get(deviceId)?.disconnect();
    this.clients.delete(deviceId);
  }
  isConnected(deviceId: string): boolean {
    return this.clients.has(deviceId);
  }
  getClient(deviceId: string): FakeVoltraClient | undefined {
    return this.clients.get(deviceId);
  }
  dispose(): void {
    this.clients.clear();
  }
}

vi.mock('@voltras/node-sdk', () => ({
  VoltraSDKError: FakeVoltraSDKError,
  VoltraClient: FakeVoltraClient,
  VoltraManager: FakeVoltraManager,
  TrainingMode: {
    Idle: 0,
    WeightTraining: 1,
    ResistanceBand: 2,
    Rowing: 3,
    Damper: 4,
    CustomCurves: 6,
    Isokinetic: 7,
    Isometric: 8,
    0: 'Idle',
    1: 'WeightTraining',
    2: 'ResistanceBand',
    3: 'Rowing',
    4: 'Damper',
    6: 'CustomCurves',
    7: 'Isokinetic',
    8: 'Isometric',
  },
  TrainingModeNames: {
    0: 'Idle',
    1: 'WeightTraining',
    2: 'ResistanceBand',
    3: 'Rowing',
    4: 'Damper',
    6: 'CustomCurves',
    7: 'Isokinetic',
    8: 'Isometric',
  },
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Rep } from '@voltras/workout-analytics';
import { z } from 'zod';

const { bootstrapState, getSlot } = await import('../../state/server-state.js');
const { wireEventBridge } = await import('../../state/event-bridge.js');
const { errorResult } = await import('../../tools/helpers.js');
const { registerDeviceTools } = await import('../../tools/device-tools.js');
const { registerSessionTools } = await import('../../tools/session-tools.js');
const { registerSetTools } = await import('../../tools/set-tools.js');
const { registerMockTools } = await import('../../tools/mock-tools.js');
const { registerDeviceResource } = await import('../../resources/device-resource.js');
const { registerSessionResource } = await import('../../resources/session-resource.js');
const { registerSetResource } = await import('../../resources/set-resource.js');

import type { ServerState } from '../../state/server-state.js';
import type { ChannelEvent, ChannelPublisher } from '../../state/channel-publisher.js';
import type { ToolResult } from '../../tools/helpers.js';

const CORE_TOOL_NAMES = [
  'device.scan',
  'device.connect',
  'device.disconnect',
  'device.set_weight',
  'device.set_mode',
  'device.set_chains',
  'device.set_eccentric',
  'device.get_state',
  'session.start',
  'session.end',
  'session.list',
  'session.get',
  'set.start',
  'set.end',
  'set.live_metrics',
  'set.get',
  'metrics.compute',
  'exercise.search',
  'exercise.get',
  'server.health',
  'debug.recent_frames',
  'debug.recent_events',
  'debug.push_test_channel',
] as const;
const MOCK_TOOL_NAMES = ['mock.configure', 'mock.inject_error'] as const;

interface RecordedChannelEvent extends ChannelEvent {
  // Convenience alias: `meta.slot` is the load-bearing field for the
  // bilateral assertions, so test bodies read `event.slot` instead of
  // peeling it off `event.meta.slot` every time.
  slot: string | undefined;
}

interface Harness {
  client: Client;
  state: ServerState;
  events: RecordedChannelEvent[];
  cleanup: () => Promise<void>;
}

/**
 * Build an in-process VMCP harness wired through `InMemoryTransport`.
 * Mirrors the `full-mock-flow.test.ts` bootstrap order but installs a
 * recording channel publisher so the test can inspect every push event
 * — the bilateral assertions are entirely about which slot tag rides
 * along with each event.
 */
async function buildHarness(): Promise<Harness> {
  const dbDir = mkdtempSync(join(tmpdir(), 'vmcp-bilateral-it-'));
  const dbPath = join(dbDir, 'integration.sqlite');

  const server = new McpServer(
    { name: 'voltras-mcp', version: '0.1.0' },
    { capabilities: { tools: {}, resources: { subscribe: true } } },
  );

  const startingResult = (): ToolResult =>
    errorResult({ code: 'STARTING', message: 'Server is initializing — try again in a moment.' });
  const placeholders = new Map<string, RegisteredTool>();
  for (const name of [...CORE_TOOL_NAMES, ...MOCK_TOOL_NAMES]) {
    placeholders.set(
      name,
      server.registerTool(name, { inputSchema: z.object({}).passthrough() }, () =>
        startingResult(),
      ),
    );
  }

  const stateBox: { value?: ServerState } = {};
  const lazyState = {
    live: {
      snapshotDevice: () =>
        stateBox.value ? getSlot(stateBox.value).live.snapshotDevice() : { connected: false },
      snapshotSession: () =>
        stateBox.value ? getSlot(stateBox.value).live.snapshotSession() : undefined,
      snapshotSet: () => (stateBox.value ? getSlot(stateBox.value).live.snapshotSet() : undefined),
    },
  } as Parameters<typeof registerDeviceResource>[1];
  registerDeviceResource(server, lazyState);
  registerSessionResource(server, lazyState);
  registerSetResource(server, lazyState);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'voltras-mcp-bilateral-it', version: '0.0.1' },
    { capabilities: {} },
  );
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const state = await bootstrapState({ adapter: 'mock', dbPath, logLevel: 'error' });
  stateBox.value = state;

  // Recording channel publisher: every event published — directly or via
  // a slot-scoped wrapper — appends to `events` for inspection. Slot meta
  // tagging is handled by the production `slotScopedPublisher` shape;
  // `recordingPublisher` mirrors that, so events surface with
  // `meta.slot` already merged in regardless of which entry point published.
  const events: RecordedChannelEvent[] = [];
  const recordingPublisher: ChannelPublisher = {
    publish: (event) => {
      events.push({ ...event, slot: event.meta.slot });
    },
    forSlot: (slotId: string) => ({
      publish: (event) => {
        events.push({
          content: event.content,
          meta: { slot: slotId, ...event.meta },
          slot: slotId,
        });
      },
      forSlot: () => recordingPublisher,
    }),
  };
  state.channels = recordingPublisher;
  state.server = server;
  wireEventBridge(state);

  registerDeviceTools(server, state, placeholders);
  registerSessionTools(server, state, placeholders);
  registerSetTools(server, state, placeholders);
  registerMockTools(server, state, placeholders);

  const cleanup = async (): Promise<void> => {
    await client.close();
    await server.close();
    state.manager.dispose();
    await state.store.close();
    rmSync(dbDir, { recursive: true, force: true });
  };

  return { client, state, events, cleanup };
}

interface ToolCallEnvelope {
  isError?: boolean;
  payload: Record<string, unknown>;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolCallEnvelope> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  return {
    isError: result.isError,
    payload: JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>,
  };
}

/**
 * Build a structurally-valid `Rep` matching the upstream `Rep` shape from
 * `@voltras/workout-analytics`. Identical to full-mock-flow's helper —
 * duplicated here because TypeScript's import-from-test-file pattern would
 * fight vitest's per-file vi.mock hoisting.
 */
function syntheticRep(repNumber: number, peakBoost = 0): Rep {
  const emptyPhase = {
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
    peakVelocity: 0.5 + repNumber * 0.01 + peakBoost,
    peakForce: 100,
    peakLoad: 100,
  };
  return {
    repNumber,
    concentric: { ...emptyPhase },
    eccentric: { ...emptyPhase, peakVelocity: 0.3 + repNumber * 0.01 + peakBoost },
  };
}

describe('VMCP bilateral mock-adapter flow (integration)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await buildHarness();
  });

  afterAll(async () => {
    await h.cleanup();
  });

  it('runs two devices in parallel slots with isolated rep streams and slot-tagged channel events', async () => {
    // ── Discovery: two devices visible to scan ──────────────────────────
    const scan = await call(h.client, 'device.scan', { timeoutMs: 1000 });
    expect(scan.isError).toBeUndefined();
    const devices = scan.payload.devices as Array<{ id: string; name: string | null }>;
    expect(devices.length).toBeGreaterThanOrEqual(2);
    const leftDeviceId = devices[0].id;
    const rightDeviceId = devices[1].id;
    expect(leftDeviceId).not.toBe(rightDeviceId);

    // ── Allocate two slots via explicit `slot` argument ─────────────────
    const connectLeft = await call(h.client, 'device.connect', {
      deviceId: leftDeviceId,
      slot: 'left',
    });
    expect(connectLeft.isError).toBeUndefined();
    expect(h.state.slots.has('left')).toBe(true);

    const connectRight = await call(h.client, 'device.connect', {
      deviceId: rightDeviceId,
      slot: 'right',
    });
    expect(connectRight.isError).toBeUndefined();
    expect(h.state.slots.has('right')).toBe(true);

    // Stamp distinct device snapshots so the persisted set reflects per-slot
    // configuration. Each slot's LiveState is independent — the apply on
    // `left` must NOT bleed into `right`.
    getSlot(h.state, 'left').live.applySettings({
      connected: true,
      weightLbs: 35,
      trainingMode: 'WeightTraining',
    });
    getSlot(h.state, 'right').live.applySettings({
      connected: true,
      weightLbs: 40,
      trainingMode: 'WeightTraining',
    });

    // ── Sessions: one per slot ──────────────────────────────────────────
    const sessionLeft = await call(h.client, 'session.start', {
      exerciseName: 'Cable Chest Fly',
      slot: 'left',
    });
    expect(sessionLeft.isError).toBeUndefined();
    const sessionLeftId = sessionLeft.payload.sessionId as string;

    const sessionRight = await call(h.client, 'session.start', {
      exerciseName: 'Cable Chest Fly',
      slot: 'right',
    });
    expect(sessionRight.isError).toBeUndefined();
    const sessionRightId = sessionRight.payload.sessionId as string;

    expect(sessionLeftId).not.toBe(sessionRightId);
    // Per-slot LiveState surfaces independent sessions.
    expect(getSlot(h.state, 'left').live.snapshotSession()?.sessionId).toBe(sessionLeftId);
    expect(getSlot(h.state, 'right').live.snapshotSession()?.sessionId).toBe(sessionRightId);

    // ── Parallel sets ───────────────────────────────────────────────────
    const setLeft = await call(h.client, 'set.start', { slot: 'left' });
    expect(setLeft.isError).toBeUndefined();
    const setLeftId = setLeft.payload.setId as string;

    const setRight = await call(h.client, 'set.start', { slot: 'right' });
    expect(setRight.isError).toBeUndefined();
    const setRightId = setRight.payload.setId as string;

    expect(setLeftId).not.toBe(setRightId);

    // Both `set_started` events were tagged with their originating slot.
    const setStartedEvents = h.events.filter((e) => e.meta.event_type === 'set_started');
    expect(setStartedEvents).toHaveLength(2);
    const leftStarted = setStartedEvents.find((e) => e.meta.set_id === setLeftId);
    const rightStarted = setStartedEvents.find((e) => e.meta.set_id === setRightId);
    expect(leftStarted?.slot).toBe('left');
    expect(rightStarted?.slot).toBe('right');

    // ── Three reps per slot via direct LiveState injection ──────────────
    // Boost the right slot's peak velocity so we can eyeball cross-talk:
    // if reps from left leaked into right's set (or vice versa), the
    // post-finalize comparisons below would catch the mix.
    for (let i = 1; i <= 3; i += 1) {
      getSlot(h.state, 'left').live.appendRep(syntheticRep(i, 0));
      getSlot(h.state, 'right').live.appendRep(syntheticRep(i, 0.2));
    }

    // Per-slot LiveState now reports 3 reps each — strict isolation.
    expect(getSlot(h.state, 'left').live.snapshotSet()?.reps.length).toBe(3);
    expect(getSlot(h.state, 'right').live.snapshotSet()?.reps.length).toBe(3);
    // Eyeball test for cross-talk: the right slot's peak velocities are
    // boosted by 0.2 over the left's, so peak[0] differs between sets.
    expect(
      getSlot(h.state, 'left').live.snapshotSet()?.reps[0]?.concentric.peakVelocity,
    ).toBeLessThan(
      getSlot(h.state, 'right').live.snapshotSet()?.reps[0]?.concentric.peakVelocity ?? 0,
    );

    // ── Finalize both sets ──────────────────────────────────────────────
    const endLeft = await call(h.client, 'set.end', { slot: 'left' });
    expect(endLeft.isError).toBeUndefined();
    expect(endLeft.payload).toEqual({ ok: true, reps: 3 });

    const endRight = await call(h.client, 'set.end', { slot: 'right' });
    expect(endRight.isError).toBeUndefined();
    expect(endRight.payload).toEqual({ ok: true, reps: 3 });

    // Persisted rows reflect per-slot weight/training mode — proves the
    // device snapshot taken at `set.start` was per-slot, not shared.
    const persistedLeft = await h.state.store.getSet(setLeftId);
    const persistedRight = await h.state.store.getSet(setRightId);
    expect(persistedLeft?.weightLbs).toBe(35);
    expect(persistedRight?.weightLbs).toBe(40);
    expect(persistedLeft?.reps.length).toBe(3);
    expect(persistedRight?.reps.length).toBe(3);

    // `set_ended` events were also slot-tagged.
    const setEndedEvents = h.events.filter((e) => e.meta.event_type === 'set_ended');
    expect(setEndedEvents).toHaveLength(2);
    const leftEnded = setEndedEvents.find((e) => e.meta.set_id === setLeftId);
    const rightEnded = setEndedEvents.find((e) => e.meta.set_id === setRightId);
    expect(leftEnded?.slot).toBe('left');
    expect(rightEnded?.slot).toBe('right');

    // Every channel event observed in this scenario carries a `slot` meta.
    // No event from the bilateral path may slip through untagged.
    for (const event of h.events) {
      expect(event.meta.slot).toBeDefined();
      expect(['left', 'right', 'primary']).toContain(event.meta.slot);
    }

    // ── End sessions ────────────────────────────────────────────────────
    const endSessionLeft = await call(h.client, 'session.end', { slot: 'left' });
    expect(endSessionLeft.isError).toBeUndefined();
    const endSessionRight = await call(h.client, 'session.end', { slot: 'right' });
    expect(endSessionRight.isError).toBeUndefined();

    // ── Disconnect both slots; primary persists ─────────────────────────
    const disconnectLeft = await call(h.client, 'device.disconnect', { slot: 'left' });
    expect(disconnectLeft.isError).toBeUndefined();
    expect(h.state.slots.has('left')).toBe(false);

    const disconnectRight = await call(h.client, 'device.disconnect', { slot: 'right' });
    expect(disconnectRight.isError).toBeUndefined();
    expect(h.state.slots.has('right')).toBe(false);

    // Primary slot was never touched by this scenario — it still exists in
    // the slots map (bootstrap shape) so a single-device flow can still
    // resolve `getSlot(state)` without an explicit slot argument.
    expect(h.state.slots.size).toBe(1);
    expect(h.state.slots.has('primary')).toBe(true);
  });
});
