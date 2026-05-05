// Unit tests for the read-side `session.list` and `session.get` handlers,
// which live in src/tools/session-tools.ts but are tested separately to keep
// each test file focused on a single concern.
//
// Verifies (AC-19):
//   * default sort = 'startedAt:desc' is applied when the caller omits it
//   * an explicit `sort: 'startedAt:asc'` is forwarded to the store
//   * `session.get` composes `store.getSession` and `store.getSetsForSession`
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerState } from '../../state/server-state.js';
import type {
  SessionListFilter,
  SessionStore,
  StoredSession,
  StoredSet,
} from '../../store/types.js';
import type { ExerciseService } from '../../exercises/exercise-service.js';

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

const SESSIONS: StoredSession[] = [
  { id: 's1', startedAt: '2025-01-01T00:00:00.000Z', exerciseId: 'bench-press' },
  { id: 's2', startedAt: '2025-01-02T00:00:00.000Z', exerciseId: 'squat' },
];

const SETS: StoredSet[] = [
  {
    id: 'set-1',
    sessionId: 's1',
    startedAt: '2025-01-01T00:00:00.000Z',
    endedAt: '2025-01-01T00:01:00.000Z',
    partial: false,
    trainingMode: 'WeightTraining',
    weightLbs: 75,
    reps: [],
  },
];

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
    getSession: vi.fn(async (id: string) => SESSIONS.find((s) => s.id === id)),
    getSet: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => SESSIONS),
    getSetsForSession: vi.fn(async (sessionId: string) =>
      SETS.filter((s) => s.sessionId === sessionId),
    ),
    close: vi.fn(async () => {}),
  };
}

const TOOL_NAMES = ['session.start', 'session.end', 'session.list', 'session.get'];

interface Harness {
  invoke: (
    name: string,
    args: unknown,
  ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  store: ReturnType<typeof makeStore>;
}

function setup(): Harness {
  const live = new LiveState();
  const store = makeStore();
  const exercises = { search: () => [], getById: () => undefined } as unknown as ExerciseService;
  const slots = new Map();
  slots.set('primary', { slotId: 'primary', client: {} as never, live });
  const state = {
    config: {} as never,
    manager: {} as never,
    slots,
    store,
    exercises,
  } as unknown as ServerState;
  const { placeholders, invokers } = makeFakePlaceholders(TOOL_NAMES);
  const server = { tool: vi.fn() } as unknown as Parameters<typeof registerSessionTools>[0];
  registerSessionTools(
    server,
    state,
    placeholders as unknown as Parameters<typeof registerSessionTools>[2],
  );
  return { invoke: (name, args) => invokers[name](args), store };
}

function parseResult(r: { content: { text: string }[] }): unknown {
  return JSON.parse(r.content[0].text);
}

describe('session.list', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('forwards an explicit sort to the store', async () => {
    const r = await h.invoke('session.list', { sort: 'startedAt:asc', limit: 10 });
    expect(r.isError).toBeUndefined();
    expect(h.store.listSessions).toHaveBeenCalledTimes(1);
    const filter = h.store.listSessions.mock.calls[0][0] as SessionListFilter;
    expect(filter.sort).toBe('startedAt:asc');
    expect(filter.limit).toBe(10);
  });

  it("defaults to sort='startedAt:desc' when sort is omitted (R19/AC-19)", async () => {
    const r = await h.invoke('session.list', {});
    expect(r.isError).toBeUndefined();
    const filter = h.store.listSessions.mock.calls[0][0] as SessionListFilter;
    expect(filter.sort).toBe('startedAt:desc');
  });

  it('forwards exerciseId / from / to filters when provided', async () => {
    const r = await h.invoke('session.list', {
      exerciseId: 'bench-press',
      from: '2025-01-01T00:00:00.000Z',
      to: '2025-01-31T23:59:59.999Z',
    });
    expect(r.isError).toBeUndefined();
    const filter = h.store.listSessions.mock.calls[0][0] as SessionListFilter;
    expect(filter.exerciseId).toBe('bench-press');
    expect(filter.from).toBe('2025-01-01T00:00:00.000Z');
    expect(filter.to).toBe('2025-01-31T23:59:59.999Z');
  });

  it('returns the rows produced by the store as a JSON array payload', async () => {
    const r = await h.invoke('session.list', {});
    const body = parseResult(r) as StoredSession[];
    expect(body).toEqual(SESSIONS);
  });
});

describe('session.get', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('returns { session, sets } composed from the store', async () => {
    const r = await h.invoke('session.get', { id: 's1' });
    expect(r.isError).toBeUndefined();
    expect(h.store.getSession).toHaveBeenCalledWith('s1');
    expect(h.store.getSetsForSession).toHaveBeenCalledWith('s1');
    const body = parseResult(r) as { session: StoredSession; sets: StoredSet[] };
    expect(body.session.id).toBe('s1');
    expect(body.sets).toHaveLength(1);
    expect(body.sets[0].id).toBe('set-1');
  });

  it('returns NOT_FOUND when the session id is unknown', async () => {
    const r = await h.invoke('session.get', { id: 'missing' });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('NOT_FOUND');
    expect(h.store.getSetsForSession).not.toHaveBeenCalled();
  });
});
