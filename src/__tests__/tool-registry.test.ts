// Drift guards for the canonical tool surface (VMCP-01.60).
//
// The point of these tests is that the READ/WRITE table cannot quietly fall
// behind the tool list. `Record<ToolName, ToolAccess>` already makes tsc reject
// a MISSING entry; what tsc cannot catch is a STALE entry for a tool that was
// renamed or removed, or a new tool registered somewhere other than
// CORE_TOOL_NAMES. Both are checked here.
//
// The classification itself is a judgement call per tool, so these tests
// deliberately do not re-assert every verdict — that would just restate the
// table. They assert the shape, plus the two invariants that actually matter
// for the write-lease: every device mutation is `write`, and the tools an
// observer session depends on stay `read`.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createClientConnection } from '../client-connection.js';
import { loadConfig } from '../config.js';
import { bootstrapState } from '../state/server-state.js';
import {
  CORE_TOOL_NAMES,
  DEBUG_GATED_TOOL_NAMES,
  MOCK_TOOL_NAMES,
  TOOL_ACCESS,
  toolAccess,
  type ToolName,
} from '../tool-registry.js';

const ALL_TOOL_NAMES: readonly ToolName[] = [...CORE_TOOL_NAMES, ...MOCK_TOOL_NAMES];

describe('tool registry', () => {
  it('classifies every tool exactly once, with no stale entries', () => {
    const classified = Object.keys(TOOL_ACCESS).sort();
    expect(classified).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it('has no duplicate names across the core and mock lists', () => {
    expect(new Set(ALL_TOOL_NAMES).size).toBe(ALL_TOOL_NAMES.length);
  });

  it('returns undefined for an unknown tool rather than a default class', () => {
    // A typo must not silently resolve to 'read' and skip the lease check.
    expect(toolAccess('device.set_wieght')).toBeUndefined();
    expect(toolAccess('')).toBeUndefined();
  });

  it('classifies every device mutation as write', () => {
    const deviceMutators = CORE_TOOL_NAMES.filter(
      (name) => name.startsWith('device.') && name !== 'device.get_state',
    );
    for (const name of deviceMutators) {
      expect(toolAccess(name), `${name} must be write — it drives the radio`).toBe('write');
    }
  });

  it('holds the write classifications that are judgement calls', () => {
    // The verdicts most at risk of being "simplified" later: three that are
    // write by POLICY rather than by literal state mutation, plus the
    // high-consequence mutators. Flipping any of these to 'read' would let a
    // session with no write-lease drive a device someone is attached to.
    const mustBeWrite = [
      // POLICY — see the annotations in tool-registry.ts.
      'device.scan',
      'timer.wait',
      'isometric.measure_max',
      // Mutators whose cost of being wrong is highest.
      'bilateral.cascade',
      'slot.swap',
      'set.start',
      'set.end',
      'session.start',
      'session.end',
      'system.speak',
      'system.listen_start',
      'system.listen_stop',
      'slot.bind',
      'slot.unbind',
      'slot.identify',
      'isometric.measure_imbalance',
      'plan.program.create',
      'plan.complete_workout',
      'plan.attach_to_session',
      'session.mark_kind',
    ] as const;
    for (const name of mustBeWrite) {
      expect(toolAccess(name), `${name} must stay write`).toBe('write');
    }
  });

  it('keeps the observer surface readable without a lease', () => {
    // These are what a non-lease-holding session needs to be useful: watching
    // the live set, reading history, and checking server state. If one of these
    // ever flips to 'write', an observer session goes blind.
    const observerSurface = [
      'device.get_state',
      'set.live_metrics',
      'set.get',
      'session.get',
      'session.review_list',
      'session.list',
      'metrics.compute',
      'server.health',
    ] as const;
    for (const name of observerSurface) {
      expect(toolAccess(name), `${name} must stay readable for observers`).toBe('read');
    }
  });
});

/**
 * Boot a mock server with `env` layered on, and return the tool names a client
 * sees in `tools/list` before bootstrap finishes and after activation.
 */
async function listedToolNames(
  env: Record<string, string>,
): Promise<{ starting: string[]; active: string[] }> {
  const dbDir = mkdtempSync(join(tmpdir(), 'vmcp-registry-gate-'));
  const config = loadConfig({
    ...process.env,
    VOLTRA_ADAPTER: 'mock',
    VMCP_DB_PATH: join(dbDir, 'gate.sqlite'),
    VMCP_SLOT_BINDINGS_PATH: join(dbDir, 'slot-bindings.json'),
    ...env,
  });
  const connection = createClientConnection(undefined, { debugTools: config.debugTools });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'registry-gate', version: '0.0.1' }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), connection.server.connect(serverTransport)]);
  const state = await bootstrapState(config);
  try {
    const names = async (): Promise<string[]> =>
      (await client.listTools()).tools.map((tool) => tool.name);
    const starting = await names();
    connection.activate(state);
    return { starting, active: await names() };
  } finally {
    await client.close();
    await connection.server.close();
    state.manager.dispose();
    await state.store.close();
    rmSync(dbDir, { recursive: true, force: true });
  }
}

describe('debug-gated tools (VW-935)', () => {
  it('leaves the raw-device tools out of tools/list without VMCP_DEBUG_TOOLS', async () => {
    const { starting, active } = await listedToolNames({});

    for (const name of DEBUG_GATED_TOOL_NAMES) {
      expect(starting, `${name} listed during bootstrap`).not.toContain(name);
      expect(active, `${name} listed after activation`).not.toContain(name);
    }
    expect(active).toContain('debug.recent_events');
  });

  it('leaves them out for any value other than "on"', async () => {
    const { active } = await listedToolNames({ VMCP_DEBUG_TOOLS: 'true' });

    for (const name of DEBUG_GATED_TOOL_NAMES) {
      expect(active).not.toContain(name);
    }
  });

  it('registers both with VMCP_DEBUG_TOOLS=on', async () => {
    const { starting, active } = await listedToolNames({ VMCP_DEBUG_TOOLS: 'on' });

    for (const name of DEBUG_GATED_TOOL_NAMES) {
      expect(starting).toContain(name);
      expect(active).toContain(name);
    }
  });

  it('gates exactly the raw write path and the raw frame read', () => {
    expect([...DEBUG_GATED_TOOL_NAMES].sort()).toEqual(['debug.recent_frames', 'device.send_raw']);
  });
});
