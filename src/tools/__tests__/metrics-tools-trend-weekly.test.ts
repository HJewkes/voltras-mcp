// `metrics.compute history.trend`'s `weekly` field (VW-201): the same weekly
// summaries `history.weekly_volume` reports for the same lifter and window.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** ISO timestamp `n` weeks after 2026-07-06 (a Monday). */
function weekStart(n: number): string {
  return new Date(
    Date.parse('2026-07-06T12:00:00.000Z') + n * 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
}

function makeSet(id: string, exerciseId: string, startedAt: string, weightLbs: number): StoredSet {
  return {
    id,
    sessionId: `sess-${id}`,
    startedAt,
    endedAt: startedAt,
    partial: false,
    weightLbs,
    exerciseId,
    reps: [makeRep(id, 0), makeRep(id, 1)],
  };
}

function makeSession(set: StoredSet): StoredSession {
  return { id: set.sessionId, startedAt: set.startedAt, exerciseId: set.exerciseId! };
}

function makeState(sets: StoredSet[], chapterStartedAt: string | null = null): ServerState {
  const store = {
    listSessions: vi.fn(async () => sets.map(makeSession)),
    getSetsForSession: vi.fn(async (id: string) => sets.filter((s) => s.sessionId === id)),
    getSetsForExercise: vi.fn(async (q: { exerciseId: string }) =>
      sets.filter((s) => s.exerciseId === q.exerciseId),
    ),
    chapterStartedAt: vi.fn(async () => chapterStartedAt),
    getDietPhaseCovering: vi.fn(async () => undefined),
  };
  return {
    store,
    exercises: { getById: vi.fn(() => undefined) },
    config: { adapter: 'node' },
  } as unknown as ServerState;
}

type Handler = (args: unknown) => Promise<ToolResult>;

function compute(state: ServerState): Handler {
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (name: string, _schema: unknown, callback: Handler) => {
      handlers.set(name, callback);
      return {
        update: ({ callback: cb }: { callback: Handler }) => handlers.set(name, cb),
      } as unknown as RegisteredTool;
    },
  } as unknown as McpServer;
  const placeholder = server.tool('metrics.compute', (() => undefined) as never);
  registerMetricsTools(server, state, new Map([['metrics.compute', placeholder]]));
  return handlers.get('metrics.compute')!;
}

async function body(call: Handler, args: unknown): Promise<{ weekly: unknown[] }> {
  const result = await call(args);
  expect(result.isError, result.content[0].text).toBeUndefined();
  return JSON.parse(result.content[0].text) as { weekly: unknown[] };
}

describe('metrics.compute history.trend weekly', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the same weekly summaries as history.weekly_volume for the same window', async () => {
    const sets = [
      makeSet('a', 'back-squat', weekStart(0), 100),
      makeSet('b', 'back-squat', weekStart(1), 150),
      makeSet('c', 'bench-press', weekStart(1), 80),
    ];
    const call = compute(makeState(sets));

    const trend = await body(call, {
      pipeline: 'history.trend',
      exerciseId: 'back-squat',
      weeks: 12,
    });
    const volume = await body(call, { pipeline: 'history.weekly_volume', weeks: 12 });

    expect(trend.weekly.length).toBeGreaterThan(0);
    expect(trend.weekly).toEqual(volume.weekly);
  });

  it('returns an empty weekly list for a window with no working sets', async () => {
    const call = compute(makeState([], weekStart(0)));

    const trend = await body(call, { pipeline: 'history.trend', exerciseId: 'back-squat' });

    expect(trend.weekly).toEqual([]);
  });
});
