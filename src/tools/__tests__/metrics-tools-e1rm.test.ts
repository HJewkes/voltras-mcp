// `metrics.compute strength.e1rm` — VW-142 wiring.
//
// Three input shapes on one pipeline: `{ load, reps }` (Epley, no gate),
// `{ exerciseId }` (profile-based, gated on `relative-signal`), and both
// (hybrid). This file pins the tool-layer plumbing — which analytics
// function each shape dispatches to, and the gate's degrade-never-block
// behaviour — not the formulas themselves (those are workout-analytics'
// own unit tests).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Phase } from '@voltras/workout-analytics';
import * as analytics from '@voltras/workout-analytics';

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
import type { FeatureGateVerdict } from '../../store/baseline-gate.js';
import type {
  BaselineState,
  StoredExerciseBaseline,
  StoredRep,
  StoredSet,
} from '../../store/types.js';
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

function makeSet(id: string, weightLbs: number | undefined, exerciseId = 'back-squat'): StoredSet {
  return {
    id,
    sessionId: 'sess-1',
    startedAt: '2026-09-08T00:00:00.000Z',
    endedAt: '2026-09-08T00:00:30.000Z',
    partial: false,
    trainingMode: 'WeightTraining',
    ...(weightLbs !== undefined ? { weightLbs } : {}),
    exerciseId,
    reps: [makeRep(id, 0), makeRep(id, 1)],
  };
}

function makeBaselineRow(state: BaselineState, exerciseId = 'back-squat'): StoredExerciseBaseline {
  return {
    id: `local|${exerciseId}`,
    userId: 'local',
    exerciseId,
    state,
    confidence: 0.5,
    observedSessions: 3,
    anchorCount: 0,
    updatedAt: '2026-09-08T00:00:00.000Z',
    algorithmVersion: 'baseline@1.0.0',
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

interface StoreOverrides {
  getSetsForExercise?: (filter: { exerciseId: string }) => Promise<StoredSet[]>;
  getBaseline?: () => Promise<StoredExerciseBaseline | undefined>;
}

function makeState(overrides: StoreOverrides = {}): ServerState {
  const store = {
    getSetsForExercise: vi.fn(overrides.getSetsForExercise ?? (async () => [])),
    getBaseline: vi.fn(overrides.getBaseline ?? (async () => undefined)),
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

interface E1RMBody {
  method: 'reps' | 'profile' | 'hybrid';
  estimate: { e1RM: number; confidence: number; method: string } | null;
  gate: FeatureGateVerdict | null;
}

describe('metrics.compute — strength.e1rm', () => {
  let repsSpy: ReturnType<typeof vi.spyOn>;
  let profileSpy: ReturnType<typeof vi.spyOn>;
  let buildSpy: ReturnType<typeof vi.spyOn>;
  let hybridSpy: ReturnType<typeof vi.spyOn>;
  let velSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    repsSpy = vi
      .spyOn(analytics, 'estimateE1RMFromReps')
      .mockReturnValue({ e1RM: 116.7, confidence: 0.8, method: 'reps' });
    profileSpy = vi
      .spyOn(analytics, 'estimateE1RMFromProfile')
      .mockReturnValue({ e1RM: 220, confidence: 0.7, method: 'profile' });
    hybridSpy = vi
      .spyOn(analytics, 'estimateHybridE1RM')
      .mockReturnValue({ e1RM: 200, confidence: 0.75, method: 'hybrid' });
    buildSpy = vi.spyOn(analytics, 'buildProfile').mockReturnValue({
      dataPoints: [],
      slope: -0.01,
      intercept: 1.2,
      rSquared: 0.95,
      estimated1RM: 220,
      confidence: 'high',
      mvt: 0.17,
    });
    velSpy = vi.spyOn(analytics, 'getSetMeanVelocity').mockReturnValue(0.5);
  });
  afterEach(() => {
    repsSpy.mockRestore();
    profileSpy.mockRestore();
    hybridSpy.mockRestore();
    buildSpy.mockRestore();
    velSpy.mockRestore();
  });

  it('reps-only: dispatches to estimateE1RMFromReps, no gate, no store read', async () => {
    const state = makeState();
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'strength.e1rm', load: 135, reps: 5 });

    expect(repsSpy).toHaveBeenCalledWith(135, 5);
    expect(state.store.getSetsForExercise).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(parsePayload(result)).toEqual({
      method: 'reps',
      estimate: { e1RM: 116.7, confidence: 0.8, method: 'reps' },
      gate: null,
    });
  });

  it('profile-only, CALIBRATED baseline: gate full, estimate answers', async () => {
    const sets = [makeSet('s-a', 100), makeSet('s-b', 150)];
    const state = makeState({
      getSetsForExercise: async () => sets,
      getBaseline: async () => makeBaselineRow('CALIBRATED'),
    });
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'strength.e1rm', exerciseId: 'back-squat' });

    expect(state.store.getSetsForExercise).toHaveBeenCalledWith(
      expect.objectContaining({ exerciseId: 'back-squat', purpose: ['working'] }),
    );
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(profileSpy).toHaveBeenCalledTimes(1);
    const body = parsePayload(result) as E1RMBody;
    expect(body.method).toBe('profile');
    expect(body.estimate).toEqual({ e1RM: 220, confidence: 0.7, method: 'profile' });
    expect(body.gate?.activation).toBe('full');
  });

  it('profile-only, no baseline row: gate withholds, estimate is null but the response still answers', async () => {
    const sets = [makeSet('s-a', 100), makeSet('s-b', 150)];
    const state = makeState({ getSetsForExercise: async () => sets });
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'strength.e1rm', exerciseId: 'back-squat' });

    expect(profileSpy).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    const body = parsePayload(result) as E1RMBody;
    expect(body.method).toBe('profile');
    expect(body.estimate).toBeNull();
    expect(body.gate?.activation).toBe('withheld');
    expect(body.gate?.userMessage.length).toBeGreaterThan(0);
  });

  it('profile-only: fewer than 2 weighted sets → NOT_FOUND, buildProfile not called', async () => {
    const state = makeState({ getSetsForExercise: async () => [makeSet('s-a', 100)] });
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'strength.e1rm', exerciseId: 'back-squat' });

    expect(buildSpy).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect((parsePayload(result) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('hybrid: both fields present, gate full → estimateHybridE1RM combines both estimates', async () => {
    const sets = [makeSet('s-a', 100), makeSet('s-b', 150)];
    const state = makeState({
      getSetsForExercise: async () => sets,
      getBaseline: async () => makeBaselineRow('CALIBRATED'),
    });
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, {
      pipeline: 'strength.e1rm',
      load: 135,
      reps: 5,
      exerciseId: 'back-squat',
    });

    expect(repsSpy).toHaveBeenCalledWith(135, 5);
    expect(profileSpy).toHaveBeenCalledTimes(1);
    expect(hybridSpy).toHaveBeenCalledWith(
      { e1RM: 220, confidence: 0.7, method: 'profile' },
      { e1RM: 116.7, confidence: 0.8, method: 'reps' },
    );
    const body = parsePayload(result) as E1RMBody;
    expect(body.method).toBe('hybrid');
    expect(body.estimate).toEqual({ e1RM: 200, confidence: 0.75, method: 'hybrid' });
    expect(body.gate?.activation).toBe('full');
  });

  it('hybrid: gate withholds → estimate null, estimateHybridE1RM not called, reps side still computed', async () => {
    const sets = [makeSet('s-a', 100), makeSet('s-b', 150)];
    const state = makeState({ getSetsForExercise: async () => sets });
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, {
      pipeline: 'strength.e1rm',
      load: 135,
      reps: 5,
      exerciseId: 'back-squat',
    });

    expect(repsSpy).toHaveBeenCalledWith(135, 5);
    expect(profileSpy).not.toHaveBeenCalled();
    expect(hybridSpy).not.toHaveBeenCalled();
    const body = parsePayload(result) as E1RMBody;
    expect(body.method).toBe('hybrid');
    expect(body.estimate).toBeNull();
    expect(body.gate?.activation).toBe('withheld');
  });

  it('invalid: a lone `load` with no `reps` and no `exerciseId` is refused', async () => {
    const state = makeState();
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'strength.e1rm', load: 135 });

    expect(result.isError).toBe(true);
    expect((parsePayload(result) as { code: string }).code).toBe('INVALID_INPUT');
    expect(repsSpy).not.toHaveBeenCalled();
    expect(state.store.getSetsForExercise).not.toHaveBeenCalled();
  });

  it('invalid: a lone `reps` with no `load` is refused', async () => {
    const state = makeState();
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'strength.e1rm', reps: 5 });

    expect(result.isError).toBe(true);
    expect((parsePayload(result) as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('invalid: no fields at all is refused', async () => {
    const state = makeState();
    const { server, tools } = makeFakeServer();
    registerMetricsTools(server, state, makePlaceholders(server));

    const result = await callTool(tools, { pipeline: 'strength.e1rm' });

    expect(result.isError).toBe(true);
    expect((parsePayload(result) as { code: string }).code).toBe('INVALID_INPUT');
  });
});
