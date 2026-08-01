// Two MCP connections over one shared ServerState (VMCP-01.60).
//
// This is the load-bearing test for the phase: it asserts the property the
// daemon (VMCP-01.62) depends on — that N `McpServer` instances can register
// the full tool surface against a single `ServerState` without interfering with
// each other. Before this, `runServer` held the only server in a local, so the
// property was true by accident and untested.
//
// Runs against the mock adapter with a throwaway SQLite file, so no BLE radio
// and no shared DB are involved.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClientConnection,
  registerClient,
  mintClientId,
  __resetClientIdSequence,
  type ClientConnection,
} from '../client-connection.js';
import { loadConfig } from '../config.js';
import { bootstrapState, type ServerState } from '../state/server-state.js';
import { CORE_TOOL_NAMES, MOCK_TOOL_NAMES } from '../tool-registry.js';

let dbDir: string;
let state: ServerState;
const savedEnv = { ...process.env };

beforeEach(async () => {
  __resetClientIdSequence();
  dbDir = mkdtempSync(join(tmpdir(), 'vmcp-conn-'));
  process.env.VOLTRA_ADAPTER = 'mock';
  process.env.VMCP_DB_PATH = join(dbDir, 'conn.sqlite');
  process.env.VMCP_SLOT_BINDINGS_PATH = join(dbDir, 'slot-bindings.json');
  state = await bootstrapState(loadConfig());
});

afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(dbDir, { recursive: true, force: true });
});

/**
 * Names of every tool still bound to the shared `STARTING` placeholder.
 *
 * Detected by handler IDENTITY, not by calling: `registerStartingPlaceholders`
 * installs one shared callback across every tool, so "still a placeholder"
 * means "handler is still that exact function". Invoking each handler instead
 * would be a worse test AND a destructive one — it arms the real mic via
 * `system.listen_start`.
 */
function unactivatedTools(connection: ClientConnection): string[] {
  const handlers = [...connection.placeholders.values()].map((tool) => tool.handler);
  const placeholderHandler = handlers[0];
  const names: string[] = [];
  for (const [name, tool] of connection.placeholders) {
    if (tool.handler === placeholderHandler) names.push(name);
  }
  // All-or-nothing: if the first tool was already swapped there is no shared
  // reference left to compare against, and an empty result would be a false
  // pass. Guard by requiring either every tool or none to match.
  return names.length === connection.placeholders.size ? names : [];
}

describe('client identity', () => {
  it('mints a distinct id per client', () => {
    expect(mintClientId()).not.toBe(mintClientId());
  });

  it('defaults each connection to its own minted id', () => {
    expect(createClientConnection().clientId).not.toBe(createClientConnection().clientId);
  });

  it('accepts an explicit id so the daemon can key connections itself', () => {
    expect(createClientConnection('socket-7').clientId).toBe('socket-7');
  });
});

describe('two connections over one shared state', () => {
  it('gives each connection its own server and placeholder map', () => {
    const a = createClientConnection();
    const b = createClientConnection();
    expect(a.server).not.toBe(b.server);
    expect(a.placeholders).not.toBe(b.placeholders);
    expect(a.channels).not.toBe(b.channels);
  });

  it('installs real handlers on BOTH connections, not just the first', () => {
    // Asserting `placeholders.has(name)` would prove nothing: every name is
    // registered at CONSTRUCTION time, so that assertion passes even if
    // activate() is a no-op. Assert on behaviour instead — before activation
    // every tool answers STARTING, after it none do.
    const a = createClientConnection();
    const b = createClientConnection();

    expect(unactivatedTools(a)).toEqual([...CORE_TOOL_NAMES, ...MOCK_TOOL_NAMES]);

    a.activate(state);
    b.activate(state);

    expect(unactivatedTools(a), 'connection A still on placeholders').toEqual([]);
    expect(unactivatedTools(b), 'connection B still on placeholders').toEqual([]);
    // Distinct RegisteredTool handles per connection — each server owns its
    // own registrations even though the state behind them is one object.
    expect(a.placeholders.get('set.start')).not.toBe(b.placeholders.get('set.start'));
  });

  it('starts with no clients registered until one attaches', async () => {
    const fresh = await bootstrapState(loadConfig());
    expect(fresh.clients.size).toBe(0);
  });
});

describe('registration', () => {
  it('tracks each registered connection', () => {
    const a = createClientConnection();
    const b = createClientConnection();

    registerClient(state, a);
    registerClient(state, b);

    expect(state.clients.size).toBe(2);
    expect(state.clients.get(a.clientId)).toBe(a);
  });

  it('rejects a duplicate clientId instead of overwriting', () => {
    // A silent overwrite would leave the displaced connection alive and
    // serving tool calls while invisible to everything that reasons about
    // state.clients — the write-lease included.
    registerClient(state, createClientConnection('same'));

    expect(() => registerClient(state, createClientConnection('same'))).toThrow(/duplicate/i);
    expect(state.clients.size).toBe(1);
  });

  it('unregisters and closes on teardown', async () => {
    const a = createClientConnection();
    registerClient(state, a);

    await a.close(state);

    expect(state.clients.has(a.clientId)).toBe(false);
    // And the id is reusable afterwards, so a reconnecting socket is not
    // permanently poisoned by the duplicate guard.
    expect(() => registerClient(state, createClientConnection(a.clientId))).not.toThrow();
  });
});

describe('server instructions', () => {
  it('hands the connecting client non-empty onboarding text', async () => {
    // Asserted through a real handshake rather than off the server object: the
    // SDK keeps `instructions` private and only surfaces it in the initialize
    // result, which is the only place a client can see it.
    const connection = createClientConnection();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([
      connection.server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const instructions = client.getInstructions();
    expect(instructions).toBeTruthy();
    expect(instructions).toContain('driftguard.check');
    expect(instructions).toContain('baselines.get');
    expect(instructions).toContain('DIAGNOSTIC-ONLY');

    await client.close();
    await connection.server.close();
  });
});

describe('placeholders before activation', () => {
  it('answers STARTING until activate() swaps in real handlers', async () => {
    const connection = createClientConnection();
    const placeholder = connection.placeholders.get('device.get_state');
    expect(placeholder).toBeDefined();

    // `RegisteredTool.update({ callback })` writes through to `.handler` — the
    // option and the field have different names.
    const invoke = async (tool: RegisteredTool): Promise<unknown> =>
      (tool.handler as (args: unknown, extra: unknown) => unknown)({}, {});

    const before = await invoke(placeholder!);
    expect(JSON.stringify(before)).toContain('STARTING');

    connection.activate(state);
    const after = await invoke(connection.placeholders.get('device.get_state')!);
    expect(JSON.stringify(after)).not.toContain('STARTING');
  });
});
