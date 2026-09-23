// The boot-time handler capture (VW-502).
//
// The whole reason this module exists is that the handler reachable through a
// live MCP connection is lease-wrapped under that connection's client id. The
// last test here pins exactly that: the captured handler runs with NO lease
// held and does not answer with a lease error, which the connection's own
// callback would.
//
// Mock adapter + throwaway SQLite, same shape as `lease-guard.test.ts`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { captureActionHandlers } from '../capture-handlers.js';
import { ACTION_ALLOWLIST } from '../allowlist.js';
import { createClientConnection, __resetClientIdSequence } from '../../client-connection.js';
import { loadConfig } from '../../config.js';
import { bootstrapState, type ServerState } from '../../state/server-state.js';
import { TOOL_ACCESS, type ToolName } from '../../tool-registry.js';

let dbDir: string;
let state: ServerState;
const savedEnv = { ...process.env };

beforeEach(async () => {
  __resetClientIdSequence();
  dbDir = mkdtempSync(join(tmpdir(), 'vmcp-capture-'));
  process.env.VOLTRA_ADAPTER = 'mock';
  process.env.VMCP_DB_PATH = join(dbDir, 'capture.sqlite');
  process.env.VMCP_SLOT_BINDINGS_PATH = join(dbDir, 'slot-bindings.json');
  state = await bootstrapState(loadConfig());
});

afterEach(async () => {
  await state.store.close();
  rmSync(dbDir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

/** Read the JSON a `ToolResult` carries in its first content block. */
function payloadOf(result: unknown): Record<string, unknown> {
  const content = (result as { content?: { text?: string }[] }).content;
  return JSON.parse(content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('captureActionHandlers', () => {
  it('captures every tool the allowlist names', () => {
    const captured = captureActionHandlers(state);
    for (const [name, entry] of Object.entries(ACTION_ALLOWLIST)) {
      expect(captured.get(entry.tool), `${name} was not captured`).toBeDefined();
    }
  });

  it('captures a schema shape and a handler for each', () => {
    const captured = captureActionHandlers(state);
    const tool = captured.get('profile.log_bodyweight');
    expect(typeof tool?.handler).toBe('function');
    expect(Object.keys(tool?.paramsShape ?? {}).length).toBeGreaterThan(0);
  });

  it('runs with no MCP client attached at all', () => {
    // The wall's actual condition. A capture taken during tool registration
    // would not exist here, because registration is per connection.
    expect(state.clients.size).toBe(0);
    expect(captureActionHandlers(state).size).toBeGreaterThan(0);
  });

  it('does not touch the McpServer, so it needs no connection', () => {
    // NO_SERVER throws on any property read. Reaching here means no module
    // in the capture list read the server.
    expect(() => captureActionHandlers(state)).not.toThrow();
  });

  it('is not the lease-guarded wrapper', async () => {
    // Every allowlisted tool is WRITE-classified, so the callback a connection
    // installs refuses without the lease. The captured one must not.
    const allowlisted = Object.values(ACTION_ALLOWLIST).map((entry) => entry.tool);
    for (const tool of allowlisted) {
      expect(TOOL_ACCESS[tool as ToolName], `${tool} is no longer a write tool`).toBe('write');
    }

    // A second client holds the lease, so the FIRST client's wrapped callback
    // is refused. That is the contrast the captured handler has to beat.
    const holder = createClientConnection('holder');
    holder.activate(state);
    const other = createClientConnection('other');
    other.activate(state);
    expect(state.lease.tryAcquire('holder').ok).toBe(true);

    const wrapped = other.placeholders.get('profile.log_bodyweight');
    const viaConnection = payloadOf(
      await (wrapped?.handler as (a: unknown, e: unknown) => Promise<unknown>)(
        { weightLbs: 180 },
        {},
      ),
    );
    expect(viaConnection.code).toMatch(/^LEASE_/);

    const captured = captureActionHandlers(state).get('profile.log_bodyweight');
    const viaCapture = payloadOf(await captured?.handler({ weightLbs: 180 }));
    expect((viaCapture.code as string | undefined) ?? 'none').not.toMatch(/^LEASE_/);

    await holder.close(state);
    await other.close(state);
  });
});
