// Integration test (VW-966): on `VOLTRA_ADAPTER=mock`, a weight set through
// `device.set_weight` is the load stored on the sets recorded after it.
//
// Unlike `full-mock-flow.test.ts`, which replaces the SDK with a hand-written
// fake, this drives the SDK's own mock device (`VoltraManager.forMock()`), so
// it covers what a lifter sees on the mock adapter end to end.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createClientConnection } from '../../client-connection.js';
import { loadConfig } from '../../config.js';
import { bootstrapState, type ServerState } from '../../state/server-state.js';

const NON_DEFAULT_WEIGHT_LBS = 60;

interface Harness {
  client: Client;
  state: ServerState;
  cleanup: () => Promise<void>;
}

async function buildHarness(): Promise<Harness> {
  const dbDir = mkdtempSync(join(tmpdir(), 'vmcp-mock-weight-'));
  const savedEnv = { ...process.env };
  process.env.VOLTRA_ADAPTER = 'mock';
  process.env.VMCP_DB_PATH = join(dbDir, 'mock-weight.sqlite');
  process.env.VMCP_SLOT_BINDINGS_PATH = join(dbDir, 'slot-bindings.json');
  process.env.VMCP_DASHBOARD_PORT = 'off';
  const state = await bootstrapState(loadConfig());
  process.env = savedEnv;

  const connection = createClientConnection();
  connection.activate(state);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'voltras-mcp-it', version: '0.0.1' }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), connection.server.connect(serverTransport)]);

  const cleanup = async (): Promise<void> => {
    await client.close();
    await connection.server.close();
    state.manager.dispose();
    await state.store.close();
    rmSync(dbDir, { recursive: true, force: true });
  };

  return { client, state, cleanup };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  const text = result.content[0]?.text ?? '{}';
  expect(result.isError, `${name} failed: ${text}`).toBeFalsy();
  return JSON.parse(text) as Record<string, unknown>;
}

async function connectFirstMockDevice(client: Client): Promise<void> {
  const scan = await call(client, 'device.scan');
  const [device] = scan.devices as Array<{ id: string }>;
  await call(client, 'device.connect', { deviceId: device?.id });
}

describe('mock adapter weight (integration)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('stores the weight set before the set as the load of the recorded set', async () => {
    await connectFirstMockDevice(h.client);
    await call(h.client, 'device.set_mode', { mode: 'WeightTraining' });
    await call(h.client, 'device.set_weight', { lbs: NON_DEFAULT_WEIGHT_LBS });
    await call(h.client, 'session.start', { exerciseId: 'cable-chest-press' });

    const { setId } = await call(h.client, 'set.start');
    await call(h.client, 'set.end');
    const stored = await call(h.client, 'set.get', { setId });

    expect(stored.weightLbs).toBe(NON_DEFAULT_WEIGHT_LBS);
  }, 30_000);
});
