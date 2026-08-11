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
import type {
  BaselineState,
  StoredExerciseBaseline,
  StoredRep,
  StoredSet,
  StoredSession,
} from '../../store/types.js';
import type { FeatureGateVerdict } from '../../store/baseline-gate.js';
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

/** `null` means a session that names NO exercise — not the same as omitting
 *  the argument, which yields the ordinary named-exercise session. */
function makeSession(id: string, exerciseId: string | null = 'bench-press'): StoredSession {
  return {
    id,
    startedAt: '2025-01-01T00:00:00.000Z',
    ...(exerciseId !== null ? { exerciseId } : {}),
  };
}

function makeBaselineRow(
  state: BaselineState,
  confidence: number,
  exerciseId = 'bench-press',
): StoredExerciseBaseline {
  return {
    id: `local|${exerciseId}`,
    userId: 'local',
    exerciseId,
    state,
    confidence,
    observedSessions: 4,
    anchorCount: state === 'CALIBRATED' ? 3 : 0,
    updatedAt: '2025-01-01T00:00:00.000Z',
    algorithmVersion: 'baseline@1.0.0',
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
  getBaseline: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
  putSession: ReturnType<typeof vi.fn>;
  putSet: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makeStateWithStore(overrides: Partial<StoreStub> = {}): ServerState {
  const store: StoreStub = {
    getSet: vi.fn(async () => undefined),
    getSetsForSession: vi.fn(async () => []),
    // A session that names its exercise is the ordinary case. `session.readiness`'s
    // B57 gate needs one to build a baseline key at all, so a blanket `undefined`
    // here would silently withhold on every readiness test.
    getSession: vi.fn(async (id: string) => makeSession(id)),
    // No baseline row by default — the gate withholds, which is the honest
    // answer for a store that was never recalculated.
    getBaseline: vi.fn(async () => undefined),
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
  'vbt.rir': 'estimateRIRWithProfile',
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

  it('targetVelocity → dispatches estimateLoad and attaches a recommendation', async () => {
    const loadSpy = vi.spyOn(analytics, 'estimateLoad').mockReturnValue(135);
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
      targetVelocity: 0.75,
    });

    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(loadSpy.mock.calls[0]?.[1]).toBe(0.75);
    expect(result.isError).toBeUndefined();
    const payload = parsePayload(result) as {
      estimated1RM: number;
      recommendation: { targetVelocity: number; recommendedLoad: number; confidence: string };
    };
    expect(payload.estimated1RM).toBe(200); // bare profile still present
    expect(payload.recommendation).toEqual({
      targetVelocity: 0.75,
      recommendedLoad: 135,
      confidence: 'high',
    });
    loadSpy.mockRestore();
  });

  it('omitting targetVelocity leaves the response as the bare profile', async () => {
    const loadSpy = vi.spyOn(analytics, 'estimateLoad');
    const setA = makeSet('s-a', 'sess-1', 100);
    const setB = makeSet('s-b', 'sess-1', 150);
    const state = makeStateWithStore({
      getSet: vi.fn(async (id: string) => (id === 's-a' ? setA : id === 's-b' ? setB : undefined)),
    });
    const { server, tools } = makeFakeServer();
    const placeholders = makePlaceholders(server);
    registerMetricsTools(server, state, placeholders);

    const result = await callTool(tools, { pipeline: 'vbt.profile', setIds: ['s-a', 's-b'] });

    expect(loadSpy).not.toHaveBeenCalled();
    expect(parsePayload(result)).not.toHaveProperty('recommendation');
    loadSpy.mockRestore();
  });

  it('degenerate flat profile (slope 0) → honest null recommendation, estimateLoad NOT called', async () => {
    buildSpy.mockReturnValue({
      dataPoints: [],
      slope: 0,
      intercept: 0.5,
      rSquared: 0,
      estimated1RM: 0,
      confidence: 'low',
      mvt: 0.17,
    });
    const loadSpy = vi.spyOn(analytics, 'estimateLoad').mockReturnValue(0);
    const setA = makeSet('s-a', 'sess-1', 100);
    const setB = makeSet('s-b', 'sess-1', 100);
    const state = makeStateWithStore({
      getSet: vi.fn(async (id: string) => (id === 's-a' ? setA : id === 's-b' ? setB : undefined)),
    });
    const { server, tools } = makeFakeServer();
    const placeholders = makePlaceholders(server);
    registerMetricsTools(server, state, placeholders);

    const result = await callTool(tools, {
      pipeline: 'vbt.profile',
      setIds: ['s-a', 's-b'],
      targetVelocity: 0.75,
    });

    expect(loadSpy).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect((parsePayload(result) as { recommendation: unknown }).recommendation).toBeNull();
    loadSpy.mockRestore();
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

  it('VMCP-02.26: surfaces within-set fatigue for a single near-failure set (level not 0)', async () => {
    // Single set, concentric velocity decays 1.0 -> 0.5 (50% loss). The
    // cross-set estimate has nothing to compare against, so it returns level 0
    // (the bug). The handler must fold in the within-set fatigue index.
    spy.mockReturnValue({ level: 0, velocityRecoveryPct: 0, repDropPct: 0, isJunkVolume: false });
    // Mean concentric velocity is read from _totalVelocity / _movementSampleCount
    // (getRepMeanVelocity), so set those to make the per-rep mean equal `vel`.
    const decliningRep = (i: number, vel: number): StoredRep => ({
      id: `d-rep-${i}`,
      setId: 'd1',
      index: i,
      repNumber: i + 1,
      concentric: {
        ...EMPTY_PHASE,
        peakVelocity: vel,
        _totalVelocity: vel * 4,
        _movementSampleCount: 4,
      },
      eccentric: { ...EMPTY_PHASE, peakVelocity: vel * 0.6 },
    });
    const set: StoredSet = {
      id: 'd1',
      sessionId: 'sess-nf',
      startedAt: '2025-01-01T00:00:00.000Z',
      endedAt: '2025-01-01T00:00:30.000Z',
      partial: false,
      trainingMode: 'WeightTraining',
      weightLbs: 60,
      reps: [decliningRep(0, 1.0), decliningRep(1, 0.75), decliningRep(2, 0.5)],
    };
    const state = makeStateWithStore({ getSetsForSession: vi.fn(async () => [set]) });
    const { server, tools } = makeFakeServer();
    const placeholders = makePlaceholders(server);
    registerMetricsTools(server, state, placeholders);

    const result = await callTool(tools, { pipeline: 'session.fatigue', sessionId: 'sess-nf' });
    expect(result.isError).toBeUndefined();
    const payload = parsePayload(result) as {
      level: number;
      withinSetFatigue: { max: number; perSet: number[] };
    };
    expect(payload.level).toBeGreaterThan(0);
    expect(payload.withinSetFatigue.max).toBeGreaterThan(0);
    expect(payload.withinSetFatigue.perSet).toHaveLength(1);
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
    const readinessSpy = vi
      .spyOn(analytics, 'computeReadiness')
      .mockReturnValue({ zone: 'green' } as never);
    const state = makeStateWithStore({
      getSetsForSession: vi.fn(async (id: string) => [id === 'sess-target' ? target : baseline]),
      getBaseline: vi.fn(async () => makeBaselineRow('CALIBRATED', 0.9)),
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
    // B57 wraps the estimate; the estimate itself is still passed through raw.
    expect((parsePayload(result) as GatedReadiness).readiness).toEqual({ zone: 'green' });
    readinessSpy.mockRestore();
  });
});

// ─── B57: baseline-gated readiness ────────────────────────────────────────

interface GatedReadiness {
  readiness: unknown;
  observed: { actualVelocityMps: number; baselineVelocityMps: number };
  gate: FeatureGateVerdict;
}

describe('metrics.compute — session.readiness baseline gating (B57)', () => {
  let readinessSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    readinessSpy = vi
      .spyOn(analytics, 'computeReadiness')
      .mockReturnValue({ zone: 'green' } as never);
  });
  afterEach(() => {
    readinessSpy.mockRestore();
  });

  function stateFor(overrides: Parameters<typeof makeStateWithStore>[0] = {}): ServerState {
    const target = makeSet('s1', 'sess-target');
    const baseline = makeSet('s2', 'sess-baseline');
    return makeStateWithStore({
      getSetsForSession: vi.fn(async (id: string) => [id === 'sess-target' ? target : baseline]),
      ...overrides,
    });
  }

  async function run(state: ServerState): Promise<ToolResult> {
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));
    return callTool(tools, {
      pipeline: 'session.readiness',
      sessionId: 'sess-target',
      baselineSessionId: 'sess-baseline',
    });
  }

  it('activates fully against a CALIBRATED baseline', async () => {
    // Arrange
    const state = stateFor({ getBaseline: vi.fn(async () => makeBaselineRow('CALIBRATED', 0.9)) });

    // Act
    const body = parsePayload(await run(state)) as GatedReadiness;

    // Assert
    expect(body.gate.activation).toBe('full');
    expect(body.gate.observedState).toBe('CALIBRATED');
    expect(body.readiness).toEqual({ zone: 'green' });
  });

  it('still answers, flagged degraded, when the baseline only knows the movement shape', async () => {
    // Arrange
    const state = stateFor({ getBaseline: vi.fn(async () => makeBaselineRow('SHAPE_ONLY', 0.3)) });

    // Act
    const body = parsePayload(await run(state)) as GatedReadiness;

    // Assert: degraded means hedged, NOT missing
    expect(body.gate.activation).toBe('degraded');
    expect(body.readiness).toEqual({ zone: 'green' });
    expect(body.gate.userMessage.length).toBeGreaterThan(0);
  });

  it('withholds the estimate but still reports both observed velocities with no baseline row', async () => {
    // Arrange
    const state = stateFor({ getBaseline: vi.fn(async () => undefined) });

    // Act
    const result = await run(state);
    const body = parsePayload(result) as GatedReadiness;

    // Assert: inconclusive, not an error
    expect(result.isError).toBeUndefined();
    expect(body.readiness).toBeNull();
    expect(body.gate.evaluable).toBe(false);
    expect(typeof body.observed.actualVelocityMps).toBe('number');
    expect(typeof body.observed.baselineVelocityMps).toBe('number');
  });

  it('does not compute a readiness estimate at all when the gate withholds', async () => {
    // Arrange
    const state = stateFor({ getBaseline: vi.fn(async () => makeBaselineRow('COLD', 0)) });

    // Act
    const body = parsePayload(await run(state)) as GatedReadiness;

    // Assert
    expect(body.gate.activation).toBe('withheld');
    expect(body.readiness).toBeNull();
    expect(readinessSpy).not.toHaveBeenCalled();
  });

  it('withholds rather than throwing when the baseline session names no exercise', async () => {
    // Arrange: no exerciseId means no key to look a baseline up under
    const state = stateFor({
      getSession: vi.fn(async (id: string) =>
        id === 'sess-baseline' ? makeSession(id, null) : makeSession(id),
      ),
      getBaseline: vi.fn(async () => makeBaselineRow('CALIBRATED', 0.9)),
    });

    // Act
    const result = await run(state);
    const body = parsePayload(result) as GatedReadiness;

    // Assert
    expect(result.isError).toBeUndefined();
    expect(body.gate.evaluable).toBe(false);
    expect(body.gate.activation).toBe('withheld');
    expect(body.readiness).toBeNull();
    expect(readinessSpy).not.toHaveBeenCalled();
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

// ─── vbt.rir (VW-134) ─────────────────────────────────────────────────────

/** The `vbt.rir` response, mirrored for assertions (the impl's type is private). */
interface RirAxis {
  axis: string;
  level: string;
  reasoning: string;
  userMessage: string;
  improvementPath: string;
}
interface RirRep {
  repIndex: number;
  rir: number;
  range: { low: number; high: number };
  confidence: string;
  peakVelocity: number;
  velocityLossPct: number;
}
interface RirPayload {
  final: RirRep;
  perRep: RirRep[];
  baselineMaxVelocity: number;
  repsInSet: { value: number; source: string };
  confidence: {
    modelCalibration: RirAxis;
    inputDomain: RirAxis;
    baselineMaturity: FeatureGateVerdict;
  };
}

describe('metrics.compute — vbt.rir', () => {
  /** Register the tool against a state and hand back the captured handlers. */
  function registerAndCapture(state: ServerState): Map<string, RegisteredHandler> {
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));
    return tools;
  }

  /** A set whose reps SLOW DOWN, so velocity loss is real rather than zero. */
  function decayingSet(id: string, peaks: number[]): StoredSet {
    const base = makeSet(id);
    return {
      ...base,
      exerciseId: 'bench-press',
      reps: peaks.map((peak, i) => ({
        ...makeRep(id, i),
        concentric: { ...EMPTY_PHASE, peakVelocity: peak },
      })),
    };
  }

  const PEAKS = [0.8, 0.7, 0.6, 0.45];

  it('estimates every rep and reports the final rep as the headline', async () => {
    const set = decayingSet('set-rir', PEAKS);
    const state = makeStateWithStore({ getSet: vi.fn(async () => set) });
    const tools = registerAndCapture(state);

    const payload = await callTool(tools, { pipeline: 'vbt.rir', setId: 'set-rir' });
    const body = parsePayload(payload) as RirPayload;

    expect(body.perRep).toHaveLength(PEAKS.length);
    expect(body.perRep.map((r) => r.repIndex)).toEqual([1, 2, 3, 4]);
    expect(body.final).toEqual(body.perRep[PEAKS.length - 1]);
    // Baseline is the set's FASTEST rep, not rep 1's -- here they coincide, so
    // assert the value rather than the position.
    expect(body.baselineMaxVelocity).toBeCloseTo(0.8, 6);
  });

  it('derives velocity loss from the set peak, rising as the reps slow', async () => {
    const set = decayingSet('set-rir', PEAKS);
    const state = makeStateWithStore({ getSet: vi.fn(async () => set) });
    const tools = registerAndCapture(state);

    const body = parsePayload(
      await callTool(tools, { pipeline: 'vbt.rir', setId: 'set-rir' }),
    ) as RirPayload;

    const losses = body.perRep.map((r) => r.velocityLossPct);
    expect(losses[0]).toBeCloseTo(0, 6); // the fastest rep has lost nothing
    expect(losses[3]).toBeCloseTo(((0.8 - 0.45) / 0.8) * 100, 6);
    for (let i = 1; i < losses.length; i++) expect(losses[i]).toBeGreaterThan(losses[i - 1]);
  });

  it('uses the set peak as baseline even when rep 1 is a slow engagement artifact', async () => {
    // Rep 1 crawls (cable takeup); the real work starts at rep 2. Anchoring on
    // rep 1 would make every later rep look faster than baseline.
    const set = decayingSet('set-rir', [0.05, 0.9, 0.8, 0.6]);
    const state = makeStateWithStore({ getSet: vi.fn(async () => set) });
    const tools = registerAndCapture(state);

    const body = parsePayload(
      await callTool(tools, { pipeline: 'vbt.rir', setId: 'set-rir' }),
    ) as RirPayload;

    expect(body.baselineMaxVelocity).toBeCloseTo(0.9, 6);
    // Every loss stays non-negative -- nothing is "faster than the baseline".
    for (const r of body.perRep) expect(r.velocityLossPct).toBeGreaterThanOrEqual(0);
  });

  it('names all three confidence axes and never returns a bare number', async () => {
    const set = decayingSet('set-rir', PEAKS);
    const state = makeStateWithStore({ getSet: vi.fn(async () => set) });
    const tools = registerAndCapture(state);

    const body = parsePayload(
      await callTool(tools, { pipeline: 'vbt.rir', setId: 'set-rir' }),
    ) as RirPayload;

    expect(body.confidence.modelCalibration.axis).toBe('model-calibration');
    expect(body.confidence.inputDomain.axis).toBe('input-domain');
    expect(body.confidence.baselineMaturity.feature).toBe('rir-estimate');
    // The model axis is a property of the shipped coefficients, not the user.
    expect(body.confidence.modelCalibration.level).toBe('low');
    // Populated at every level, per VW-151 -- including the improvement path.
    for (const axis of [body.confidence.modelCalibration, body.confidence.inputDomain]) {
      expect(axis.userMessage.length).toBeGreaterThan(0);
      expect(axis.improvementPath.length).toBeGreaterThan(0);
    }
  });

  it('STILL SHIPS the estimate when the baseline gate withholds (B57 is advisory)', async () => {
    // No baseline row at all -> the gate withholds. The number must survive:
    // silence reads as breakage, a hedge reads as honesty.
    const set = decayingSet('set-rir', PEAKS);
    const state = makeStateWithStore({
      getSet: vi.fn(async () => set),
      getBaseline: vi.fn(async () => undefined),
    });
    const tools = registerAndCapture(state);

    const body = parsePayload(
      await callTool(tools, { pipeline: 'vbt.rir', setId: 'set-rir' }),
    ) as RirPayload;

    expect(body.confidence.baselineMaturity.activation).toBe('withheld');
    expect(body.confidence.baselineMaturity.evaluable).toBe(false);
    expect(typeof body.final.rir).toBe('number');
    expect(body.perRep).toHaveLength(PEAKS.length);
  });

  it('grades the gate off the set exercise when a calibrated baseline exists', async () => {
    const set = decayingSet('set-rir', PEAKS);
    const state = makeStateWithStore({
      getSet: vi.fn(async () => set),
      getBaseline: vi.fn(async () => makeBaselineRow('CALIBRATED', 0.9)),
    });
    const tools = registerAndCapture(state);

    const body = parsePayload(
      await callTool(tools, { pipeline: 'vbt.rir', setId: 'set-rir' }),
    ) as RirPayload;

    expect(body.confidence.baselineMaturity.evaluable).toBe(true);
    expect(body.confidence.baselineMaturity.activation).not.toBe('withheld');
  });

  it('reports the set as unevaluable when it names no exercise', async () => {
    const { exerciseId: _dropped, ...noExercise } = decayingSet('set-rir', PEAKS);
    const state = makeStateWithStore({ getSet: vi.fn(async () => noExercise as StoredSet) });
    const tools = registerAndCapture(state);

    const body = parsePayload(
      await callTool(tools, { pipeline: 'vbt.rir', setId: 'set-rir' }),
    ) as RirPayload;

    // "We never looked" -- not the same as a graded-and-thin baseline.
    expect(body.confidence.baselineMaturity.evaluable).toBe(false);
  });

  it('records where repsInSet came from, and honours a supplied targetReps', async () => {
    const set = decayingSet('set-rir', PEAKS);
    const state = makeStateWithStore({ getSet: vi.fn(async () => set) });
    const tools = registerAndCapture(state);

    const implied = parsePayload(
      await callTool(tools, { pipeline: 'vbt.rir', setId: 'set-rir' }),
    ) as RirPayload;
    expect(implied.repsInSet).toEqual({ value: 4, source: 'actualRepCount' });

    const targeted = parsePayload(
      await callTool(tools, { pipeline: 'vbt.rir', setId: 'set-rir', targetReps: 10 }),
    ) as RirPayload;
    expect(targeted.repsInSet).toEqual({ value: 10, source: 'targetReps' });
    // A set cut short of its target is not read as one taken to the end, so
    // the rep-progress term differs and the estimate moves.
    expect(targeted.final.rir).not.toBeCloseTo(implied.final.rir, 6);
  });

  it('returns NOT_FOUND for a missing set, and for a set with no reps', async () => {
    const missing = makeStateWithStore();
    expect(
      await callTool(registerAndCapture(missing), { pipeline: 'vbt.rir', setId: 'nope' }),
    ).toMatchObject({ isError: true });

    const empty = { ...makeSet('set-empty'), reps: [] };
    const noReps = makeStateWithStore({ getSet: vi.fn(async () => empty) });
    expect(
      await callTool(registerAndCapture(noReps), { pipeline: 'vbt.rir', setId: 'set-empty' }),
    ).toMatchObject({ isError: true });
  });
});

// Reference textResult import to keep the dependency obvious for AC-20.
void textResult;
// Reference unused fixture types so removing them later breaks the build.
void (null as unknown as StoredSession);
