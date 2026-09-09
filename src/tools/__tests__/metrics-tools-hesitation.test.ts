// `metrics.compute quality.hesitation` — VMCP-06.02 / B12 wiring.
//
// The detector itself (`detectHesitation`) is unit-tested in
// `src/analytics/__tests__/rep-faults.test.ts`; this file only pins the
// tool-layer plumbing: fetch → map every rep → set summary, and EC-07's
// missing-set NOT_FOUND behaviour.

import { describe, expect, it, vi } from 'vitest';
import type { Phase } from '@voltras/workout-analytics';

class FakeVoltraSDKError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'VoltraSDKError';
    this.code = code;
  }
}
vi.mock('@voltras/node-sdk', () => ({ VoltraSDKError: FakeVoltraSDKError }));

const { registerMetricsTools } = await import('../metrics-tools.js');

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerState } from '../../state/server-state.js';
import type { StoredRep, StoredSet } from '../../store/types.js';
import type { ToolResult } from '../helpers.js';

const EMPTY_PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 1,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  peakVelocity: 0.5,
  peakForce: 0,
  peakLoad: 0,
};

function makeRep(setId: string, index: number): StoredRep {
  return {
    id: `${setId}-rep-${index}`,
    setId,
    index,
    repNumber: index + 1,
    concentric: { ...EMPTY_PHASE },
    eccentric: { ...EMPTY_PHASE },
  };
}

function makeSet(id: string): StoredSet {
  return {
    id,
    sessionId: 'sess-1',
    startedAt: '2025-01-01T00:00:00.000Z',
    endedAt: '2025-01-01T00:00:30.000Z',
    partial: false,
    trainingMode: 'WeightTraining',
    weightLbs: 100,
    reps: [makeRep(id, 0), makeRep(id, 1)],
  };
}

interface RegisteredHandler {
  callback: (args: unknown, extra?: unknown) => Promise<ToolResult>;
}

function makeFakeServer(): { server: McpServer; tools: Map<string, RegisteredHandler> } {
  const tools = new Map<string, RegisteredHandler>();
  const server = {
    tool: (name: string, _schema: unknown, callback: RegisteredHandler['callback']) => {
      const reg: RegisteredTool = {
        update: ({ callback: cb }: { callback: RegisteredHandler['callback'] }) => {
          tools.set(name, { callback: cb });
        },
      } as unknown as RegisteredTool;
      tools.set(name, { callback });
      return reg;
    },
  } as unknown as McpServer;
  return { server, tools };
}

function makePlaceholders(server: McpServer): Map<string, RegisteredTool> {
  const m = new Map<string, RegisteredTool>();
  const cb = (): ToolResult => ({ content: [{ type: 'text', text: '{}' }], isError: true });
  m.set('metrics.compute', server.tool('metrics.compute', cb));
  return m;
}

function makeState(getSet: (id: string) => Promise<StoredSet | undefined>): ServerState {
  const store = { getSet: vi.fn(getSet) };
  return { store, exercises: { getById: vi.fn(() => undefined) } } as unknown as ServerState;
}

async function callTool(tools: Map<string, RegisteredHandler>, args: unknown): Promise<ToolResult> {
  const reg = tools.get('metrics.compute');
  if (!reg) throw new Error('metrics.compute not registered');
  return reg.callback(args);
}

function parsePayload(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

describe('metrics.compute — quality.hesitation', () => {
  it('fetches the set and returns a hesitation reading per rep with a null hesitatedCount', async () => {
    const set = makeSet('set-1');
    const state = makeState(async (id) => (id === 'set-1' ? set : undefined));
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'quality.hesitation', setId: 'set-1' });

    expect(parsePayload(result)).toEqual({
      reps: [
        { repNumber: 1, crossings: [], hesitated: null },
        { repNumber: 2, crossings: [], hesitated: null },
      ],
      hesitatedCount: null,
    });
  });

  it('EC-07: returns NOT_FOUND for a missing set', async () => {
    const state = makeState(async () => undefined);
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'quality.hesitation', setId: 'missing' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('NOT_FOUND');
  });
});
