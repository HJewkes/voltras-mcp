// Every write-classified MCP call leaves one audit row (VW-892).
//
// Mock adapter + throwaway SQLite, driven through two real connections so the
// lease guard sits under the audit wrap exactly as it does in production.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetClientIdSequence,
  createClientConnection,
  type ClientConnection,
} from '../../client-connection.js';
import { loadConfig } from '../../config.js';
import { log } from '../../logger.js';
import { bootstrapState, type ServerState } from '../../state/server-state.js';
import type { StoredUiAction } from '../../store/types.js';
import { TOOL_ACCESS, type ToolName } from '../../tool-registry.js';
import { SUMMARY_FIELDS } from '../command-summary.js';
import { MCP_INPUT_HASH } from '../mcp-audit.js';

let dbDir: string;
let state: ServerState;
let a: ClientConnection;
let b: ClientConnection;
const savedEnv = { ...process.env };

type Handler = (args: unknown, extra: unknown) => Promise<{ isError?: boolean }>;

async function call(connection: ClientConnection, name: string, args: unknown = {}) {
  const tool = connection.placeholders.get(name);
  if (tool === undefined) throw new Error(`no such tool: ${name}`);
  return (tool.handler as Handler)(args, {});
}

/** Arguments that keep a tool away from hardware: this one would arm the real microphone. */
const SAFE_ARGS: Partial<Record<ToolName, unknown>> = {
  'system.listen_start': { maxUtteranceSec: 0 },
};

const WRITE_TOOLS = (Object.keys(TOOL_ACCESS) as ToolName[]).filter(
  (name) => TOOL_ACCESS[name] === 'write',
);
const READ_TOOLS = (Object.keys(TOOL_ACCESS) as ToolName[]).filter(
  (name) => TOOL_ACCESS[name] === 'read',
);

function rows(): Promise<StoredUiAction[]> {
  return state.store.listUiActions({ limit: 200 });
}

beforeEach(async () => {
  __resetClientIdSequence();
  dbDir = mkdtempSync(join(tmpdir(), 'vmcp-mcp-audit-'));
  process.env.VOLTRA_ADAPTER = 'mock';
  process.env.VMCP_DB_PATH = join(dbDir, 'audit.sqlite');
  process.env.VMCP_SLOT_BINDINGS_PATH = join(dbDir, 'slot-bindings.json');
  process.env.VMCP_DASHBOARD_PORT = 'off';
  state = await bootstrapState(loadConfig());
  a = createClientConnection('client-a');
  b = createClientConnection('client-b');
  a.activate(state);
  b.activate(state);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await state.store.close();
  process.env = { ...savedEnv };
  rmSync(dbDir, { recursive: true, force: true });
});

describe('write tools', () => {
  it.each(WRITE_TOOLS)('%s leaves exactly one coach/mcp row with no result', async (name) => {
    if (name === 'device.unload') state.lease.tryAcquire('client-a');
    await call(a, name, SAFE_ARGS[name] ?? {});

    const recorded = (await rows()).filter((row) => row.actionName === name);
    expect(recorded).toHaveLength(1);
    const row = recorded[0]!;
    expect(row.actor).toBe('coach');
    expect(row.surface).toBe('mcp');
    expect(row.deviceId).toBe('client-a');
    expect(row.resultStatus).not.toBe('pending');
    expect(row.resultJson ?? null).toBeNull();
    expect(row.inputHash).toBe(MCP_INPUT_HASH);
    const summary = row.summaryJson == null ? {} : (JSON.parse(row.summaryJson) as object);
    for (const key of Object.keys(summary)) {
      expect(SUMMARY_FIELDS as readonly string[]).toContain(key);
    }
  });

  it('records the live session id and an ok outcome', async () => {
    const slot = state.slots.get('primary')!;
    slot.live.startSession({
      sessionId: 'sess-1',
      startedAt: new Date().toISOString(),
      exerciseId: 'bench-press',
      setIds: [],
    });

    await call(a, 'timer.start', { durationMs: 60000, label: 'rest' });

    const row = (await rows()).find((r) => r.actionName === 'timer.start')!;
    expect(row.sessionId).toBe('sess-1');
    expect(row.resultStatus).toBe('ok');
    expect(row.resultCode ?? null).toBeNull();
  });

  it('records a lease refusal with its code', async () => {
    await call(a, 'timer.start', { durationMs: 60000, label: 'rest' });

    const denied = await call(b, 'timer.start', { durationMs: 60000, label: 'rest' });

    expect(denied.isError).toBe(true);
    const refused = (await rows()).filter((r) => r.deviceId === 'client-b');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.resultStatus).toBe('error');
    expect(refused[0]!.resultCode).toBe('LEASE_HELD');
  });

  it('records a failed call with the tool code', async () => {
    await call(a, 'timer.start', { durationMs: 'not a number' });

    const row = (await rows()).find((r) => r.actionName === 'timer.start')!;
    expect(row.resultStatus).toBe('error');
    expect(row.resultCode).toBe('INVALID_INPUT');
  });

  it('does not stop device.unload when the store throws', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    vi.spyOn(state.store, 'claimUiAction').mockRejectedValue(new Error('store down'));
    vi.spyOn(state.store, 'completeUiAction').mockRejectedValue(new Error('store down'));
    state.lease.tryAcquire('client-a');

    const result = await call(a, 'device.unload');

    expect(result).toBeDefined();
    expect(log.warn).toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
  });
});

describe('read tools', () => {
  it('leave no row', async () => {
    for (const name of READ_TOOLS) {
      if (name === 'metrics.compute') continue;
      await call(a, name).catch(() => undefined);
    }

    expect(await rows()).toHaveLength(0);
  });
});
