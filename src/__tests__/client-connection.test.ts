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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createClientConnection,
  mintClientId,
  resetClientIdSequence,
} from '../client-connection.js';
import { loadConfig } from '../config.js';
import { bootstrapState, type ServerState } from '../state/server-state.js';
import { CORE_TOOL_NAMES } from '../tool-registry.js';

let dbDir: string;
let state: ServerState;
const savedEnv = { ...process.env };

beforeEach(async () => {
  resetClientIdSequence();
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

  it('registers the full tool surface on both, sharing one state', () => {
    const a = createClientConnection();
    const b = createClientConnection();

    a.activate(state);
    b.activate(state);

    for (const name of CORE_TOOL_NAMES) {
      expect(a.placeholders.has(name), `connection A missing ${name}`).toBe(true);
      expect(b.placeholders.has(name), `connection B missing ${name}`).toBe(true);
    }
    // Distinct RegisteredTool handles per connection — each server owns its
    // own registrations even though the state behind them is one object.
    expect(a.placeholders.get('set.start')).not.toBe(b.placeholders.get('set.start'));
  });

  it('tracks both connections in state.clients', () => {
    const a = createClientConnection();
    const b = createClientConnection();
    state.clients.set(a.clientId, a);
    state.clients.set(b.clientId, b);

    expect(state.clients.size).toBe(2);
    expect(state.clients.get(a.clientId)).toBe(a);
    expect(state.clients.get(b.clientId)).toBe(b);
  });

  it('starts with no clients registered until one attaches', async () => {
    const fresh = await bootstrapState(loadConfig());
    expect(fresh.clients.size).toBe(0);
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
