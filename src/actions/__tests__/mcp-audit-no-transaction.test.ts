// An audited MCP call holds no store transaction while its handler runs
// (VW-892). A device handler awaits BLE and `timer.wait` awaits for minutes, so
// a transaction spanning the handler would make every other store call throw.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { loadConfig } from '../../config.js';
import { bootstrapState, type ServerState } from '../../state/server-state.js';
import { applyMcpAudit } from '../mcp-audit.js';

let dbDir: string;
let state: ServerState;
const savedEnv = { ...process.env };

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'vmcp-mcp-audit-tx-'));
  process.env.VOLTRA_ADAPTER = 'mock';
  process.env.VMCP_DB_PATH = join(dbDir, 'audit.sqlite');
  process.env.VMCP_SLOT_BINDINGS_PATH = join(dbDir, 'slot-bindings.json');
  process.env.VMCP_DASHBOARD_PORT = 'off';
  state = await bootstrapState(loadConfig());
});

afterEach(async () => {
  await state.store.close();
  process.env = { ...savedEnv };
  rmSync(dbDir, { recursive: true, force: true });
});

it('lets a concurrent store write succeed while a slow handler runs', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const slow = async () => {
    started();
    await gate;
    return { content: [{ type: 'text' as const, text: '{}' }] };
  };
  const tool = {
    handler: slow,
    update: (u: { callback: unknown }) => void (tool.handler = u.callback as typeof slow),
  };
  applyMcpAudit(new Map([['timer.wait', tool as unknown as RegisteredTool]]), state, 'client-a');

  const call = tool.handler();
  await running;
  const pending = await state.store.listUiActions({ status: 'pending' });
  await state.store.putSession({
    id: 'concurrent',
    startedAt: new Date().toISOString(),
    kind: 'training',
  });
  release();
  await call;

  expect(pending.map((row) => row.actionName)).toEqual(['timer.wait']);
  expect(await state.store.getSession('concurrent')).toBeDefined();
  const done = await state.store.listUiActions({ limit: 10 });
  expect(done[0]!.resultStatus).toBe('ok');
});
