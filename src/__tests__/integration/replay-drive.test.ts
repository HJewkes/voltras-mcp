// Integration test for the replay driver (VW-256): a capture-file JSONL
// carrying raw telemetry, played back through the SDK's real
// `ReplayBLEAdapter` + `loadCaptureFrames` (from `@voltras/node-sdk/testing`,
// the exact pair `scripts/replay-preload.mjs` wires into the dashboard
// driver), into the real event-bridge/LiveState pipeline over a real MCP
// transport. Confirms the recorder's `{ type: 'frame_in', ts, hex }` schema
// needs no adapter shim: `loadCaptureFrames` reads it directly.
//
// Unlike `full-mock-flow.test.ts`, the SDK is NOT mocked here — this test
// exercises the real `@voltras/node-sdk` package end to end (that package now
// resolves cleanly under vitest; the historical `vi.mock` workaround in the
// sibling integration tests predates the SDK version this repo now pins).

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VoltraManager } from '@voltras/node-sdk';
import { ReplayBLEAdapter, loadCaptureFrames } from '@voltras/node-sdk/testing';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { bootstrapState, type ServerState } from '../../state/server-state.js';
import { wireEventBridge } from '../../state/event-bridge.js';
import { errorResult, type ToolResult } from '../../tools/helpers.js';
import { registerDeviceTools } from '../../tools/device-tools.js';
import { registerSessionTools } from '../../tools/session-tools.js';
import { registerSetTools } from '../../tools/set-tools.js';
import type { ChannelPublisher } from '../../state/channel-publisher.js';
import { buildSyntheticReplayCapture } from '../fixtures/synthetic-replay-capture.js';

const TOOL_NAMES = [
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
  'session.checkin',
  'session.set_exercise',
  'session.set_lifter',
  'session.list',
  'session.get',
  'set.start',
  'set.end',
  'set.live_metrics',
  'set.update',
  'set.get',
] as const;

interface Harness {
  client: Client;
  state: ServerState;
  cleanup: () => Promise<void>;
}

/** Same bootstrap order as `runServer` / `full-mock-flow.test.ts`, trimmed to device/session/set. */
async function buildHarness(): Promise<Harness> {
  const dbDir = mkdtempSync(join(tmpdir(), 'vmcp-replay-it-'));
  const dbPath = join(dbDir, 'replay.sqlite');

  const server = new McpServer(
    { name: 'voltras-mcp', version: '0.1.0' },
    { capabilities: { tools: {}, resources: { subscribe: true } } },
  );

  const startingResult = (): ToolResult =>
    errorResult({ code: 'STARTING', message: 'Server is initializing — try again in a moment.' });
  const placeholders = new Map<string, RegisteredTool>();
  for (const name of TOOL_NAMES) {
    placeholders.set(
      name,
      server.registerTool(name, { inputSchema: z.object({}).passthrough() }, () =>
        startingResult(),
      ),
    );
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'voltras-mcp-replay-it', version: '0.0.1' },
    { capabilities: {} },
  );
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const state = await bootstrapState({ adapter: 'mock', dbPath, logLevel: 'error' });
  const channels: ChannelPublisher = { publish: () => undefined, forSlot: () => channels };
  state.channels = channels;
  state.server = server;
  wireEventBridge(state);

  registerDeviceTools(server, state, placeholders);
  registerSessionTools(server, state, placeholders);
  registerSetTools(server, state, placeholders);

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('replay driver (VW-256)', () => {
  const originalForMock = VoltraManager.forMock;

  afterEach(() => {
    VoltraManager.forMock = originalForMock;
  });

  // Explicit budget above the ~550 ms nominal wait below (VW-285): under CI load the
  // default 5 s timeout has been hit even though that wait is real but short.
  it(
    'replays a synthetic capture through the real pipeline into a persisted set',
    { timeout: 20_000 },
    async () => {
      const REP_COUNT = 3;
      const PLAYBACK_SPEED = 40;
      const jsonl = buildSyntheticReplayCapture(REP_COUNT);
      const skips: unknown[] = [];
      const frames = loadCaptureFrames(jsonl, { onSkip: (skip) => skips.push(skip) });
      expect(skips).toEqual([]);
      expect(frames.length).toBe(REP_COUNT * 8);

      // Exactly what `scripts/replay-preload.mjs` does to the real MCP server
      // process: swap the mock manager's adapter for a replay of loaded frames.
      // `autoStart: false` because playback has to start once a SET is open to
      // receive samples, not the instant the device connects — the driver
      // triggers it explicitly (here, via a captured handle; over there, via
      // the preload's loopback `/play` route) right after `set.start`.
      let adapter: ReplayBLEAdapter | undefined;
      VoltraManager.forMock = (): VoltraManager =>
        new VoltraManager({
          platform: 'mock',
          adapterFactory: () => {
            adapter = new ReplayBLEAdapter({
              frames,
              playbackSpeed: PLAYBACK_SPEED,
              autoStart: false,
            });
            return adapter;
          },
        });

      const h = await buildHarness();
      try {
        const scan = await call(h.client, 'device.scan', {});
        expect(scan.isError).toBeUndefined();
        const deviceId = (scan.payload.devices as Array<{ id: string }>)[0]?.id;
        expect(typeof deviceId).toBe('string');

        const connect = await call(h.client, 'device.connect', { deviceId });
        expect(connect.isError).toBeUndefined();

        const sessionStart = await call(h.client, 'session.start', { exerciseName: 'Bench Press' });
        expect(sessionStart.isError).toBeUndefined();

        const setStart = await call(h.client, 'set.start');
        expect(setStart.isError).toBeUndefined();
        const setId = setStart.payload.setId as string;

        adapter?.play();
        // Let the replay drain: the last frame lands at `frames.at(-1).timestamp`
        // ms of capture time, compressed by `PLAYBACK_SPEED`.
        const lastTs = frames.at(-1)?.timestamp ?? 0;
        await sleep(lastTs / PLAYBACK_SPEED + 500);

        const setEnd = await call(h.client, 'set.end');
        expect(setEnd.isError).toBeUndefined();
        expect(setEnd.payload).toEqual({ ok: true, reps: REP_COUNT });

        const persisted = await h.state.store.getSet(setId);
        expect(persisted?.reps.length).toBe(REP_COUNT);

        const sessionEnd = await call(h.client, 'session.end');
        expect(sessionEnd.isError).toBeUndefined();

        // Disconnect while the server transport is still open, so the SDK's
        // async connection-state notification has somewhere to land — closing
        // the transport first turns that notification into an unhandled
        // rejection (`Server.notification: Not connected`).
        await call(h.client, 'device.disconnect');
      } finally {
        await h.cleanup();
      }
    },
  );
});
