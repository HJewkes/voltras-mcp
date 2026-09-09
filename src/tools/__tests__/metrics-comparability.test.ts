// VW-94: the `comparability` block on `session.readiness` and
// `session.strength`.
//
// Kept out of `metrics-tools.test.ts` because these cases are about ONE
// cross-cutting concern rather than one pipeline's dispatch, and the fixtures
// they need (sets that differ by a single context field) are unlike the
// dispatch fixtures there.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
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
import type { StoredRep, StoredSession, StoredSet } from '../../store/types.js';
import type { ComparabilityReport } from '../../analytics/comparability.js';
import { setupRowId } from '../../store/exercise-setups.js';
import type { ToolResult } from '../helpers.js';

const EMPTY_PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  duration: 0,
  _totalVelocity: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

function makeRep(setId: string): StoredRep {
  return {
    id: `${setId}-rep-0`,
    setId,
    index: 0,
    repNumber: 1,
    concentric: { ...EMPTY_PHASE },
    eccentric: { ...EMPTY_PHASE },
  };
}

function makeSet(id: string, sessionId: string, overrides: Partial<StoredSet> = {}): StoredSet {
  return {
    id,
    sessionId,
    startedAt: '2026-09-01T00:00:00.000Z',
    endedAt: '2026-09-01T00:00:30.000Z',
    partial: false,
    exerciseId: 'bench-press',
    trainingMode: 'WeightTraining',
    settingsHash: 'v1:aaaa',
    weightLbs: 170,
    reps: [makeRep(id)],
    ...overrides,
  };
}

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

function makeState(setsBySession: Record<string, StoredSet[]>): ServerState {
  const store = {
    getSet: vi.fn(async () => undefined),
    getSetsForSession: vi.fn(async (id: string) => setsBySession[id] ?? []),
    getSession: vi.fn(
      async (id: string): Promise<StoredSession> => ({
        id,
        startedAt: '2026-09-01T00:00:00.000Z',
        exerciseId: 'bench-press',
      }),
    ),
    getBaseline: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => []),
    // VW-211: the comparability v2 subject writers read these two for
    // `exerciseIntroducedAt`/`trackedTrainingMonths`. Empty/null are the
    // honest defaults — no test here asserts on those two fields' content.
    getSetsForExercise: vi.fn(async () => []),
    getSessionDateSpan: vi.fn(async () => ({ first: null, last: null })),
    // VW-150: no phase declared, which is what every pair here compares under.
    getSessionDietPhase: vi.fn(async () => undefined),
    putSession: vi.fn(async () => undefined),
    putSet: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const exercises = { getById: vi.fn(() => undefined) };
  return { store, exercises } as unknown as ServerState;
}

async function compute(state: ServerState, args: unknown): Promise<unknown> {
  const { server, tools } = makeFakeServer();
  registerMetricsTools(server, state, makePlaceholders(server));
  const reg = tools.get('metrics.compute');
  if (!reg) throw new Error('metrics.compute not registered');
  const result = await reg.callback(args);
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0]?.text ?? '{}') as unknown;
}

interface ReadinessPayload {
  observed: { baselineVelocityMps: number };
  comparability: ComparabilityReport;
}

describe('session.readiness comparability (VW-94)', () => {
  let velocitySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // One distinct velocity per set, keyed off the rep's own set id, so the
    // response shows WHICH baseline set the predicate picked.
    velocitySpy = vi
      .spyOn(analytics, 'getSetFirstRepVelocity')
      .mockImplementation((set: analytics.Set) =>
        set.reps[0]?.setId === 'base-working' ? 0.9 : 0.4,
      );
  });
  afterEach(() => velocitySpy.mockRestore());

  it('skips a warm-up and compares against the like-vs-like working set', async () => {
    const state = makeState({
      'sess-target': [makeSet('target-1', 'sess-target')],
      'sess-baseline': [
        makeSet('base-warmup', 'sess-baseline', { setPurpose: 'warmup', weightLbs: 95 }),
        makeSet('base-working', 'sess-baseline'),
      ],
    });

    const payload = (await compute(state, {
      pipeline: 'session.readiness',
      sessionId: 'sess-target',
      baselineSessionId: 'sess-baseline',
    })) as ReadinessPayload;

    expect(payload.comparability.comparedTo?.setId).toBe('base-working');
    expect(payload.observed.baselineVelocityMps).toBe(0.9);
    // VW-205: the B16 v2 claim clauses reach the surface through `reasons`,
    // and none of them withheld a comparison this pipeline is entitled to.
    expect(payload.comparability.comparedTo?.reasons.join(' ')).toContain('profile (note):');
    expect(payload.comparability.comparedTo?.reasons.join(' ')).toContain('corroboration (note):');
    expect(payload.comparability.comparedTo?.reasons.join(' ')).toContain('trainingAge (note):');
  });

  it('reports noValidComparison with the nearest candidate rather than staying silent', async () => {
    const state = makeState({
      'sess-target': [makeSet('target-1', 'sess-target')],
      'sess-baseline': [
        makeSet('base-settings-changed', 'sess-baseline', {
          settingsHash: 'v1:bbbb',
          weightLbs: 120,
        }),
        makeSet('base-near', 'sess-baseline', { weightLbs: 175 }),
      ],
    });

    const payload = (await compute(state, {
      pipeline: 'session.readiness',
      sessionId: 'sess-target',
      baselineSessionId: 'sess-baseline',
    })) as ReadinessPayload;

    expect(payload.comparability.noValidComparison).toBe(true);
    expect(payload.comparability.comparedTo).toBeUndefined();
    expect(payload.comparability.nearest?.setId).toBe('base-near');
    expect(payload.comparability.nearest?.reasons.join(' ')).toContain(
      'different load (170 vs 175 lb)',
    );
    expect(payload.comparability.nearest?.reasons.join(' ')).toContain('trainingAge (note):');
    // The pipeline still answered — the fallback baseline set was used.
    expect(payload.observed.baselineVelocityMps).toBe(0.4);
  });

  it('fills all four v2 subject fields with real readings, not "unrecorded" (VW-211)', async () => {
    const state = makeState({
      'sess-target': [
        makeSet('target-1', 'sess-target', { startedAt: '2026-09-01T00:00:00.000Z' }),
        makeSet('target-2', 'sess-target', { startedAt: '2026-09-01T00:05:00.000Z' }),
      ],
      'sess-baseline': [makeSet('base-1', 'sess-baseline', { lifter: 'Jordan' })],
    });
    // Keyed by lifter so the owner's target and Jordan's baseline set resolve
    // DIFFERENT contexts despite sharing an exerciseId — the same way two
    // real lifters' histories would.
    state.store.getSetsForExercise = vi.fn(async (filter: { lifter?: string }) =>
      filter.lifter === 'Jordan'
        ? [makeSet('hist-jordan', 'sess-old-j', { startedAt: '2026-06-01T00:00:00.000Z' })]
        : [makeSet('hist-owner', 'sess-old-o', { startedAt: '2026-01-01T00:00:00.000Z' })],
    );
    state.store.getSessionDateSpan = vi.fn(async (filter: { lifter?: string }) =>
      filter.lifter === 'Jordan'
        ? { first: '2026-08-01T00:00:00.000Z', last: null }
        : { first: '2025-01-01T00:00:00.000Z', last: null },
    );
    state.store.listSessions = vi.fn(async (filter: { lifter?: string }) =>
      filter.lifter === 'Jordan'
        ? [{ id: 'sess-j', startedAt: '2026-08-05T00:00:00.000Z', exerciseId: 'incline-press' }]
        : [
            { id: 'sess-o1', startedAt: '2026-08-05T00:00:00.000Z', exerciseId: 'incline-press' },
            { id: 'sess-o2', startedAt: '2026-08-10T00:00:00.000Z', exerciseId: 'shoulder-press' },
          ],
    );
    state.exercises.getById = vi.fn((id: string) =>
      id === 'bench-press' || id === 'incline-press'
        ? ({ muscleGroups: ['chest'] } as never)
        : id === 'shoulder-press'
          ? ({ muscleGroups: ['shoulders'] } as never)
          : undefined,
    );

    const payload = (await compute(state, {
      pipeline: 'session.readiness',
      sessionId: 'sess-target',
      baselineSessionId: 'sess-baseline',
    })) as ReadinessPayload;

    const reasons = (
      payload.comparability.comparedTo?.reasons ??
      payload.comparability.nearest?.reasons ??
      []
    ).join(' ');

    // profile (b): target's own first set is index 1 of 2, compared against
    // baseline's only set (also index 1) — a real position, not "unrecorded".
    expect(reasons).toContain('both sides are set 1 of their exercise');
    // swap (e): owner vs Jordan resolve different programme-entry dates.
    expect(reasons).toContain(
      'different programme entry date for this exercise (2026-01-01T00:00:00.000Z vs 2026-06-01T00:00:00.000Z)',
    );
    expect(reasons).not.toContain('neither set records a programme entry date');
    // corroboration (d): both sides see 2 chest exercises (bench + incline).
    expect(reasons).toContain('2 corroborating exercises for this muscle (2 vs 2)');
    expect(reasons).not.toContain('neither set records how many exercises');
    // trainingAge (f): Jordan's 1 tracked month is inside the neural window.
    expect(reasons).toContain('tracked training in months: 19 vs 1');
    expect(reasons).not.toContain('neither set records how many months');
  });
});

interface StrengthPayload {
  estimated1RM: number;
  comparability: ComparabilityReport & { anchorSetId: string };
}

describe('session.strength comparability (VW-94)', () => {
  it('anchors on the heaviest set and names a pooled set that is not like-for-like', async () => {
    const state = makeState({
      'sess-S': [
        makeSet('s1', 'sess-S', { weightLbs: 140 }),
        makeSet('s2', 'sess-S', { weightLbs: 170, settingsHash: 'v1:cccc' }),
      ],
    });

    const payload = (await compute(state, {
      pipeline: 'session.strength',
      sessionId: 'sess-S',
    })) as StrengthPayload;

    expect(payload.comparability.anchorSetId).toBe('s2');
    expect(payload.comparability.noValidComparison).toBe(true);
    expect(payload.comparability.nearest?.setId).toBe('s1');
    expect(typeof payload.estimated1RM).toBe('number');
  });

  it('reports the pooled set it compared against when the session is one context', async () => {
    const state = makeState({
      'sess-S': [makeSet('s1', 'sess-S'), makeSet('s2', 'sess-S')],
    });

    const payload = (await compute(state, {
      pipeline: 'session.strength',
      sessionId: 'sess-S',
    })) as StrengthPayload;

    expect(payload.comparability.anchorSetId).toBe('s1');
    expect(payload.comparability.comparedTo?.setId).toBe('s2');
    // VW-205: `session.strength` is the surface closest to a growth claim, so
    // the B16 v2 notes must reach it unchanged.
    expect(payload.comparability.comparedTo?.reasons.join(' ')).toContain('trainingAge (note):');
  });

  it('reads the VW-119 setup stamp off the stored set and splits on it', async () => {
    const key = { userId: 'local', exerciseId: 'bench-press', side: 'right' } as const;
    const state = makeState({
      'sess-S': [
        makeSet('s1', 'sess-S', { setupId: setupRowId(key, 0) }),
        makeSet('s2', 'sess-S', { setupId: setupRowId(key, 1) }),
      ],
    });

    const payload = (await compute(state, {
      pipeline: 'session.strength',
      sessionId: 'sess-S',
    })) as StrengthPayload;

    expect(payload.comparability.noValidComparison).toBe(true);
    expect(payload.comparability.nearest?.reasons.join(' ')).toContain('different physical setup');
  });

  it('fills all four v2 subject fields with real readings, not "unrecorded" (VW-211)', async () => {
    const state = makeState({
      'sess-S': [
        makeSet('s1', 'sess-S', { weightLbs: 140 }),
        makeSet('s2', 'sess-S', {
          weightLbs: 170,
          startedAt: '2026-09-01T00:05:00.000Z',
          lifter: 'Jordan',
        }),
      ],
    });
    // Keyed by lifter so the owner's s1 and Jordan's s2 resolve DIFFERENT
    // contexts despite sharing an exerciseId — as two real lifters would.
    state.store.getSetsForExercise = vi.fn(async (filter: { lifter?: string }) =>
      filter.lifter === 'Jordan'
        ? [makeSet('hist-jordan', 'sess-old-j', { startedAt: '2026-06-01T00:00:00.000Z' })]
        : [makeSet('hist-owner', 'sess-old-o', { startedAt: '2026-01-01T00:00:00.000Z' })],
    );
    state.store.getSessionDateSpan = vi.fn(async (filter: { lifter?: string }) =>
      filter.lifter === 'Jordan'
        ? { first: '2026-08-01T00:00:00.000Z', last: null }
        : { first: '2025-01-01T00:00:00.000Z', last: null },
    );
    state.store.listSessions = vi.fn(async (filter: { lifter?: string }) =>
      filter.lifter === 'Jordan'
        ? [{ id: 'sess-j', startedAt: '2026-08-05T00:00:00.000Z', exerciseId: 'incline-press' }]
        : [
            { id: 'sess-o1', startedAt: '2026-08-05T00:00:00.000Z', exerciseId: 'incline-press' },
            { id: 'sess-o2', startedAt: '2026-08-10T00:00:00.000Z', exerciseId: 'shoulder-press' },
          ],
    );
    state.exercises.getById = vi.fn((id: string) =>
      id === 'bench-press' || id === 'incline-press'
        ? ({ muscleGroups: ['chest'] } as never)
        : id === 'shoulder-press'
          ? ({ muscleGroups: ['shoulders'] } as never)
          : undefined,
    );

    const payload = (await compute(state, {
      pipeline: 'session.strength',
      sessionId: 'sess-S',
    })) as StrengthPayload;

    expect(payload.comparability.anchorSetId).toBe('s2');
    const reasons = (
      payload.comparability.comparedTo?.reasons ??
      payload.comparability.nearest?.reasons ??
      []
    ).join(' ');

    // profile (b): the anchor (s2) is the session's SECOND set by startedAt,
    // compared against s1's first — a real position, not "unrecorded".
    expect(reasons).toContain('set 2 compared against set 1 of their exercise');
    // swap (e): owner vs Jordan resolve different programme-entry dates.
    expect(reasons).toContain(
      'different programme entry date for this exercise (2026-06-01T00:00:00.000Z vs 2026-01-01T00:00:00.000Z)',
    );
    expect(reasons).not.toContain('neither set records a programme entry date');
    // corroboration (d): Jordan's own exercise (bench-press) sees 2 chest
    // exercises; s1's owner history sees the same 2.
    expect(reasons).toContain('2 corroborating exercises for this muscle (2 vs 2)');
    expect(reasons).not.toContain('neither set records how many exercises');
    // trainingAge (f): Jordan's 1 tracked month is inside the neural window.
    expect(reasons).toContain('tracked training in months: 1 vs 19');
    expect(reasons).not.toContain('neither set records how many months');
  });
});
