// Integration test: NDA structural redaction sweep (Wave 4, Task 16).
//
// Drives a representative session through the full MCP transport, captures
// every tool result and resource read into a single JSON buffer, then runs
// the four AC-11 structural checks defined in `acceptance-criteria.md`:
//   (a) no JSON array contains more than 8 number elements;
//   (b) no JSON field is named `frame`, `payload`, `bytes`, or `raw`;
//   (c) no string longer than 100 characters matches the base64 pattern
//       `/^[A-Za-z0-9+/]+=*$/`;
//   (d) the hex-byte pattern `0x[0-9a-fA-F]{4,}` does not appear anywhere.
//
// The buffer covers BOTH structured payload text AND any string fragment
// the SDK might serialize on the wire — every tool returns a
// `{ content: [{ type: 'text', text: JSON.stringify(...) }] }` envelope, so
// joining the captured texts is sufficient.
//
// ── Architectural deviations exercised by this test ───────────────────────
// Same as `full-mock-flow.test.ts`: the SDK is mocked at the seam, the
// placeholder schema is set to passthrough, and reps are driven directly
// into `LiveState` because the real bridge cannot fire from the mock
// adapter (two-client divergence).

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
  onPerRep(): () => void {
    return () => undefined;
  }
  onInProgress(): () => void {
    return () => undefined;
  }
  onSummary(): () => void {
    return () => undefined;
  }
  onSettingsUpdate(): () => void {
    return () => undefined;
  }
  onConnectionStateChange(): () => void {
    return () => undefined;
  }
  onFrame(): () => void {
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
  readonly devices = [{ id: 'mock-voltra-001', name: 'VTR-Mock', rssi: -50 }];
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
    0: 'Idle',
    1: 'WeightTraining',
  },
  TrainingModeNames: { 0: 'Idle', 1: 'WeightTraining' },
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
const { registerMetricsTools } = await import('../../tools/metrics-tools.js');
const { registerExerciseTools } = await import('../../tools/exercise-tools.js');
const { registerMockTools } = await import('../../tools/mock-tools.js');
const { registerDeviceResource } = await import('../../resources/device-resource.js');
const { registerSessionResource } = await import('../../resources/session-resource.js');
const { registerSetResource } = await import('../../resources/set-resource.js');

import type { ServerState } from '../../state/server-state.js';
import type { ChannelPublisher } from '../../state/channel-publisher.js';
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

interface Harness {
  client: Client;
  state: ServerState;
  cleanup: () => Promise<void>;
}

async function buildHarness(): Promise<Harness> {
  const dbDir = mkdtempSync(join(tmpdir(), 'vmcp-it-'));
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
  const client = new Client({ name: 'voltras-mcp-it', version: '0.0.1' }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const state = await bootstrapState({ adapter: 'mock', dbPath, logLevel: 'error' });
  stateBox.value = state;
  // No-op channel publisher: integration tests don't observe claude/channel
  // pushes, but the bridge calls `state.channels.forSlot(slotId)` so the
  // publisher must implement the full interface.
  const channels: ChannelPublisher = {
    publish: () => undefined,
    forSlot: () => channels,
  };
  state.channels = channels;
  state.server = server;
  wireEventBridge(state);

  registerDeviceTools(server, state, placeholders);
  registerSessionTools(server, state, placeholders);
  registerSetTools(server, state, placeholders);
  registerMetricsTools(server, state, placeholders);
  registerExerciseTools(server, state, placeholders);
  registerMockTools(server, state, placeholders);

  const cleanup = async (): Promise<void> => {
    await client.close();
    await server.close();
    state.manager.dispose();
    await state.store.close();
    rmSync(dbDir, { recursive: true, force: true });
  };

  return { client, state, cleanup };
}

interface ToolCallEnvelope {
  isError?: boolean;
  payload: unknown;
  text: string;
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
  const text = result.content[0]?.text ?? '';
  return {
    isError: result.isError,
    payload: text ? (JSON.parse(text) as unknown) : undefined,
    text,
  };
}

async function readResourceText(client: Client, uri: string): Promise<string> {
  const res = await client.readResource({ uri });
  const first = res.contents?.[0];
  if (!first || typeof first.text !== 'string') {
    throw new Error(`expected text content at ${uri}`);
  }
  return first.text;
}

function syntheticRep(repNumber: number): Rep {
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
    peakVelocity: 0.5 + repNumber * 0.01,
    peakForce: 100,
    peakLoad: 100,
  };
  return {
    repNumber,
    concentric: { ...emptyPhase },
    eccentric: { ...emptyPhase, peakVelocity: 0.3 + repNumber * 0.01 },
  };
}

// AC-11 (a): walk every parsed JSON value, fail if any array has > 8
// elements that are ALL numbers in the byte range 0..255 (which would
// indicate a leaked frame buffer). Per the briefing's tightening clause:
// "If analytics output legitimately returns >8-element numeric arrays,
// tighten check (a) to byte-range arrays only (0-255 ints)."
function findLeakedByteArrays(value: unknown, path = '$'): string[] {
  const violations: string[] = [];
  if (Array.isArray(value)) {
    if (
      value.length > 8 &&
      value.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255)
    ) {
      violations.push(`${path} (length=${value.length}, all 0-255 ints)`);
    }
    value.forEach((item, idx) => {
      violations.push(...findLeakedByteArrays(item, `${path}[${idx}]`));
    });
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      violations.push(...findLeakedByteArrays(child, `${path}.${key}`));
    }
  }
  return violations;
}

// AC-11 (b): banned object key names anywhere in a parsed value tree.
function findBannedFieldNames(value: unknown, path = '$'): string[] {
  const banned = new Set(['frame', 'payload', 'bytes', 'raw']);
  const violations: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, idx) => {
      violations.push(...findBannedFieldNames(item, `${path}[${idx}]`));
    });
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (banned.has(key)) {
        violations.push(`${path}.${key}`);
      }
      violations.push(...findBannedFieldNames(child, `${path}.${key}`));
    }
  }
  return violations;
}

describe('VMCP NDA structural redaction sweep (integration, AC-11)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await buildHarness();
  });

  afterAll(async () => {
    await h.cleanup();
  });

  it('produces no protocol-byte leakage across a representative session', async () => {
    // Capture every JSON-text produced by the server during a representative
    // session into a flat array so check (c)/(d) can scan strings and
    // checks (a)/(b) can walk parsed structures.
    const captured: { source: string; text: string; parsed: unknown }[] = [];

    function recordCall(source: string, env: ToolCallEnvelope): void {
      captured.push({ source, text: env.text, parsed: env.payload });
    }
    async function recordResource(uri: string): Promise<void> {
      const text = await readResourceText(h.client, uri);
      captured.push({ source: `resource:${uri}`, text, parsed: JSON.parse(text) });
    }

    // ── Drive a representative session ──────────────────────────────────
    recordCall('device.scan', await call(h.client, 'device.scan', { timeoutMs: 1000 }));
    const deviceId =
      (captured[0].parsed as { devices: Array<{ id: string }> }).devices[0]?.id ?? '';

    recordCall('device.connect', await call(h.client, 'device.connect', { deviceId }));
    getSlot(h.state).live.applySettings({
      connected: true,
      deviceId,
      weightLbs: 100,
      trainingMode: 'WeightTraining',
    });
    recordCall('device.get_state', await call(h.client, 'device.get_state'));
    await recordResource('voltra://device/current');

    recordCall(
      'session.start',
      await call(h.client, 'session.start', { exerciseName: 'Bench Press' }),
    );
    const sessionId = (captured[captured.length - 1].parsed as { sessionId: string }).sessionId;
    recordCall('set.start', await call(h.client, 'set.start'));
    const setId = (captured[captured.length - 1].parsed as { setId: string }).setId;

    for (let i = 0; i < 5; i += 1) {
      getSlot(h.state).live.appendRep(syntheticRep(i + 1));
      recordCall(`set.live_metrics#${i}`, await call(h.client, 'set.live_metrics'));
      await recordResource('voltra://set/active');
    }

    recordCall('set.end', await call(h.client, 'set.end'));
    recordCall('session.end', await call(h.client, 'session.end'));
    recordCall('session.get', await call(h.client, 'session.get', { id: sessionId }));
    recordCall(
      'metrics.compute:vbt.set',
      await call(h.client, 'metrics.compute', { pipeline: 'vbt.set', setId }),
    );

    // ── Build the unified buffer and run the four AC-11 checks ─────────
    const buffer = captured.map((c) => c.text).join('\n');

    // (a) No JSON array > 8 elements that are all 0..255 ints (byte range).
    const byteViolations = captured.flatMap((c) => findLeakedByteArrays(c.parsed, c.source));
    expect(byteViolations, 'AC-11 (a) byte-array leak').toEqual([]);

    // (b) No banned field names.
    const bannedViolations = captured.flatMap((c) => findBannedFieldNames(c.parsed, c.source));
    expect(bannedViolations, 'AC-11 (b) banned field names').toEqual([]);

    // (c) No string > 100 chars matching base64 pattern.
    const base64Re = /^[A-Za-z0-9+/]+=*$/;
    const longBase64 = buffer
      .split(/[\s",:\\]+/)
      .filter((tok) => tok.length > 100 && base64Re.test(tok));
    expect(longBase64, 'AC-11 (c) long base64 tokens').toEqual([]);

    // (d) No 0x[0-9a-fA-F]{4,} pattern anywhere in the buffer.
    const hexBytes = buffer.match(/0x[0-9a-fA-F]{4,}/g) ?? [];
    expect(hexBytes, 'AC-11 (d) hex-byte literals').toEqual([]);
  });
});
