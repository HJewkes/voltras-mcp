// Unit tests for `device.send_raw` — the diagnostic byte-pipe MCP tool.
//
// Strategy mirrors `device-tools.test.ts`: the SDK is fully stubbed via
// `vi.mock('@voltras/node-sdk')`, the placeholder map is a hand-rolled fake
// of `RegisteredTool.update`, and the slot-scoped state is constructed
// manually. The send_raw handler reaches `client.getAdapter()` and the
// adapter's `write` / `onNotification` methods, so the FakeClient surface
// here is broader than what the other device tests need.
//
// Coverage targets (per task brief):
//   * hex string input -> Uint8Array
//   * array input -> Uint8Array
//   * invalid hex -> error
//   * out-of-range byte (e.g. 256) -> error
//   * mock adapter -> error (diagnostic-tool gate)
//   * missing `confirm: true` -> error
//   * successful write
//   * debug-event log entry verified

import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

class FakeVoltraSDKError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'VoltraSDKError';
    this.code = code;
  }
}

const FakeTrainingMode = {
  Idle: 0,
  WeightTraining: 1,
  ResistanceBand: 2,
  Damper: 4,
  Isokinetic: 7,
  0: 'Idle',
  1: 'WeightTraining',
  2: 'ResistanceBand',
  4: 'Damper',
  7: 'Isokinetic',
} as const;

vi.mock('@voltras/node-sdk', () => ({
  TrainingMode: FakeTrainingMode,
  VoltraSDKError: FakeVoltraSDKError,
  VoltraClient: class {},
}));

vi.mock('../../state/event-bridge.js', () => ({
  wireBridgeForSlot: vi.fn(() => vi.fn()),
}));

const { _resetDebugBuffersForTest, getDebugBuffers } = await import('../../state/debug-buffer.js');
const { registerDeviceTools } = await import('../device-tools.js');

// ── Fakes ────────────────────────────────────────────────────────────────

interface FakeAdapter {
  write: Mock<(data: Uint8Array) => Promise<void>>;
  onNotification: Mock<(cb: (data: Uint8Array) => void) => () => void>;
  /** Test handle: emit a notification to every active onNotification listener. */
  emit: (data: Uint8Array) => void;
}

function makeFakeAdapter(): FakeAdapter {
  const listeners = new Set<(data: Uint8Array) => void>();
  const adapter: FakeAdapter = {
    write: vi.fn(async () => undefined),
    onNotification: vi.fn((cb: (data: Uint8Array) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    emit: (data: Uint8Array) => {
      for (const cb of listeners) cb(data);
    },
  };
  return adapter;
}

interface FakeClient {
  isConnected: boolean;
  connectionState: string;
  connectedDeviceId: string | null;
  settings: Record<string, unknown>;
  getAdapter: Mock<() => FakeAdapter | null>;
  dispose: Mock<() => void>;
}

function makeFakeClient(adapter: FakeAdapter | null = null): FakeClient {
  return {
    isConnected: adapter !== null,
    connectionState: adapter !== null ? 'connected' : 'disconnected',
    connectedDeviceId: adapter !== null ? 'V-1' : null,
    settings: {
      weight: 5,
      chains: 0,
      inverseChains: 0,
      eccentric: 0,
      mode: FakeTrainingMode.Idle,
      battery: null,
    },
    getAdapter: vi.fn(() => adapter),
    dispose: vi.fn(),
  };
}

interface FakeSlot {
  slotId: string;
  client: FakeClient;
  live: Record<string, never>;
}

interface State {
  config: { adapter: 'node' | 'mock'; dbPath: string; logLevel: 'info' };
  manager: Record<string, unknown>;
  slots: Map<string, FakeSlot>;
}

function makeState(
  adapterMode: 'node' | 'mock' = 'node',
  adapter: FakeAdapter | null = null,
): State {
  const slots = new Map<string, FakeSlot>();
  slots.set('primary', { slotId: 'primary', client: makeFakeClient(adapter), live: {} });
  return {
    config: { adapter: adapterMode, dbPath: '/tmp/test.sqlite', logLevel: 'info' },
    manager: { devices: [], scan: vi.fn(), connect: vi.fn(), disconnect: vi.fn() },
    slots,
  };
}

// Minimal fake McpServer that records placeholder registrations so the
// registration loop has somewhere to write update() calls.
interface RecordedTool {
  callback: (args: unknown, extra?: unknown) => Promise<unknown>;
  update: Mock<
    (updates: { callback?: (args: unknown, extra?: unknown) => Promise<unknown> }) => void
  >;
}

function buildPlaceholderMap(names: string[]): Map<string, RecordedTool> {
  const placeholders = new Map<string, RecordedTool>();
  for (const name of names) {
    const reg: RecordedTool = {
      callback: async () => ({
        content: [{ type: 'text', text: '{"code":"STARTING"}' }],
        isError: true,
      }),
      update: vi.fn((updates) => {
        if (updates.callback) reg.callback = updates.callback;
      }),
    };
    placeholders.set(name, reg);
  }
  return placeholders;
}

const ALL_DEVICE_TOOL_NAMES = [
  'device.scan',
  'device.connect',
  'device.disconnect',
  'device.set_weight',
  'device.set_mode',
  'device.set_chains',
  'device.set_eccentric',
  'device.set_damper_level',
  'device.set_assist_mode',
  'device.set_band_max_force',
  'device.set_isokinetic_target_speed',
  'device.set_isokinetic_ecc_mode',
  'device.set_isokinetic_ecc_speed_limit',
  'device.set_isokinetic_ecc_const_weight',
  'device.set_isokinetic_ecc_overload_weight',
  'device.get_state',
  'device.send_raw',
];

function setup(
  adapterMode: 'node' | 'mock' = 'node',
  adapter: FakeAdapter | null = null,
): {
  state: State;
  placeholders: Map<string, RecordedTool>;
  invoke: (
    name: string,
    args: unknown,
  ) => Promise<{ isError?: boolean; payload: Record<string, unknown> }>;
} {
  const state = makeState(adapterMode, adapter);
  const placeholders = buildPlaceholderMap(ALL_DEVICE_TOOL_NAMES);
  registerDeviceTools(
    {} as never,
    state as unknown as Parameters<typeof registerDeviceTools>[1],
    placeholders as unknown as Parameters<typeof registerDeviceTools>[2],
  );
  const invoke = async (name: string, args: unknown) => {
    const reg = placeholders.get(name)!;
    const result = (await reg.callback(args)) as {
      isError?: boolean;
      content: Array<{ type: 'text'; text: string }>;
    };
    return {
      isError: result.isError,
      payload: JSON.parse(result.content[0].text) as Record<string, unknown>,
    };
  };
  return { state, placeholders, invoke };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('device.send_raw', () => {
  beforeEach(() => {
    _resetDebugBuffersForTest();
  });

  describe('input parsing', () => {
    it('accepts a hex string and writes the parsed Uint8Array to the adapter', async () => {
      const adapter = makeFakeAdapter();
      const { invoke } = setup('node', adapter);
      const { isError, payload } = await invoke('device.send_raw', {
        bytes: 'AA811001020304',
        confirm: true,
      });
      expect(isError).toBeUndefined();
      expect(adapter.write).toHaveBeenCalledTimes(1);
      const written = adapter.write.mock.calls[0][0];
      expect(written).toBeInstanceOf(Uint8Array);
      expect(Array.from(written)).toEqual([0xaa, 0x81, 0x10, 0x01, 0x02, 0x03, 0x04]);
      expect(payload).toMatchObject({
        ok: true,
        bytesWritten: 7,
        bytesHex: 'aa811001020304',
      });
      expect(typeof payload.timestamp).toBe('string');
    });

    it('accepts an integer array and writes the corresponding Uint8Array', async () => {
      const adapter = makeFakeAdapter();
      const { invoke } = setup('node', adapter);
      const { isError, payload } = await invoke('device.send_raw', {
        bytes: [0xaa, 0x81, 0x10, 1, 2, 3, 4],
        confirm: true,
      });
      expect(isError).toBeUndefined();
      const written = adapter.write.mock.calls[0][0];
      expect(Array.from(written)).toEqual([0xaa, 0x81, 0x10, 1, 2, 3, 4]);
      expect(payload).toMatchObject({
        bytesWritten: 7,
        bytesHex: 'aa811001020304',
      });
    });

    it('rejects an invalid hex string with INVALID_INPUT', async () => {
      const adapter = makeFakeAdapter();
      const { invoke } = setup('node', adapter);
      const { isError, payload } = await invoke('device.send_raw', {
        bytes: 'AA8GZZ', // G and Z are not hex digits
        confirm: true,
      });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(adapter.write).not.toHaveBeenCalled();
    });

    it('rejects an odd-length hex string with INVALID_INPUT', async () => {
      const adapter = makeFakeAdapter();
      const { invoke } = setup('node', adapter);
      const { isError, payload } = await invoke('device.send_raw', {
        bytes: 'AAB', // 3 chars, not a whole number of bytes
        confirm: true,
      });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(adapter.write).not.toHaveBeenCalled();
    });

    it('rejects an out-of-range byte in the array form (256) with INVALID_INPUT', async () => {
      const adapter = makeFakeAdapter();
      const { invoke } = setup('node', adapter);
      const { isError, payload } = await invoke('device.send_raw', {
        bytes: [0xaa, 256, 0x10],
        confirm: true,
      });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(adapter.write).not.toHaveBeenCalled();
    });

    it('rejects a negative byte in the array form with INVALID_INPUT', async () => {
      const adapter = makeFakeAdapter();
      const { invoke } = setup('node', adapter);
      const { isError, payload } = await invoke('device.send_raw', {
        bytes: [0xaa, -1, 0x10],
        confirm: true,
      });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(adapter.write).not.toHaveBeenCalled();
    });

    it('rejects an empty array with INVALID_INPUT', async () => {
      const adapter = makeFakeAdapter();
      const { invoke } = setup('node', adapter);
      const { isError, payload } = await invoke('device.send_raw', {
        bytes: [],
        confirm: true,
      });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(adapter.write).not.toHaveBeenCalled();
    });
  });

  describe('confirm gate', () => {
    it('rejects a call missing `confirm: true` with INVALID_INPUT', async () => {
      const adapter = makeFakeAdapter();
      const { invoke } = setup('node', adapter);
      const { isError, payload } = await invoke('device.send_raw', {
        bytes: 'AA',
      });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(adapter.write).not.toHaveBeenCalled();
    });

    it('rejects a call with `confirm: false` with INVALID_INPUT', async () => {
      const adapter = makeFakeAdapter();
      const { invoke } = setup('node', adapter);
      const { isError, payload } = await invoke('device.send_raw', {
        bytes: 'AA',
        confirm: false,
      });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(adapter.write).not.toHaveBeenCalled();
    });
  });

  describe('mock-adapter gate', () => {
    it('returns MOCK_NOT_SUPPORTED in mock mode and does not write to any adapter', async () => {
      const adapter = makeFakeAdapter();
      const { invoke } = setup('mock', adapter);
      const { isError, payload } = await invoke('device.send_raw', {
        bytes: 'AA811001',
        confirm: true,
      });
      expect(isError).toBe(true);
      expect(payload.code).toBe('MOCK_NOT_SUPPORTED');
      expect(adapter.write).not.toHaveBeenCalled();
    });
  });

  describe('connection preconditions', () => {
    it('returns NOT_CONNECTED when the slot has no adapter', async () => {
      const { invoke } = setup('node', null);
      const { isError, payload } = await invoke('device.send_raw', {
        bytes: 'AA',
        confirm: true,
      });
      expect(isError).toBe(true);
      expect(payload.code).toBe('NOT_CONNECTED');
    });

    it('returns NOT_CONNECTED when the adapter exists but client.isConnected is false', async () => {
      const adapter = makeFakeAdapter();
      const { state, invoke } = setup('node', adapter);
      state.slots.get('primary')!.client.isConnected = false;
      const { isError, payload } = await invoke('device.send_raw', {
        bytes: 'AA',
        confirm: true,
      });
      expect(isError).toBe(true);
      expect(payload.code).toBe('NOT_CONNECTED');
      expect(adapter.write).not.toHaveBeenCalled();
    });
  });

  describe('successful write', () => {
    it('returns ok with the hex echo and the byte count, no responses field when expectResponse omitted', async () => {
      const adapter = makeFakeAdapter();
      const { invoke } = setup('node', adapter);
      const { isError, payload } = await invoke('device.send_raw', {
        bytes: [0xaa, 0x81, 0x10],
        confirm: true,
      });
      expect(isError).toBeUndefined();
      expect(payload).toMatchObject({
        ok: true,
        bytesWritten: 3,
        bytesHex: 'aa8110',
      });
      expect(payload).not.toHaveProperty('responses');
    });

    it('captures responses received during the response window when expectResponse=true', async () => {
      const adapter = makeFakeAdapter();
      const { invoke } = setup('node', adapter);
      // Arrange: emit a notification while the write is in flight. The
      // adapter.write fake awaits zero microtasks; we hook into it so the
      // listener is armed before the timer expires.
      adapter.write.mockImplementationOnce(async (_data: Uint8Array) => {
        // Synchronously emit a frame as if the device replied immediately.
        adapter.emit(new Uint8Array([0xbb, 0xcc]));
      });
      const { isError, payload } = await invoke('device.send_raw', {
        bytes: 'AA',
        expectResponse: true,
        responseWindowMs: 10,
        confirm: true,
      });
      expect(isError).toBeUndefined();
      expect(payload.responses).toBeDefined();
      const responses = payload.responses as Array<{ bytesHex: string; capturedAt: string }>;
      expect(responses.length).toBe(1);
      expect(responses[0].bytesHex).toBe('bbcc');
      expect(typeof responses[0].capturedAt).toBe('string');
    });

    it('returns an empty responses array when the window expires with no replies', async () => {
      const adapter = makeFakeAdapter();
      const { invoke } = setup('node', adapter);
      const { isError, payload } = await invoke('device.send_raw', {
        bytes: 'AA',
        expectResponse: true,
        responseWindowMs: 5,
        confirm: true,
      });
      expect(isError).toBeUndefined();
      expect(Array.isArray(payload.responses)).toBe(true);
      expect((payload.responses as unknown[]).length).toBe(0);
    });

    it('detaches the notification listener after the window expires', async () => {
      const adapter = makeFakeAdapter();
      const unsubscribe = vi.fn();
      adapter.onNotification.mockImplementation(() => unsubscribe);
      const { invoke } = setup('node', adapter);
      await invoke('device.send_raw', {
        bytes: 'AA',
        expectResponse: true,
        responseWindowMs: 5,
        confirm: true,
      });
      expect(unsubscribe).toHaveBeenCalled();
    });
  });

  describe('debug-event audit', () => {
    it('appends a `send_raw` event with the hex echo on a successful write', async () => {
      const adapter = makeFakeAdapter();
      const { invoke } = setup('node', adapter);
      await invoke('device.send_raw', {
        bytes: 'AA8110',
        confirm: true,
      });
      const events = getDebugBuffers().events.recent(10);
      const sendRaw = events.filter((e) => e.type === 'send_raw');
      expect(sendRaw.length).toBe(1);
      expect(sendRaw[0].payload).toMatchObject({
        slot: 'primary',
        bytesWritten: 3,
        bytesHex: 'aa8110',
        expectResponse: false,
        outcome: 'ok',
      });
    });

    it('appends a `send_raw` event with outcome=mock_not_supported when running in mock mode', async () => {
      const adapter = makeFakeAdapter();
      const { invoke } = setup('mock', adapter);
      await invoke('device.send_raw', {
        bytes: 'AA8110',
        confirm: true,
      });
      const events = getDebugBuffers().events.recent(10);
      const sendRaw = events.filter((e) => e.type === 'send_raw');
      expect(sendRaw.length).toBe(1);
      expect(sendRaw[0].payload).toMatchObject({
        outcome: 'mock_not_supported',
      });
    });

    it('appends a `send_raw` event with outcome=write_failed when adapter.write rejects', async () => {
      const adapter = makeFakeAdapter();
      adapter.write.mockRejectedValueOnce(new Error('BLE write failed'));
      const { invoke } = setup('node', adapter);
      const { isError } = await invoke('device.send_raw', {
        bytes: 'AA',
        confirm: true,
      });
      expect(isError).toBe(true);
      const events = getDebugBuffers().events.recent(10);
      const sendRaw = events.filter((e) => e.type === 'send_raw');
      expect(sendRaw.length).toBe(1);
      expect(sendRaw[0].payload).toMatchObject({
        outcome: 'write_failed',
      });
    });

    it('records responsesCaptured count in the audit event when expectResponse=true', async () => {
      const adapter = makeFakeAdapter();
      adapter.write.mockImplementationOnce(async () => {
        adapter.emit(new Uint8Array([0x01]));
        adapter.emit(new Uint8Array([0x02, 0x03]));
      });
      const { invoke } = setup('node', adapter);
      await invoke('device.send_raw', {
        bytes: 'AA',
        expectResponse: true,
        responseWindowMs: 10,
        confirm: true,
      });
      const events = getDebugBuffers().events.recent(10);
      const sendRaw = events.filter((e) => e.type === 'send_raw');
      expect(sendRaw[0].payload).toMatchObject({
        outcome: 'ok',
        responsesCaptured: 2,
        expectResponse: true,
      });
    });
  });

  describe('slot routing', () => {
    it('routes to the primary slot by default', async () => {
      const adapter = makeFakeAdapter();
      const { state, invoke } = setup('node', adapter);
      await invoke('device.send_raw', {
        bytes: 'AA',
        confirm: true,
      });
      expect(state.slots.get('primary')!.client.getAdapter).toHaveBeenCalled();
    });

    it('routes to an explicit slot id', async () => {
      const leftAdapter = makeFakeAdapter();
      const { state, invoke } = setup('node', null);
      const leftClient = makeFakeClient(leftAdapter);
      state.slots.set('left', { slotId: 'left', client: leftClient, live: {} });
      await invoke('device.send_raw', {
        bytes: 'AA',
        slot: 'left',
        confirm: true,
      });
      expect(leftAdapter.write).toHaveBeenCalledTimes(1);
      // Primary's adapter (null) is not exercised.
      expect(state.slots.get('primary')!.client.getAdapter).not.toHaveBeenCalled();
    });
  });
});
