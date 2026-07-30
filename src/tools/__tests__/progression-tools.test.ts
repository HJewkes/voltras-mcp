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

/**
 * Post-VMCP-01.72b, `progression.get_for_exercise` discovers sessions via
 * each SET's own `exerciseId` (`getSetsForExercise`), matching what the real
 * `buildSetCapture` write path stamps at `set.end` whenever the owning
 * session has an `exerciseId`. Fixtures therefore stamp `exerciseId` (and a
 * realistic `startedAt`, since the discovery query windows on the SET's own
 * timestamp) rather than leaving it to the session-level column the way
 * pre-cutover fixtures could get away with.
 */
function makeSet(
  id: string,
  sessionId: string,
  weightLbs: number,
  repCount: number,
  opts: { exerciseId?: string; startedAt?: string } = {},
): StoredSet {
  const reps = Array.from({ length: repCount }, (_, i) =>
    Object.assign(makeRep(i + 1), { id: `${id}-r${i + 1}`, setId: id, index: i }),
  );
  // `'exerciseId' in opts` (not `opts.exerciseId ?? default`) so a caller can
  // explicitly pass `{ exerciseId: undefined }` to build an UNATTRIBUTED set
  // (H2 fixtures) without the nullish-coalescing default clobbering it back
  // to 'cable-chest-press'.
  const exerciseId = 'exerciseId' in opts ? opts.exerciseId : 'cable-chest-press';
  return {
    id,
    sessionId,
    startedAt: opts.startedAt ?? new Date().toISOString(),
    endedAt: '2025-01-01T00:05:00.000Z',
    partial: false,
    trainingMode: 'WeightTraining',
    weightLbs,
    ...(exerciseId !== undefined ? { exerciseId } : {}),
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
  getSetsForExercise: ReturnType<typeof vi.fn>;
} {
  const sessionsById = new Map(sessions.map((s) => [s.id, s]));
  return {
    putSession: vi.fn(async () => {}),
    putSet: vi.fn(async () => {}),
    getSession: vi.fn(async (id: string) => sessionsById.get(id)),
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
    // Mirrors `sqlite-store.ts`'s real query: exact exerciseId match, `from`/`to`
    // window on the SET's own `startedAt`, ascending order.
    getSetsForExercise: vi.fn(
      async (filter: { exerciseId: string; from?: string; to?: string }) => {
        const all = Object.values(setMap).flat();
        return all
          .filter(
            (s) =>
              s.exerciseId === filter.exerciseId &&
              (filter.from === undefined || s.startedAt >= filter.from) &&
              (filter.to === undefined || s.startedAt <= filter.to),
          )
          .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      },
    ),
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
  it('passes exerciseId to getSetsForExercise filter', async () => {
    // VMCP-01.72b (H1): sessions are now discovered by each SET's own
    // exerciseId via getSetsForExercise, not by listSessions' session-row
    // column — see progression-tools.ts.
    const sessions = [
      makeSession('s1', recentDate(14), 'cable-chest-press'),
      makeSession('s2', recentDate(7), 'squat'),
    ];
    const h = setup(sessions, { s1: [], s2: [] });

    await h.invoke({ exerciseId: 'cable-chest-press' });

    expect(h.store.getSetsForExercise).toHaveBeenCalledTimes(1);
    const filter = h.store.getSetsForExercise.mock.calls[0][0] as { exerciseId: string };
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
  it('returns at most limit sessions, keeping the most recent', async () => {
    const sessions = Array.from({ length: 10 }, (_, i) =>
      makeSession(`s${i + 1}`, recentDate(9 - i)),
    );
    const setMap = Object.fromEntries(
      sessions.map((s, i) => [
        s.id,
        [makeSet(`set-${s.id}`, s.id, 100, 5, { startedAt: recentDate(9 - i) })],
      ]),
    );
    const h = setup(sessions, setMap);

    const r = await h.invoke({ exerciseId: 'cable-chest-press', limit: 3 });
    expect(r.isError).toBeUndefined();

    const body = parseResult(r) as { sessions: Array<{ sessionId: string }> };
    expect(body.sessions).toHaveLength(3);
    // Most recent 3 kept: s8, s9, s10 (ascending — the query is a distinct-
    // session list, most-recent-`limit` sliced from the ascending end).
    expect(body.sessions.map((s) => s.sessionId)).toEqual(['s8', 's9', 's10']);
  });

  it('defaults to limit=20, keeping the most recent sessions', async () => {
    const sessions = Array.from({ length: 25 }, (_, i) =>
      makeSession(`s${i + 1}`, recentDate(24 - i)),
    );
    const setMap = Object.fromEntries(
      sessions.map((s, i) => [
        s.id,
        [makeSet(`set-${s.id}`, s.id, 100, 5, { startedAt: recentDate(24 - i) })],
      ]),
    );
    const h = setup(sessions, setMap);

    const r = await h.invoke({ exerciseId: 'cable-chest-press' });
    expect(r.isError).toBeUndefined();

    const body = parseResult(r) as { sessions: Array<{ sessionId: string }> };
    expect(body.sessions).toHaveLength(20);
    expect(body.sessions[0].sessionId).toBe('s6');
    expect(body.sessions[19].sessionId).toBe('s25');
  });
});

// ── lookbackWeeks default ─────────────────────────────────────────────────────

describe('progression.get_for_exercise — lookbackWeeks default', () => {
  it('defaults to 8 weeks lookback when not specified', async () => {
    const h = setup([], {});
    const before = new Date();
    await h.invoke({ exerciseId: 'cable-chest-press' });
    const after = new Date();

    const filter = h.store.getSetsForExercise.mock.calls[0][0] as {
      from?: string;
      to?: string;
    };
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

  it('calls getSetsForSession once per session that trained the exercise', async () => {
    const s1 = makeSession('s1', recentDate(14));
    const s2 = makeSession('s2', recentDate(7));
    const h = setup([s1, s2], {
      s1: [makeSet('a1', 's1', 80, 1)],
      s2: [makeSet('a2', 's2', 100, 1)],
    });

    await h.invoke({ exerciseId: 'cable-chest-press' });

    expect(h.store.getSetsForSession).toHaveBeenCalledTimes(2);
    expect(h.store.getSetsForSession).toHaveBeenCalledWith('s1');
    expect(h.store.getSetsForSession).toHaveBeenCalledWith('s2');
  });
});

// ── Multi-exercise session (VMCP-01.72b positive control) ────────────────────

describe('progression.get_for_exercise — multi-exercise session (H1/H2)', () => {
  it('finds a session by its SETS even when the session-row exerciseId disagrees (H1), and does not double-count an unattributed set (H2)', async () => {
    // Simulates session.set_exercise('squat') having been called after some
    // bench sets: the session ROW is last-write-wins and now reads 'squat',
    // but the session's own sets still carry their individual attribution.
    const s1 = makeSession('s1', recentDate(3), 'squat');
    const bench = makeSet('bench-1', 's1', 135, 5, { exerciseId: 'cable-chest-press' });
    const squat = makeSet('squat-1', 's1', 225, 5, { exerciseId: 'squat' });
    // Recorded before session.set_exercise existed, or a bridge-torn-down
    // close — no exerciseId of its own.
    const unattributed = makeSet('u-1', 's1', 45, 5, { exerciseId: undefined });
    const h = setup([s1], { s1: [bench, squat, unattributed] });

    const r = await h.invoke({ exerciseId: 'cable-chest-press' });
    expect(r.isError).toBeUndefined();

    const body = parseResult(r) as {
      sessionCount: number;
      sessions: Array<{ sessionId: string; setCount: number; topWeightLbs: number }>;
    };
    // H1: the session is found at all, despite session.exerciseId === 'squat'.
    expect(body.sessionCount).toBe(1);
    expect(body.sessions[0].sessionId).toBe('s1');
    // H2: only the bench set counts — the squat set is excluded (correct),
    // and the unattributed set is ALSO excluded (the leniency that keeps it
    // for single-exercise sessions is withdrawn once the session is known,
    // from its own sets, to hold more than one exercise).
    expect(body.sessions[0].setCount).toBe(1);
    expect(body.sessions[0].topWeightLbs).toBe(135);
  });
});
