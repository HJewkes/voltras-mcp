// The weekly volume rollup buckets a session into the lifter's LOCAL week (VW-876), run six
// hours west of UTC where Sunday evening is already Monday in UTC.

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/Denver';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { StoredRep, StoredSession, StoredSet } from '../../store/types.js';
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

/** Monday-anchored ISO timestamp, `n` weeks after 2026-07-06 (a Monday). */
function weekStart(n: number): string {
  const ms = Date.parse('2026-07-06T12:00:00.000Z') + n * 7 * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

function makeSet(id: string, overrides: Partial<StoredSet> = {}): StoredSet {
  const startedAt = overrides.startedAt ?? weekStart(0);
  return {
    id,
    sessionId: `sess-${id}`,
    startedAt,
    endedAt: startedAt,
    partial: false,
    weightLbs: 100,
    exerciseId: 'back-squat',
    reps: [makeRep(id, 0), makeRep(id, 1)],
    ...overrides,
  };
}

function makeSession(id: string, startedAt: string, exerciseId?: string): StoredSession {
  return { id, startedAt, ...(exerciseId !== undefined ? { exerciseId } : {}) };
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

function makeState(sessions: StoredSession[], sets: StoredSet[]): ServerState {
  const store = {
    listSessions: vi.fn(async () => sessions),
    getSetsForSession: vi.fn(async () => sets),
  };
  const exercises = { getById: vi.fn(() => undefined) };
  return { store, exercises, config: { adapter: 'node' } } as unknown as ServerState;
}

async function callTool(tools: Map<string, RegisteredHandler>, args: unknown): Promise<ToolResult> {
  const reg = tools.get('metrics.compute');
  if (!reg) throw new Error('metrics.compute not registered');
  return reg.callback(args);
}

function parsePayload(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('metrics.compute history.weekly_volume west of UTC', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a Sunday 20:00 local session in that Sunday's week, not the next", async () => {
    const sundayEvening = '2026-09-14T02:00:00.000Z';
    const set = makeSet('s1', { startedAt: sundayEvening });
    const state = makeState([makeSession('sess-s1', sundayEvening)], [set]);
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'history.weekly_volume' });

    const body = parsePayload(result) as WeeklyVolumeBody;
    expect(body.weekly.map((w) => w.weekStart.slice(0, 10))).toEqual(['2026-09-07']);
  });
});
