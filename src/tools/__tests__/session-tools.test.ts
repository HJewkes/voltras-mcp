// Unit tests for src/tools/session-tools.ts.
//
// Covers the `session.start` / `session.end` lifecycle handlers:
//   * SESSION_ALREADY_ACTIVE guard (EC-14)
//   * EXERCISE_NOT_FOUND when an unknown id is supplied (AC-21 case 5)
//   * INVALID_INPUT when neither id nor name is given (AC-21 case 4)
//   * "exerciseId wins over exerciseName" rule (AC-21 case 1, R21)
//   * Force-end of an active set on session.end with partialReason='session_end'
//     (EC-06)
//   * session.end clears live state and writes endedAt to the store row
//
// The MCP `RegisteredTool` is faked with the minimum surface that
// `registerSessionTools` actually consumes (`update({ callback })`); the
// real SDK is mocked so the static import chain doesn't pull native peers.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Rep } from '@voltras/workout-analytics';
import type { LiveState as LiveStateType } from '../../state/live-state.js';
import type { ServerState } from '../../state/server-state.js';
import type { SessionStore, StoredSession, StoredSet } from '../../store/types.js';
import type { Exercise, ExerciseService } from '../../exercises/exercise-service.js';

vi.mock('@voltras/node-sdk', () => {
  class FakeVoltraSDKError extends Error {
    readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'VoltraSDKError';
      this.code = code;
    }
  }
  return { VoltraSDKError: FakeVoltraSDKError };
});

const { LiveState } = await import('../../state/live-state.js');
const { registerSessionTools } = await import('../session-tools.js');

interface FakeRegisteredTool {
  callback?: (args: unknown, extra?: unknown) => Promise<unknown>;
  update(updates: { callback: (args: unknown, extra?: unknown) => Promise<unknown> }): void;
  remove(): void;
}

interface FakeServer {
  // unused — registerSessionTools uses placeholders, not server.tool
  tool: (...args: unknown[]) => unknown;
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

function makeStore(): SessionStore & {
  putSession: ReturnType<typeof vi.fn>;
  putSet: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  getSet: ReturnType<typeof vi.fn>;
  getSetsForSession: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    putSession: vi.fn(async () => {}),
    putSet: vi.fn(async () => {}),
    getSession: vi.fn(async () => undefined),
    getSet: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => []),
    getSetsForSession: vi.fn(async () => []),
    close: vi.fn(async () => {}),
  };
}

function makeExercises(known: Record<string, Exercise>): ExerciseService {
  return {
    search: vi.fn((q: string) =>
      Object.values(known).filter((e) => e.name.toLowerCase().includes(q.toLowerCase())),
    ),
    getById: vi.fn((id: string) => known[id]),
  } as unknown as ExerciseService;
}

const BENCH: Exercise = {
  id: 'bench-press',
  name: 'Bench Press',
  muscleGroups: ['chest'],
  movementPattern: 'push',
  exerciseType: 'compound',
  equipment: [{ name: 'barbell', category: 'free-weight' }],
  cableEquivalent: false,
  qualityScore: 100,
};

function makeRep(n: number): Rep {
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
  return { repNumber: n, concentric: phase, eccentric: phase };
}

const TOOL_NAMES = ['session.start', 'session.end', 'session.list', 'session.get'];

interface Harness {
  state: ServerState;
  invoke: (
    name: string,
    args: unknown,
  ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  store: ReturnType<typeof makeStore>;
  exercises: ExerciseService;
  live: LiveStateType;
}

function setup(): Harness {
  const live = new LiveState();
  const store = makeStore();
  const exercises = makeExercises({ 'bench-press': BENCH });
  const state = {
    config: {} as never,
    manager: {} as never,
    client: {} as never,
    live,
    store,
    exercises,
  } as unknown as ServerState;
  const { placeholders, invokers } = makeFakePlaceholders(TOOL_NAMES);
  const server = { tool: vi.fn() } as unknown as FakeServer;
  registerSessionTools(
    server as unknown as Parameters<typeof registerSessionTools>[0],
    state,
    placeholders as unknown as Parameters<typeof registerSessionTools>[2],
  );
  return {
    state,
    invoke: (name, args) => invokers[name](args),
    store,
    exercises,
    live,
  };
}

function parseResult(r: { content: { text: string }[] }): unknown {
  return JSON.parse(r.content[0].text);
}

describe('session.start', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('creates a session when given a known exerciseId', async () => {
    const r = await h.invoke('session.start', { exerciseId: 'bench-press' });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { sessionId: string };
    expect(typeof body.sessionId).toBe('string');
    expect(body.sessionId.length).toBeGreaterThan(0);

    expect(h.live.session?.sessionId).toBe(body.sessionId);
    expect(h.live.session?.exerciseId).toBe('bench-press');
    expect(h.live.session?.exerciseName).toBeUndefined();
    expect(h.store.putSession).toHaveBeenCalledTimes(1);
    const stored = h.store.putSession.mock.calls[0][0] as StoredSession;
    expect(stored.id).toBe(body.sessionId);
    expect(stored.exerciseId).toBe('bench-press');
    expect(stored.exerciseName).toBeUndefined();
    expect(stored.endedAt).toBeUndefined();
  });

  it('returns SESSION_ALREADY_ACTIVE while a session is active (EC-14)', async () => {
    await h.invoke('session.start', { exerciseId: 'bench-press' });
    h.store.putSession.mockClear();

    const r = await h.invoke('session.start', { exerciseId: 'bench-press' });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('SESSION_ALREADY_ACTIVE');
    expect(h.store.putSession).not.toHaveBeenCalled();
  });

  it('returns EXERCISE_NOT_FOUND when the id is unknown (AC-21 case 5)', async () => {
    const r = await h.invoke('session.start', { exerciseId: 'does-not-exist' });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('EXERCISE_NOT_FOUND');
    expect(h.live.session).toBeUndefined();
    expect(h.store.putSession).not.toHaveBeenCalled();
  });

  it('returns INVALID_INPUT when neither field is given (AC-21 case 4)', async () => {
    const r = await h.invoke('session.start', {});
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
    expect(h.live.session).toBeUndefined();
  });

  it('drops exerciseName when both are provided (AC-21 case 1, R21)', async () => {
    const r = await h.invoke('session.start', {
      exerciseId: 'bench-press',
      exerciseName: 'free text fallback',
    });
    expect(r.isError).toBeUndefined();
    expect(h.live.session?.exerciseId).toBe('bench-press');
    expect(h.live.session?.exerciseName).toBeUndefined();
    const stored = h.store.putSession.mock.calls[0][0] as StoredSession;
    expect(stored.exerciseId).toBe('bench-press');
    expect(stored.exerciseName).toBeUndefined();
  });

  it('persists exerciseName when only the name is supplied (AC-21 case 3)', async () => {
    const r = await h.invoke('session.start', { exerciseName: 'something custom' });
    expect(r.isError).toBeUndefined();
    expect(h.live.session?.exerciseId).toBeUndefined();
    expect(h.live.session?.exerciseName).toBe('something custom');
    const stored = h.store.putSession.mock.calls[0][0] as StoredSession;
    expect(stored.exerciseId).toBeUndefined();
    expect(stored.exerciseName).toBe('something custom');
  });
});

describe('session.end', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('returns NO_ACTIVE_SESSION when none is active', async () => {
    const r = await h.invoke('session.end', {});
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('NO_ACTIVE_SESSION');
  });

  it('force-ends an active set as partial with session_end reason (EC-06)', async () => {
    await h.invoke('session.start', { exerciseId: 'bench-press' });
    const sessionId = h.live.session!.sessionId;
    h.live.applySettings({
      connected: true,
      weightLbs: 95,
      trainingMode: 'WeightTraining',
    });
    h.live.startSet({
      setId: 'set-X',
      sessionId,
      startedAt: '2025-01-01T00:00:00.000Z',
      reps: [],
      status: 'active',
    });
    h.live.appendRep(makeRep(1));
    h.live.appendRep(makeRep(2));
    h.store.putSession.mockClear();

    const r = await h.invoke('session.end', {});
    expect(r.isError).toBeUndefined();

    expect(h.store.putSet).toHaveBeenCalledTimes(1);
    const persistedSet = h.store.putSet.mock.calls[0][0] as StoredSet;
    expect(persistedSet.partial).toBe(true);
    expect(persistedSet.partialReason).toBe('session_end');
    expect(persistedSet.reps.length).toBe(2);
    expect(persistedSet.id).toBe('set-X');
    expect(persistedSet.sessionId).toBe(sessionId);
    expect(persistedSet.trainingMode).toBe('WeightTraining');
    expect(persistedSet.weightLbs).toBe(95);

    expect(h.store.putSession).toHaveBeenCalledTimes(1);
    const finalRow = h.store.putSession.mock.calls[0][0] as StoredSession;
    expect(finalRow.id).toBe(sessionId);
    expect(typeof finalRow.endedAt).toBe('string');
    expect(finalRow.endedAt!.length).toBeGreaterThan(0);

    expect(h.live.session).toBeUndefined();
    expect(h.live.set).toBeUndefined();
  });

  it('clears live.session and writes endedAt to the persisted row', async () => {
    await h.invoke('session.start', { exerciseId: 'bench-press' });
    const sessionId = h.live.session!.sessionId;
    h.store.putSession.mockClear();

    const r = await h.invoke('session.end', {});
    expect(r.isError).toBeUndefined();
    expect(h.live.session).toBeUndefined();
    expect(h.store.putSession).toHaveBeenCalledTimes(1);
    const finalRow = h.store.putSession.mock.calls[0][0] as StoredSession;
    expect(finalRow.id).toBe(sessionId);
    expect(typeof finalRow.endedAt).toBe('string');
  });
});
