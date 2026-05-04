// Tests for `metrics.compute` dispatcher — Wave 3C (Task 12).
//
// Verifies R20 / AC-20 / EC-07:
//   * Each pipeline dispatches to a DISTINCT `@voltras/workout-analytics`
//     function (asserted via spies on the module).
//   * `textResult` payload is the spy's return value — no transformation.
//   * Missing target id (`store.getSet` returns undefined) → `NOT_FOUND`
//     and the analytics function is NOT called.
//   * Pipelines whose backing function requires data not derivable from
//     the schema (`quality.rep` baseline, `session.readiness` scalar
//     inputs) return `NOT_IMPLEMENTED` until the schema/WA evolves.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Phase } from '@voltras/workout-analytics';
import * as analytics from '@voltras/workout-analytics';

// Stub the SDK so the static import chain (helpers -> errors -> SDK)
// does not pull in optional native peers.
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
const { textResult } = await import('../helpers.js');

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerState } from '../../state/server-state.js';
import type { StoredRep, StoredSet, StoredSession } from '../../store/types.js';
import type { ToolResult } from '../helpers.js';

// ─── Test fixtures ────────────────────────────────────────────────────────

const EMPTY_PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 0,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

function makeRep(setId: string, index: number): StoredRep {
  return {
    id: `${setId}-rep-${index}`,
    setId,
    index,
    repNumber: index + 1,
    concentric: { ...EMPTY_PHASE, peakVelocity: 0.5 + index * 0.01 },
    eccentric: { ...EMPTY_PHASE, peakVelocity: 0.3 + index * 0.01 },
  };
}

function makeSet(id: string, sessionId = 'sess-1', weight = 100): StoredSet {
  return {
    id,
    sessionId,
    startedAt: '2025-01-01T00:00:00.000Z',
    endedAt: '2025-01-01T00:00:30.000Z',
    partial: false,
    trainingMode: 'WeightTraining',
    weightLbs: weight,
    reps: [makeRep(id, 0), makeRep(id, 1), makeRep(id, 2)],
  };
}

// ─── Test doubles ─────────────────────────────────────────────────────────

interface RegisteredHandler {
  name: string;
  callback: (args: unknown, extra?: unknown) => Promise<ToolResult>;
}

function makeFakeServer(): { server: McpServer; tools: Map<string, RegisteredHandler> } {
  const tools = new Map<string, RegisteredHandler>();
  const server = {
    tool: (name: string, _schema: unknown, callback: RegisteredHandler['callback']) => {
      const reg: RegisteredTool = {
        update: ({ callback: cb }: { callback: RegisteredHandler['callback'] }) => {
          tools.set(name, { name, callback: cb });
        },
      } as unknown as RegisteredTool;
      tools.set(name, { name, callback });
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

interface StoreStub {
  getSet: ReturnType<typeof vi.fn>;
  getSetsForSession: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
  putSession: ReturnType<typeof vi.fn>;
  putSet: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makeStateWithStore(overrides: Partial<StoreStub> = {}): ServerState {
  const store: StoreStub = {
    getSet: vi.fn(async () => undefined),
    getSetsForSession: vi.fn(async () => []),
    getSession: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => []),
    putSession: vi.fn(async () => undefined),
    putSet: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
  return { store } as unknown as ServerState;
}

async function callTool(tools: Map<string, RegisteredHandler>, args: unknown): Promise<ToolResult> {
  const reg = tools.get('metrics.compute');
  if (!reg) throw new Error('metrics.compute not registered');
  return reg.callback(args);
}

function parsePayload(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

// ─── Spy registry: each pipeline maps to a UNIQUE analytics function ──────
//
// AC-20 demands every pipeline target a distinct function symbol. Listing
// the symbols here in one place lets a single test assert the
// distinct-symbol invariant up front.

const PIPELINE_TO_ANALYTICS_FN: Record<string, keyof typeof analytics | null> = {
  'vbt.set': 'getSetVelocitySummary',
  'vbt.profile': 'buildProfile',
  'fatigue.set': 'getSetFatigueIndex',
  'session.volume': 'computeVolume',
  'session.fatigue': 'computeSessionFatigue',
  'session.strength': 'computeStrengthEstimate',
  // `quality.rep` and `session.readiness` are NOT_IMPLEMENTED in this wave.
  'quality.rep': null,
  'session.readiness': null,
};

describe('AC-20 — distinct analytics function per pipeline', () => {
  it('every dispatched pipeline targets a unique analytics function symbol', () => {
    const symbols = Object.values(PIPELINE_TO_ANALYTICS_FN).filter(
      (s): s is keyof typeof analytics => s !== null,
    );
    expect(new Set(symbols).size).toBe(symbols.length);
    for (const sym of symbols) {
      expect(typeof analytics[sym]).toBe('function');
    }
  });
});

// ─── Per-pipeline dispatch tests ──────────────────────────────────────────

describe('metrics.compute — vbt.set', () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(analytics, 'getSetVelocitySummary').mockReturnValue({
      first: 0.6,
      last: 0.4,
      best: 0.7,
      mean: 0.5,
      peak: 0.7,
      lossPct: 0.3,
      repCount: 3,
    });
  });
  afterEach(() => spy.mockRestore());

  it('fetches the set, dispatches to getSetVelocitySummary, returns textResult of the spy value', async () => {
    const set = makeSet('set-1');
    const state = makeStateWithStore({
      getSet: vi.fn(async (id: string) => (id === 'set-1' ? set : undefined)),
    });
    const { server, tools } = makeFakeServer();
    const placeholders = makePlaceholders(server);
    registerMetricsTools(server, state, placeholders);

    const result = await callTool(tools, { pipeline: 'vbt.set', setId: 'set-1' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ reps: set.reps });
    expect(result.isError).toBeUndefined();
    expect(parsePayload(result)).toEqual({
      first: 0.6,
      last: 0.4,
      best: 0.7,
      mean: 0.5,
      peak: 0.7,
      lossPct: 0.3,
      repCount: 3,
    });
  });

  it('EC-07: returns NOT_FOUND and does NOT call analytics when set is missing', async () => {
    const state = makeStateWithStore();
    const { server, tools } = makeFakeServer();
    const placeholders = makePlaceholders(server);
    registerMetricsTools(server, state, placeholders);

    const result = await callTool(tools, { pipeline: 'vbt.set', setId: 'does-not-exist' });

    expect(spy).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect((parsePayload(result) as { code: string }).code).toBe('NOT_FOUND');
  });
});

describe('metrics.compute — vbt.profile', () => {
  let buildSpy: ReturnType<typeof vi.spyOn>;
  let velSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    buildSpy = vi.spyOn(analytics, 'buildProfile').mockReturnValue({
      dataPoints: [],
      slope: -0.01,
      intercept: 1.2,
      rSquared: 0.95,
      estimated1RM: 200,
      confidence: 'high',
      mvt: 0.17,
    });
    velSpy = vi.spyOn(analytics, 'getSetMeanVelocity').mockImplementation(() => 0.5);
  });
  afterEach(() => {
    buildSpy.mockRestore();
    velSpy.mockRestore();
  });

  it('builds load-velocity points from the requested sets and dispatches to buildProfile', async () => {
    const setA = makeSet('s-a', 'sess-1', 100);
    const setB = makeSet('s-b', 'sess-1', 150);
    const state = makeStateWithStore({
      getSet: vi.fn(async (id: string) => (id === 's-a' ? setA : id === 's-b' ? setB : undefined)),
    });
    const { server, tools } = makeFakeServer();
    const placeholders = makePlaceholders(server);
    registerMetricsTools(server, state, placeholders);

    const result = await callTool(tools, {
      pipeline: 'vbt.profile',
      setIds: ['s-a', 's-b'],
    });

    expect(buildSpy).toHaveBeenCalledTimes(1);
    const args = buildSpy.mock.calls[0]?.[0] as Array<{ load: number; velocity: number }>;
    expect(args).toHaveLength(2);
    expect(args[0]).toMatchObject({ load: 100, velocity: 0.5 });
    expect(args[1]).toMatchObject({ load: 150, velocity: 0.5 });
    expect(result.isError).toBeUndefined();
    expect((parsePayload(result) as { estimated1RM: number }).estimated1RM).toBe(200);
  });

  it('EC-07: any missing set id → NOT_FOUND, buildProfile NOT called', async () => {
    const setA = makeSet('s-a');
    const state = makeStateWithStore({
      getSet: vi.fn(async (id: string) => (id === 's-a' ? setA : undefined)),
    });
    const { server, tools } = makeFakeServer();
    const placeholders = makePlaceholders(server);
    registerMetricsTools(server, state, placeholders);

    const result = await callTool(tools, {
      pipeline: 'vbt.profile',
      setIds: ['s-a', 'missing'],
    });

    expect(buildSpy).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect((parsePayload(result) as { code: string }).code).toBe('NOT_FOUND');
  });
});

describe('metrics.compute — fatigue.set', () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(analytics, 'getSetFatigueIndex').mockReturnValue({
      rpe: 8,
      rir: 2,
      confidence: 'medium',
    } as unknown as ReturnType<typeof analytics.getSetFatigueIndex>);
  });
  afterEach(() => spy.mockRestore());

  it('fetches the set and dispatches to getSetFatigueIndex', async () => {
    const set = makeSet('set-x', 'sess-1', 200);
    const state = makeStateWithStore({
      getSet: vi.fn(async (id: string) => (id === 'set-x' ? set : undefined)),
    });
    const { server, tools } = makeFakeServer();
    const placeholders = makePlaceholders(server);
    registerMetricsTools(server, state, placeholders);

    const result = await callTool(tools, { pipeline: 'fatigue.set', setId: 'set-x' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ reps: set.reps });
    expect(result.isError).toBeUndefined();
    expect((parsePayload(result) as { rpe: number }).rpe).toBe(8);
  });

  it('EC-07: missing set → NOT_FOUND', async () => {
    const state = makeStateWithStore();
    const { server, tools } = makeFakeServer();
    const placeholders = makePlaceholders(server);
    registerMetricsTools(server, state, placeholders);

    const result = await callTool(tools, { pipeline: 'fatigue.set', setId: 'nope' });

    expect(spy).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect((parsePayload(result) as { code: string }).code).toBe('NOT_FOUND');
  });
});

describe('metrics.compute — session.volume', () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(analytics, 'computeVolume').mockReturnValue(1234);
  });
  afterEach(() => spy.mockRestore());

  it('reads sets via getSetsForSession and dispatches to computeVolume with weights derived from weightLbs', async () => {
    const sets = [makeSet('s1', 'session-A', 100), makeSet('s2', 'session-A', 120)];
    const state = makeStateWithStore({
      getSetsForSession: vi.fn(async (id: string) => (id === 'session-A' ? sets : [])),
    });
    const { server, tools } = makeFakeServer();
    const placeholders = makePlaceholders(server);
    registerMetricsTools(server, state, placeholders);

    const result = await callTool(tools, {
      pipeline: 'session.volume',
      sessionId: 'session-A',
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const [analyticsSets, weights] = spy.mock.calls[0] ?? [];
    expect(analyticsSets).toHaveLength(2);
    expect(weights).toEqual([100, 120]);
    expect(result.isError).toBeUndefined();
    expect(parsePayload(result)).toBe(1234);
  });

  it('EC-07: empty session set list → NOT_FOUND, computeVolume NOT called', async () => {
    const state = makeStateWithStore({
      getSetsForSession: vi.fn(async () => []),
      getSession: vi.fn(async () => undefined),
    });
    const { server, tools } = makeFakeServer();
    const placeholders = makePlaceholders(server);
    registerMetricsTools(server, state, placeholders);

    const result = await callTool(tools, {
      pipeline: 'session.volume',
      sessionId: 'unknown-session',
    });

    expect(spy).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect((parsePayload(result) as { code: string }).code).toBe('NOT_FOUND');
  });
});

describe('metrics.compute — session.fatigue', () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(analytics, 'computeSessionFatigue').mockReturnValue({
      level: 0.4,
      velocityRecoveryPct: 0.85,
      repDropPct: 0.1,
      isJunkVolume: false,
    });
  });
  afterEach(() => spy.mockRestore());

  it('dispatches all session sets to computeSessionFatigue', async () => {
    const sets = [makeSet('s1', 'sess-F', 100), makeSet('s2', 'sess-F', 100)];
    const state = makeStateWithStore({
      getSetsForSession: vi.fn(async () => sets),
    });
    const { server, tools } = makeFakeServer();
    const placeholders = makePlaceholders(server);
    registerMetricsTools(server, state, placeholders);

    const result = await callTool(tools, {
      pipeline: 'session.fatigue',
      sessionId: 'sess-F',
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const [, weights] = spy.mock.calls[0] ?? [];
    expect(weights).toEqual([100, 100]);
    expect(result.isError).toBeUndefined();
    expect((parsePayload(result) as { level: number }).level).toBe(0.4);
  });
});

describe('metrics.compute — session.strength', () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(analytics, 'computeStrengthEstimate').mockReturnValue({
      estimated1RM: 250,
      confidence: 0.8,
      source: 'reps',
    });
  });
  afterEach(() => spy.mockRestore());

  it('dispatches session sets + weights to computeStrengthEstimate', async () => {
    const sets = [makeSet('s1', 'sess-S', 200), makeSet('s2', 'sess-S', 220)];
    const state = makeStateWithStore({
      getSetsForSession: vi.fn(async () => sets),
    });
    const { server, tools } = makeFakeServer();
    const placeholders = makePlaceholders(server);
    registerMetricsTools(server, state, placeholders);

    const result = await callTool(tools, {
      pipeline: 'session.strength',
      sessionId: 'sess-S',
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const [, weights] = spy.mock.calls[0] ?? [];
    expect(weights).toEqual([200, 220]);
    expect(result.isError).toBeUndefined();
    expect((parsePayload(result) as { estimated1RM: number }).estimated1RM).toBe(250);
  });
});

describe('metrics.compute — quality.rep and session.readiness', () => {
  it('quality.rep dispatches to assessRepQuality with a baseline built from baselineSetId', async () => {
    const target = makeSet('target-set');
    const baseline = makeSet('baseline-set');
    const assessSpy = vi.spyOn(analytics, 'assessRepQuality').mockReturnValue({} as never);
    const buildSpy = vi.spyOn(analytics, 'createTechniqueBaseline');
    const state = makeStateWithStore({
      getSet: vi.fn(async (id: string) => (id === 'target-set' ? target : baseline)),
    });
    const { server, tools } = makeFakeServer();
    const placeholders = makePlaceholders(server);
    registerMetricsTools(server, state, placeholders);

    const result = await callTool(tools, {
      pipeline: 'quality.rep',
      setId: 'target-set',
      baselineSetId: 'baseline-set',
    });

    expect(buildSpy).toHaveBeenCalledOnce();
    expect(assessSpy).toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    assessSpy.mockRestore();
    buildSpy.mockRestore();
  });

  it('session.readiness dispatches to computeReadiness with first-rep velocities from each session', async () => {
    const target = makeSet('s1', 'sess-target');
    const baseline = makeSet('s1', 'sess-baseline');
    const readinessSpy = vi.spyOn(analytics, 'computeReadiness').mockReturnValue({} as never);
    const state = makeStateWithStore({
      getSetsForSession: vi.fn(async (id: string) => [id === 'sess-target' ? target : baseline]),
    });
    const { server, tools } = makeFakeServer();
    const placeholders = makePlaceholders(server);
    registerMetricsTools(server, state, placeholders);

    const result = await callTool(tools, {
      pipeline: 'session.readiness',
      sessionId: 'sess-target',
      baselineSessionId: 'sess-baseline',
    });

    expect(readinessSpy).toHaveBeenCalledOnce();
    expect(result.isError).toBeUndefined();
    readinessSpy.mockRestore();
  });
});

describe('metrics.compute — input validation', () => {
  it('returns INVALID_INPUT for an unknown pipeline literal', async () => {
    const state = makeStateWithStore();
    const { server, tools } = makeFakeServer();
    const placeholders = makePlaceholders(server);
    registerMetricsTools(server, state, placeholders);

    const result = await callTool(tools, { pipeline: 'nope', setId: 'x' });

    expect(result.isError).toBe(true);
    expect((parsePayload(result) as { code: string }).code).toBe('INVALID_INPUT');
  });
});

describe('metrics.compute — registration', () => {
  it('replaces the placeholder via update({ callback }) so the live handler is reachable', async () => {
    const updateSpy = vi.fn();
    const placeholderTool: RegisteredTool = {
      update: updateSpy,
    } as unknown as RegisteredTool;
    const placeholders = new Map<string, RegisteredTool>([['metrics.compute', placeholderTool]]);
    const server = { tool: vi.fn() } as unknown as McpServer;
    const state = makeStateWithStore();

    registerMetricsTools(server, state, placeholders);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0]?.[0]).toHaveProperty('callback');
  });
});

// Reference textResult import to keep the dependency obvious for AC-20.
void textResult;
// Reference unused fixture types so removing them later breaks the build.
void (null as unknown as StoredSession);
