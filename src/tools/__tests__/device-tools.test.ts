// Unit tests for `device.*` tools (Wave 3A, Task 10).
//
// Strategy: build a fake `VoltraManager` + `VoltraClient` shaped just for the
// surface that `registerDeviceTools` consumes. The MCP server is replaced
// with a minimal fake whose `tool()` records placeholder registrations so we
// can fish out the swapped-in real callbacks. This keeps the test free of
// the @voltras/node-sdk runtime (and its optional native peers).
//
// AC anchors:
// - AC-26: `device.get_state` reads from client.isConnected, connectionState,
//   settings, connectedDeviceId; output never carries a raw enum number.
// - EC-05: `device.set_mode` with `Idle` → INVALID_INPUT.
// - AC-14: no `noble`/`webbluetooth` imports in src/tools/.
// - Critic FIX #9 reflected here: `device.scan` passes a ScanOptions OBJECT
//   to `manager.scan`, never a bare number. The live SDK's `ScanOptions`
//   uses `timeout` (the briefing/critic prose said `timeoutMs`, which was a
//   typo against the actual SDK shape — see report.md deviation note); the
//   tests assert the actual SDK property.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Stub the SDK to keep test runs free of native peers. We need:
// - `TrainingMode` (enum object, both name→num and num→name) for Idle
//   filtering and forward/reverse mapping in the device-tools handler.
// - `VoltraSDKError` for the errors module's instanceof check.
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
  Rowing: 3,
  Damper: 4,
  CustomCurves: 6,
  Isokinetic: 7,
  Isometric: 8,
  // Reverse mapping (TS enum behaviour).
  0: 'Idle',
  1: 'WeightTraining',
  2: 'ResistanceBand',
  3: 'Rowing',
  4: 'Damper',
  6: 'CustomCurves',
  7: 'Isokinetic',
  8: 'Isometric',
} as const;

vi.mock('@voltras/node-sdk', () => ({
  TrainingMode: FakeTrainingMode,
  VoltraSDKError: FakeVoltraSDKError,
}));

const { registerDeviceTools } = await import('../device-tools.js');

// ── Fakes ────────────────────────────────────────────────────────────────

interface FakeSettings {
  weight: number;
  chains: number;
  inverseChains: number;
  eccentric: number;
  mode: number;
  battery: number | null;
}

interface FakeClient {
  isConnected: boolean;
  connectionState: 'disconnected' | 'connecting' | 'authenticating' | 'connected';
  connectedDeviceId: string | null;
  settings: FakeSettings;
  setAdapter: Mock<(adapter: unknown) => void>;
  connect: Mock<(device: unknown) => Promise<void>>;
  disconnect: Mock<() => Promise<void>>;
  setWeight: Mock<(lbs: number) => Promise<void>>;
  setMode: Mock<(mode: number) => Promise<void>>;
  setChains: Mock<(lbs: number) => Promise<void>>;
  setEccentric: Mock<(percent: number) => Promise<void>>;
}

interface FakeManager {
  devices: Array<{ id: string; name: string | null; rssi: number | null }>;
  scan: Mock<(opts?: { timeout?: number; filterVoltra?: boolean }) => Promise<unknown[]>>;
  connect: Mock<(device: unknown) => Promise<FakeClient>>;
  disconnect: Mock<(deviceId: string) => Promise<void>>;
  isConnected: Mock<(deviceId: string) => boolean>;
}

function makeFakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    isConnected: false,
    connectionState: 'disconnected',
    connectedDeviceId: null,
    settings: {
      weight: 5,
      chains: 0,
      inverseChains: 0,
      eccentric: 0,
      mode: FakeTrainingMode.Idle,
      battery: null,
    },
    setAdapter: vi.fn(() => undefined),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    setWeight: vi.fn(async () => undefined),
    setMode: vi.fn(async () => undefined),
    setChains: vi.fn(async () => undefined),
    setEccentric: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeFakeManager(): FakeManager {
  return {
    devices: [],
    scan: vi.fn(async () => []),
    connect: vi.fn(async () => makeFakeClient()),
    disconnect: vi.fn(async () => undefined),
    isConnected: vi.fn(() => false),
  };
}

// ── Fake McpServer + placeholder registry ────────────────────────────────

interface RecordedTool {
  callback: (args: unknown, extra?: unknown) => Promise<unknown>;
  update: Mock<
    (updates: { callback?: (args: unknown, extra?: unknown) => Promise<unknown> }) => void
  >;
}

interface FakeServer {
  tool: Mock<(name: string, ...rest: unknown[]) => RecordedTool>;
}

function makeFakeServer(): FakeServer {
  const tool = vi.fn((_name: string, ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as RecordedTool['callback'];
    const reg: RecordedTool = {
      callback: cb,
      update: vi.fn((updates) => {
        if (updates.callback) {
          reg.callback = updates.callback;
        }
      }),
    };
    return reg;
  });
  return { tool };
}

function buildPlaceholderMap(server: FakeServer, names: string[]): Map<string, RecordedTool> {
  const placeholders = new Map<string, RecordedTool>();
  const stub = (): unknown => ({
    content: [{ type: 'text', text: '{"code":"STARTING"}' }],
    isError: true,
  });
  for (const name of names) {
    placeholders.set(name, server.tool(name, stub));
  }
  return placeholders;
}

const DEVICE_TOOL_NAMES = [
  'device.scan',
  'device.connect',
  'device.disconnect',
  'device.set_weight',
  'device.set_mode',
  'device.set_chains',
  'device.set_eccentric',
  'device.get_state',
] as const;

interface State {
  manager: FakeManager;
  client: FakeClient;
}

function makeState(): State {
  return {
    manager: makeFakeManager(),
    client: makeFakeClient(),
  };
}

// Helper: invoke a registered tool and parse the result envelope.
async function invoke(
  reg: RecordedTool,
  args: unknown,
): Promise<{ isError?: boolean; payload: Record<string, unknown> }> {
  const result = (await reg.callback(args)) as {
    isError?: boolean;
    content: Array<{ type: 'text'; text: string }>;
  };
  return {
    isError: result.isError,
    payload: JSON.parse(result.content[0].text) as Record<string, unknown>,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('registerDeviceTools', () => {
  let state: State;
  let server: FakeServer;
  let placeholders: Map<string, RecordedTool>;

  beforeEach(() => {
    state = makeState();
    server = makeFakeServer();
    placeholders = buildPlaceholderMap(server, [...DEVICE_TOOL_NAMES]);
    registerDeviceTools(
      server as unknown as Parameters<typeof registerDeviceTools>[0],
      state as unknown as Parameters<typeof registerDeviceTools>[1],
      placeholders as unknown as Parameters<typeof registerDeviceTools>[2],
    );
  });

  it('swaps in real handlers via placeholder.update() for every device tool', () => {
    for (const name of DEVICE_TOOL_NAMES) {
      const reg = placeholders.get(name);
      expect(reg, `placeholder for ${name}`).toBeDefined();
      expect(reg?.update).toHaveBeenCalledWith(
        expect.objectContaining({ callback: expect.any(Function) }),
      );
    }
  });

  describe('device.scan', () => {
    it('passes the timeout to manager.scan as a ScanOptions object (critic FIX #9)', async () => {
      state.manager.scan.mockResolvedValueOnce([{ id: 'V-1', name: 'Voltra-1', rssi: -45 }]);
      const reg = placeholders.get('device.scan')!;
      const { isError, payload } = await invoke(reg, { timeoutMs: 2000 });
      expect(isError).toBeUndefined();
      expect(state.manager.scan).toHaveBeenCalledTimes(1);
      const opts = state.manager.scan.mock.calls[0][0];
      // Object shape — neither a bare number nor undefined.
      expect(typeof opts).toBe('object');
      expect(opts).not.toBeNull();
      expect((opts as { timeout?: number }).timeout).toBe(2000);
      // Returned device list serialized as-is (id/name/rssi from scan).
      expect(payload).toEqual({
        devices: [{ id: 'V-1', name: 'Voltra-1', rssi: -45 }],
      });
    });

    it('defaults timeout to 10000ms when input omits timeoutMs', async () => {
      state.manager.scan.mockResolvedValueOnce([]);
      const reg = placeholders.get('device.scan')!;
      await invoke(reg, {});
      const opts = state.manager.scan.mock.calls[0][0];
      expect((opts as { timeout?: number }).timeout).toBe(10000);
    });

    it('rejects timeoutMs below the 1000ms floor with INVALID_INPUT', async () => {
      const reg = placeholders.get('device.scan')!;
      const { isError, payload } = await invoke(reg, { timeoutMs: 500 });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(state.manager.scan).not.toHaveBeenCalled();
    });
  });

  describe('device.connect', () => {
    it('returns ok:true on success after locating the device by id from manager.devices', async () => {
      state.manager.devices = [{ id: 'V-1', name: 'Voltra-1', rssi: -50 }];
      const connected = makeFakeClient({
        isConnected: true,
        connectionState: 'connected',
        connectedDeviceId: 'V-1',
      });
      state.manager.connect.mockResolvedValueOnce(connected);
      const reg = placeholders.get('device.connect')!;
      const { isError, payload } = await invoke(reg, { deviceId: 'V-1' });
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true, deviceId: 'V-1' });
      // Handler must hand the DiscoveredDevice (not a bare string) to manager.connect.
      expect(state.manager.connect).toHaveBeenCalledWith({
        id: 'V-1',
        name: 'Voltra-1',
        rssi: -50,
      });
    });

    it('returns DEVICE_NOT_FOUND when the deviceId is absent from the last scan', async () => {
      state.manager.devices = [{ id: 'V-2', name: null, rssi: null }];
      const reg = placeholders.get('device.connect')!;
      const { isError, payload } = await invoke(reg, { deviceId: 'V-1' });
      expect(isError).toBe(true);
      expect(payload.code).toBe('DEVICE_NOT_FOUND');
      expect(state.manager.connect).not.toHaveBeenCalled();
    });

    it('returns ALREADY_CONNECTED when state.client is already connected (EC-08)', async () => {
      state.client.isConnected = true;
      state.client.connectedDeviceId = 'V-existing';
      state.manager.devices = [{ id: 'V-1', name: null, rssi: null }];
      const reg = placeholders.get('device.connect')!;
      const { isError, payload } = await invoke(reg, { deviceId: 'V-1' });
      expect(isError).toBe(true);
      expect(payload.code).toBe('ALREADY_CONNECTED');
      expect(state.manager.connect).not.toHaveBeenCalled();
    });

    it('maps a thrown VoltraSDKError to its code (CONNECTION_LOST)', async () => {
      state.manager.devices = [{ id: 'V-1', name: null, rssi: null }];
      state.manager.connect.mockRejectedValueOnce(
        new FakeVoltraSDKError('lost mid-handshake', 'CONNECTION_LOST'),
      );
      const reg = placeholders.get('device.connect')!;
      const { isError, payload } = await invoke(reg, { deviceId: 'V-1' });
      expect(isError).toBe(true);
      expect(payload.code).toBe('CONNECTION_LOST');
    });
  });

  describe('device.disconnect', () => {
    it('calls manager.disconnect for the active deviceId and returns ok:true', async () => {
      state.client.isConnected = true;
      state.client.connectedDeviceId = 'V-1';
      const reg = placeholders.get('device.disconnect')!;
      const { isError, payload } = await invoke(reg, {});
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(state.manager.disconnect).toHaveBeenCalledWith('V-1');
    });

    it('is a graceful no-op when nothing is connected', async () => {
      const reg = placeholders.get('device.disconnect')!;
      const { isError, payload } = await invoke(reg, {});
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(state.manager.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('device.set_weight', () => {
    it('forwards lbs to client.setWeight and returns ok:true', async () => {
      const reg = placeholders.get('device.set_weight')!;
      const { isError, payload } = await invoke(reg, { lbs: 50 });
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(state.client.setWeight).toHaveBeenCalledWith(50);
    });

    it('rejects out-of-range lbs with INVALID_INPUT', async () => {
      const reg = placeholders.get('device.set_weight')!;
      const { isError, payload } = await invoke(reg, { lbs: 999 });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(state.client.setWeight).not.toHaveBeenCalled();
    });
  });

  describe('device.set_mode', () => {
    it('maps the enum NAME back to the SDK numeric value before calling setMode', async () => {
      const reg = placeholders.get('device.set_mode')!;
      const { isError, payload } = await invoke(reg, { mode: 'WeightTraining' });
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(state.client.setMode).toHaveBeenCalledWith(FakeTrainingMode.WeightTraining);
    });

    it('rejects "Idle" with INVALID_INPUT (EC-05) — Idle is not user-selectable', async () => {
      const reg = placeholders.get('device.set_mode')!;
      const { isError, payload } = await invoke(reg, { mode: 'Idle' });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(state.client.setMode).not.toHaveBeenCalled();
    });

    it('rejects an unknown mode string with INVALID_INPUT', async () => {
      const reg = placeholders.get('device.set_mode')!;
      const { isError, payload } = await invoke(reg, { mode: 'TimeMachine' });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
    });
  });

  describe('device.set_chains', () => {
    it('forwards lbs to client.setChains', async () => {
      const reg = placeholders.get('device.set_chains')!;
      const { isError, payload } = await invoke(reg, { lbs: 25 });
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(state.client.setChains).toHaveBeenCalledWith(25);
    });
  });

  describe('device.set_eccentric', () => {
    it('forwards percent to client.setEccentric', async () => {
      const reg = placeholders.get('device.set_eccentric')!;
      const { isError, payload } = await invoke(reg, { percent: -50 });
      expect(isError).toBeUndefined();
      expect(payload).toEqual({ ok: true });
      expect(state.client.setEccentric).toHaveBeenCalledWith(-50);
    });

    it('rejects percent outside [-195, 195] with INVALID_INPUT', async () => {
      const reg = placeholders.get('device.set_eccentric')!;
      const { isError, payload } = await invoke(reg, { percent: 300 });
      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
    });
  });

  describe('device.get_state (AC-26)', () => {
    it('composes the response from individual VoltraClient getters with a string trainingMode', async () => {
      // Track which getters were read to satisfy AC-26's spy assertion.
      const reads: string[] = [];
      const tracked = {
        ...state.client,
        get isConnected() {
          reads.push('isConnected');
          return true;
        },
        get connectionState() {
          reads.push('connectionState');
          return 'connected' as const;
        },
        get connectedDeviceId() {
          reads.push('connectedDeviceId');
          return 'V-1';
        },
        get settings() {
          reads.push('settings');
          return {
            weight: 75,
            chains: 0,
            inverseChains: 0,
            eccentric: 0,
            mode: FakeTrainingMode.WeightTraining,
            battery: 80,
          };
        },
      };
      // Re-register with the tracked client so the closure sees it.
      state.client = tracked as unknown as FakeClient;
      const localServer = makeFakeServer();
      const localPlaceholders = buildPlaceholderMap(localServer, [...DEVICE_TOOL_NAMES]);
      registerDeviceTools(
        localServer as unknown as Parameters<typeof registerDeviceTools>[0],
        state as unknown as Parameters<typeof registerDeviceTools>[1],
        localPlaceholders as unknown as Parameters<typeof registerDeviceTools>[2],
      );

      const reg = localPlaceholders.get('device.get_state')!;
      const { isError, payload } = await invoke(reg, {});
      expect(isError).toBeUndefined();
      expect(payload).toMatchObject({
        connected: true,
        connectionState: 'connected',
        deviceId: 'V-1',
        weightLbs: 75,
        trainingMode: 'WeightTraining',
        batteryPercent: 80,
      });
      // No raw enum number leaks into trainingMode.
      expect(typeof payload.trainingMode).toBe('string');
      expect(payload.trainingMode).not.toBe(1);
      // Reads from the four documented getters.
      expect(reads).toContain('isConnected');
      expect(reads).toContain('connectionState');
      expect(reads).toContain('connectedDeviceId');
      expect(reads).toContain('settings');
      // No `rssi` field leaks (no SDK source for connected RSSI).
      expect(payload.rssi).toBeUndefined();
    });

    it('coerces battery=null to absent batteryPercent (FIX #6)', async () => {
      state.client.isConnected = true;
      state.client.connectionState = 'connected';
      state.client.connectedDeviceId = 'V-2';
      state.client.settings = {
        weight: 5,
        chains: 0,
        inverseChains: 0,
        eccentric: 0,
        mode: FakeTrainingMode.WeightTraining,
        battery: null,
      };
      const reg = placeholders.get('device.get_state')!;
      const { isError, payload } = await invoke(reg, {});
      expect(isError).toBeUndefined();
      // Output schema disallows null. Field must be absent (not null).
      expect(payload).not.toHaveProperty('batteryPercent');
      expect(payload.batteryPercent).toBeUndefined();
    });

    it('reports disconnected without crashing when no device is connected', async () => {
      const reg = placeholders.get('device.get_state')!;
      const { isError, payload } = await invoke(reg, {});
      expect(isError).toBeUndefined();
      expect(payload.connected).toBe(false);
      expect(payload.connectionState).toBe('disconnected');
      expect(payload.deviceId).toBeUndefined();
    });
  });

  describe('AC-14: BLE access only via @voltras/node-sdk', () => {
    it('contains zero references to noble or webbluetooth across src/tools/', () => {
      // Walk src/tools/ relative to this test file.
      const here = dirname(fileURLToPath(import.meta.url));
      const toolsDir = resolve(here, '..');
      const offending: string[] = [];
      const banned = /\b(noble|webbluetooth)\b/;
      for (const file of walkTs(toolsDir)) {
        const text = readFileSync(file, 'utf8');
        if (banned.test(text)) {
          offending.push(file);
        }
      }
      expect(offending).toEqual([]);
    });
  });
});

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkTs(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}
