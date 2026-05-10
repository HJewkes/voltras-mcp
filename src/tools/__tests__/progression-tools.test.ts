// Unit tests for src/tools/progression-tools.ts.
//
// Covers the `progression.get_for_exercise` handler at the tool boundary:
//   * Schema validation (INVALID_INPUT paths)
//   * lookbackWeeks default (8) and limit default (20)
//   * MAX_LOOKBACK_WEEKS=52 enforced by schema — 53 returns INVALID_INPUT
//   * exerciseId filter forwarded to the store
//   * limit applied correctly when > N sessions match
//   * Full response shape on happy path
//
// The `SessionStore` is faked in-memory; the `aggregateProgression` pure
// function is exercised indirectly (aggregator unit tests cover edge cases).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerState } from '../../state/server-state.js';
import type {
  SessionListFilter,
  SessionStore,
  StoredSession,
  StoredSet,
} from '../../store/types.js';
import type { Rep } from '@voltras/workout-analytics';

// node-sdk mock required because session-tools imports from it indirectly via
// server-state, but progression-tools itself does not. We keep the mock here
// for consistency with the test environment setup used across tool test files.
vi.mock('@voltras/node-sdk', () => {
  class FakeVoltraSDKError extends Error {
    readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'VoltraSDKError';
      this.code = code;
    }
  }
  return {
    VoltraSDKError: FakeVoltraSDKError,
    TrainingMode: {},
    TrainingModeNames: {},
  };
});

const { registerProgressionTools } = await import('../progression-tools.js');

// ── Shared types ─────────────────────────────────────────────────────────────

interface FakeRegisteredTool {
  callback?: (args: unknown, extra?: unknown) => Promise<unknown>;
  update(updates: {
    paramsSchema: unknown;
    callback: (args: unknown, extra?: unknown) => Promise<unknown>;
  }): void;
  remove(): void;
}

function makeFakePlaceholders(names: string[]): {
  placeholders: Map<string, FakeRegisteredTool>;
  invokers: Record<
    string,
    (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>
  >;
} {
  const placeholders = new Map<string, FakeRegisteredTool>();
  for (const name of names) {
    const tool: FakeRegisteredTool = {
      update(updates) {
        tool.callback = updates.callback;
      },
      remove() {
        /* unused */
      },
    };
    placeholders.set(name, tool);
  }
  const invokers: Record<
    string,
    (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>
  > = {};
  for (const name of names) {
    invokers[name] = async (args: unknown) => {
      const cb = placeholders.get(name)?.callback;
      if (!cb) throw new Error(`no callback installed for ${name}`);
      return cb(args) as Promise<{ content: { text: string }[]; isError?: boolean }>;
    };
  }
  return { placeholders, invokers };
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

function makeRep(repNumber: number): Rep {
  const phase = {
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
  return { repNumber, concentric: phase, eccentric: phase };
}

function makeSet(id: string, sessionId: string, weightLbs: number, repCount: number): StoredSet {
  const reps = Array.from({ length: repCount }, (_, i) =>
    Object.assign(makeRep(i + 1), { id: `${id}-r${i + 1}`, setId: id, index: i }),
  );
  return {
    id,
    sessionId,
    startedAt: '2025-01-01T00:00:00.000Z',
    endedAt: '2025-01-01T00:05:00.000Z',
    partial: false,
    trainingMode: 'WeightTraining',
    weightLbs,
    reps,
  };
}

function makeSession(
  id: string,
  startedAt: string,
  exerciseId = 'cable-chest-press',
): StoredSession {
  return { id, startedAt, exerciseId };
}

function makeStore(
  sessions: StoredSession[],
  setMap: Record<string, StoredSet[]>,
): SessionStore & {
  listSessions: ReturnType<typeof vi.fn>;
  getSetsForSession: ReturnType<typeof vi.fn>;
} {
  return {
    putSession: vi.fn(async () => {}),
    putSet: vi.fn(async () => {}),
    getSession: vi.fn(async () => undefined),
    getSet: vi.fn(async () => undefined),
    listSessions: vi.fn(async (filter: SessionListFilter) => {
      let result = sessions.filter(
        (s) =>
          (filter.exerciseId === undefined || s.exerciseId === filter.exerciseId) &&
          (filter.from === undefined || s.startedAt >= filter.from) &&
          (filter.to === undefined || s.startedAt <= filter.to),
      );
      if (filter.sort === 'startedAt:asc') {
        result = result.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      } else {
        result = result.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      }
      result = result.slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 50));
      return result;
    }),
    getSetsForSession: vi.fn(async (sessionId: string) => setMap[sessionId] ?? []),
    close: vi.fn(async () => {}),
  };
}

const TOOL_NAME = 'progression.get_for_exercise';

interface Harness {
  invoke: (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  store: ReturnType<typeof makeStore>;
}

function setup(sessions: StoredSession[], setMap: Record<string, StoredSet[]>): Harness {
  const store = makeStore(sessions, setMap);
  const state = {
    config: {} as never,
    slots: new Map(),
    store,
    exercises: {} as never,
    manager: {} as never,
  } as unknown as ServerState;

  const { placeholders, invokers } = makeFakePlaceholders([TOOL_NAME]);
  const server = { tool: vi.fn() } as unknown as Parameters<typeof registerProgressionTools>[0];
  registerProgressionTools(server, state, placeholders as never);
  return { invoke: (args) => invokers[TOOL_NAME](args), store };
}

function parseResult(r: { content: { text: string }[] }): unknown {
  return JSON.parse(r.content[0].text);
}

// ── INVALID_INPUT paths ───────────────────────────────────────────────────────

describe('progression.get_for_exercise — input validation', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup([], {});
  });

  it('returns INVALID_INPUT when exerciseId is missing', async () => {
    const r = await h.invoke({});
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('returns INVALID_INPUT when exerciseId is an empty string', async () => {
    const r = await h.invoke({ exerciseId: '' });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('returns INVALID_INPUT when lookbackWeeks is 0', async () => {
    const r = await h.invoke({ exerciseId: 'cable-chest-press', lookbackWeeks: 0 });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('returns INVALID_INPUT when lookbackWeeks is 53 (above MAX_LOOKBACK_WEEKS=52)', async () => {
    const r = await h.invoke({ exerciseId: 'cable-chest-press', lookbackWeeks: 53 });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('accepts lookbackWeeks=52 (at max)', async () => {
    const r = await h.invoke({ exerciseId: 'cable-chest-press', lookbackWeeks: 52 });
    expect(r.isError).toBeUndefined();
  });

  it('returns INVALID_INPUT when limit is 0', async () => {
    const r = await h.invoke({ exerciseId: 'cable-chest-press', limit: 0 });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
  });
});

// ── Empty: exerciseId not found ───────────────────────────────────────────────

describe('progression.get_for_exercise — no matching sessions', () => {
  it('returns zero counts and null trend when exercise has no sessions', async () => {
    const h = setup([], {});
    const r = await h.invoke({ exerciseId: 'cable-chest-press' });
    expect(r.isError).toBeUndefined();

    const body = parseResult(r) as {
      exerciseId: string;
      sessionCount: number;
      sessions: unknown[];
      trend: null;
    };
    expect(body.exerciseId).toBe('cable-chest-press');
    expect(body.sessionCount).toBe(0);
    expect(body.sessions).toHaveLength(0);
    expect(body.trend).toBeNull();
  });
});

// ── exerciseId filter forwarded to store ─────────────────────────────────────

describe('progression.get_for_exercise — exerciseId forwarded', () => {
  it('passes exerciseId to listSessions filter', async () => {
    const sessions = [
      makeSession('s1', recentDate(14), 'cable-chest-press'),
      makeSession('s2', recentDate(7), 'squat'),
    ];
    const h = setup(sessions, { s1: [], s2: [] });

    await h.invoke({ exerciseId: 'cable-chest-press' });

    expect(h.store.listSessions).toHaveBeenCalledTimes(1);
    const filter = h.store.listSessions.mock.calls[0][0] as SessionListFilter;
    expect(filter.exerciseId).toBe('cable-chest-press');
  });
});

// ── limit truncates correctly ─────────────────────────────────────────────────

// Helpers that produce dates within the default 8-week lookback window.
function recentDate(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString();
}

describe('progression.get_for_exercise — limit', () => {
  it('forwards limit to the store and returns at most limit sessions', async () => {
    const sessions = Array.from({ length: 10 }, (_, i) =>
      makeSession(`s${i + 1}`, recentDate(7 + i)),
    );
    const setMap = Object.fromEntries(sessions.map((s) => [s.id, []]));
    const h = setup(sessions, setMap);

    const r = await h.invoke({ exerciseId: 'cable-chest-press', limit: 3 });
    expect(r.isError).toBeUndefined();

    const filter = h.store.listSessions.mock.calls[0][0] as SessionListFilter;
    expect(filter.limit).toBe(3);

    const body = parseResult(r) as { sessions: unknown[] };
    expect(body.sessions).toHaveLength(3);
  });

  it('defaults to limit=20 when not specified', async () => {
    const h = setup([], {});
    await h.invoke({ exerciseId: 'cable-chest-press' });
    const filter = h.store.listSessions.mock.calls[0][0] as SessionListFilter;
    expect(filter.limit).toBe(20);
  });
});

// ── lookbackWeeks default ─────────────────────────────────────────────────────

describe('progression.get_for_exercise — lookbackWeeks default', () => {
  it('defaults to 8 weeks lookback when not specified', async () => {
    const h = setup([], {});
    const before = new Date();
    await h.invoke({ exerciseId: 'cable-chest-press' });
    const after = new Date();

    const filter = h.store.listSessions.mock.calls[0][0] as SessionListFilter;
    const windowStart = new Date(filter.from!);
    const windowEnd = new Date(filter.to!);

    // Window should be approximately 8 weeks (56 days) before now.
    const daysDiff = (windowEnd.getTime() - windowStart.getTime()) / (1000 * 60 * 60 * 24);
    expect(daysDiff).toBeCloseTo(56, 0);

    // Window start should be between (before − 56 days) and (after − 56 days).
    const expectedStart = new Date(before.getTime() - 56 * 24 * 60 * 60 * 1000);
    expect(windowStart.getTime()).toBeGreaterThanOrEqual(expectedStart.getTime() - 5000);
    expect(windowStart.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

// ── Full happy-path response shape ───────────────────────────────────────────

describe('progression.get_for_exercise — happy path', () => {
  it('returns correct shape with trend when >= 2 sessions', async () => {
    const s1 = makeSession('s1', recentDate(14));
    const s2 = makeSession('s2', recentDate(7));
    const sets1 = [makeSet('a1', 's1', 80, 5)]; // vol = 400
    const sets2 = [makeSet('a2', 's2', 100, 5)]; // vol = 500

    const h = setup([s1, s2], { s1: sets1, s2: sets2 });
    const r = await h.invoke({ exerciseId: 'cable-chest-press' });
    expect(r.isError).toBeUndefined();

    const body = parseResult(r) as {
      exerciseId: string;
      sessionCount: number;
      sessions: Array<{
        sessionId: string;
        topWeightLbs: number;
        totalReps: number;
        completedReps: number;
        estimatedTotalVolumeLbs: number;
      }>;
      trend: {
        topWeightLbsFirst: number;
        topWeightLbsLast: number;
        topWeightLbsDelta: number;
        topWeightLbsDeltaPct: number;
        estimatedTotalVolumeFirst: number;
        estimatedTotalVolumeLast: number;
        estimatedTotalVolumeDeltaPct: number;
      };
    };

    expect(body.exerciseId).toBe('cable-chest-press');
    expect(body.sessionCount).toBe(2);
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0].topWeightLbs).toBe(80);
    expect(body.sessions[1].topWeightLbs).toBe(100);

    const trend = body.trend;
    expect(trend.topWeightLbsFirst).toBe(80);
    expect(trend.topWeightLbsLast).toBe(100);
    expect(trend.topWeightLbsDelta).toBe(20);
    expect(trend.topWeightLbsDeltaPct).toBeCloseTo(25, 5);
    expect(trend.estimatedTotalVolumeFirst).toBe(400);
    expect(trend.estimatedTotalVolumeLast).toBe(500);
    expect(trend.estimatedTotalVolumeDeltaPct).toBeCloseTo(25, 5);
  });

  it('calls getSetsForSession once per session', async () => {
    const s1 = makeSession('s1', recentDate(14));
    const s2 = makeSession('s2', recentDate(7));
    const h = setup([s1, s2], { s1: [], s2: [] });

    await h.invoke({ exerciseId: 'cable-chest-press' });

    expect(h.store.getSetsForSession).toHaveBeenCalledTimes(2);
    expect(h.store.getSetsForSession).toHaveBeenCalledWith('s1');
    expect(h.store.getSetsForSession).toHaveBeenCalledWith('s2');
  });
});
