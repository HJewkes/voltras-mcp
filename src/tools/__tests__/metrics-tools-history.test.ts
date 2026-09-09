// `metrics.compute history.trend` (VW-144/VW-145).
//
// Pins the tool-layer plumbing: fetch -> mapper -> buildTimeSeries ->
// analyzeTrend/detectPlateau, using WA's REAL analytics functions (unmocked)
// against fixtures built to produce known directions.
//
// VW-150 adds the diet-phase readout: `plateau.phase` names the OBSERVED phase
// covering the plateau window. Its tests assert the verdict is byte-identical
// with and without a declared phase — the phase qualifies a reading, and B34
// states no correction to apply.

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
import type { StoredDietPhase, StoredRep, StoredSet } from '../../store/types.js';
import { covers } from '../../store/diet-phase.js';
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

function makeSet(id: string, weekIndex: number, weightLbs: number): StoredSet {
  const startedAt = weekStart(weekIndex);
  return {
    id,
    sessionId: `sess-${id}`,
    startedAt,
    endedAt: startedAt,
    partial: false,
    weightLbs,
    exerciseId: 'back-squat',
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

function makeState(sets: StoredSet[], phase?: StoredDietPhase): ServerState {
  const store = {
    getSetsForExercise: vi.fn(async () => sets),
    // VW-150: `history.trend` reports the phase covering the plateau window.
    // Absent by default — the answer for a lifter who never declared one.
    getDietPhaseCovering: vi.fn(async (_userId: string, from: string, to: string) =>
      phase !== undefined && covers(phase, from, to) ? phase : undefined,
    ),
  };
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

interface HistoryTrendBody {
  series: { ts: string; value: number }[];
  trend: { direction: 'up' | 'down' | 'flat' };
  plateau: { isPlateau: boolean; plateauDays: number; phase: string };
}

describe('metrics.compute — history.trend', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('8 weeks of rising top load -> trend up, no plateau', async () => {
    // 20% week-over-week growth: steep enough that no trailing run of
    // consecutive weeks stays within detectPlateau's default 5% band, so the
    // rise itself never reads as a plateau.
    const sets = Array.from({ length: 8 }, (_, i) => makeSet(`s-${i}`, i, 100 * 1.2 ** i));
    const state = makeState(sets);
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'history.trend', exerciseId: 'back-squat' });

    expect(result.isError).toBeUndefined();
    const body = parsePayload(result) as HistoryTrendBody;
    expect(body.series).toHaveLength(8);
    expect(body.trend.direction).toBe('up');
    expect(body.plateau.isPlateau).toBe(false);
    expect(body.plateau.phase).toBe('unknown');
  });

  it('6 flat weeks -> plateau with WA defaults (thresholdPct/minDays omitted)', async () => {
    const sets = Array.from({ length: 6 }, (_, i) => makeSet(`s-${i}`, i, 135));
    const state = makeState(sets);
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'history.trend', exerciseId: 'back-squat' });

    expect(result.isError).toBeUndefined();
    const body = parsePayload(result) as HistoryTrendBody;
    expect(body.trend.direction).toBe('flat');
    expect(body.plateau.isPlateau).toBe(true);
    expect(body.plateau.phase).toBe('unknown');
  });

  it('no working sets in the lookback window -> NOT_FOUND', async () => {
    const state = makeState([]);
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'history.trend', exerciseId: 'back-squat' });

    expect(result.isError).toBe(true);
    expect((parsePayload(result) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('excludes warm-ups and guests via the mapper before building the series', async () => {
    const working = makeSet('s-work', 0, 135);
    const warmup: StoredSet = { ...makeSet('s-warm', 0, 45), setPurpose: 'warmup' };
    const guest: StoredSet = { ...makeSet('s-guest', 0, 200), lifter: 'Jordan' };
    const state = makeState([working, warmup, guest]);
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'history.trend', exerciseId: 'back-squat' });

    expect(result.isError).toBeUndefined();
    const body = parsePayload(result) as HistoryTrendBody;
    // One week's worth of data, from the single surviving working set.
    expect(body.series).toEqual([{ ts: expect.any(String), value: 135 }]);
  });
});

describe('metrics.compute — history.trend diet phase (VW-150)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function phase(startedAt: string, endedAt?: string): StoredDietPhase {
    return {
      id: 'dp-1',
      userId: 'local',
      phase: 'fat-loss',
      startedAt,
      ...(endedAt !== undefined ? { endedAt } : {}),
      declaredAt: '2026-09-08T00:00:00.000Z',
    };
  }

  async function trendWith(
    sets: StoredSet[],
    declared?: StoredDietPhase,
  ): Promise<HistoryTrendBody> {
    const state = makeState(sets, declared);
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));
    const result = await callTool(tools, { pipeline: 'history.trend', exerciseId: 'back-squat' });
    expect(result.isError).toBeUndefined();
    return parsePayload(result) as HistoryTrendBody;
  }

  it('reports the phase covering the plateau window without changing the verdict', async () => {
    const sets = Array.from({ length: 6 }, (_, i) => makeSet(`s-${i}`, i, 135));

    const withoutPhase = await trendWith(sets);
    const withPhase = await trendWith(sets, phase('2026-01-01T00:00:00.000Z'));

    expect(withPhase.plateau.phase).toBe('fat-loss');
    // The verdict is the phase's only neighbour, never its dependent: B34
    // states no correction, so a fat-loss phase suppresses nothing.
    expect(withPhase.plateau.isPlateau).toBe(true);
    expect(withPhase.plateau.isPlateau).toBe(withoutPhase.plateau.isPlateau);
    expect(withPhase.plateau.plateauDays).toBe(withoutPhase.plateau.plateauDays);
    expect(withPhase.trend).toEqual(withoutPhase.trend);
  });

  it("reports 'unknown' when the phase only covers part of the plateau window", async () => {
    const sets = Array.from({ length: 6 }, (_, i) => makeSet(`s-${i}`, i, 135));

    // Declared after the plateau run began, so no single phase covers it.
    const body = await trendWith(sets, phase('2026-08-01T00:00:00.000Z'));

    expect(body.plateau.phase).toBe('unknown');
  });

  it("reports 'unknown' when no phase is declared at all", async () => {
    const sets = Array.from({ length: 6 }, (_, i) => makeSet(`s-${i}`, i, 135));

    expect((await trendWith(sets)).plateau.phase).toBe('unknown');
  });

  it('reports the phase at the last point when there is no plateau', async () => {
    // plateauDays is 0 here, which collapses the window to the final point —
    // the series still happened inside a declared phase.
    const sets = Array.from({ length: 8 }, (_, i) => makeSet(`s-${i}`, i, 100 * 1.2 ** i));

    const body = await trendWith(sets, phase('2026-01-01T00:00:00.000Z'));

    expect(body.plateau.isPlateau).toBe(false);
    expect(body.plateau.phase).toBe('fat-loss');
  });

  it("reports 'unknown' when the covering range ended before the window", async () => {
    const sets = Array.from({ length: 6 }, (_, i) => makeSet(`s-${i}`, i, 135));

    const body = await trendWith(
      sets,
      phase('2026-01-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
    );

    expect(body.plateau.phase).toBe('unknown');
  });
});
