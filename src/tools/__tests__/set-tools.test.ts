// Unit tests for src/tools/set-tools.ts.
//
// Covers the `set.start` / `set.end` / `set.live_metrics` handlers:
//   * NO_ACTIVE_SESSION when set.start is invoked without a session (EC-03)
//   * SET_ALREADY_ACTIVE when a set is already in flight (EC-13)
//   * Set metadata at start time comes from `live.snapshotDevice()`
//   * NO_ACTIVE_SET on set.end without an active set (AC-17)
//   * set.live_metrics returns the live snapshot or `{ active: false }`
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Rep } from '@voltras/workout-analytics';
import type { LiveState as LiveStateType } from '../../state/live-state.js';
import type { ServerState } from '../../state/server-state.js';
import type { SessionStore, StoredSet } from '../../store/types.js';

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
const { registerSetTools } = await import('../set-tools.js');

interface FakeRegisteredTool {
  callback?: (args: unknown, extra?: unknown) => Promise<unknown>;
  update(updates: { callback: (args: unknown, extra?: unknown) => Promise<unknown> }): void;
  remove(): void;
}

interface FakeServer {
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

const TOOL_NAMES = ['set.start', 'set.end', 'set.live_metrics'];

interface Harness {
  state: ServerState;
  invoke: (
    name: string,
    args: unknown,
  ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  store: ReturnType<typeof makeStore>;
  live: LiveStateType;
}

function setup(): Harness {
  const live = new LiveState();
  const store = makeStore();
  const state = {
    config: {} as never,
    manager: {} as never,
    client: {} as never,
    live,
    store,
    exercises: {} as never,
  } as unknown as ServerState;
  const { placeholders, invokers } = makeFakePlaceholders(TOOL_NAMES);
  const server = { tool: vi.fn() } as unknown as FakeServer;
  registerSetTools(
    server as unknown as Parameters<typeof registerSetTools>[0],
    state,
    placeholders as unknown as Parameters<typeof registerSetTools>[2],
  );
  return {
    state,
    invoke: (name, args) => invokers[name](args),
    store,
    live,
  };
}

function parseResult(r: { content: { text: string }[] }): unknown {
  return JSON.parse(r.content[0].text);
}

function startSession(live: LiveStateType): string {
  const id = 'sess-A';
  live.startSession({
    sessionId: id,
    startedAt: '2025-01-01T00:00:00.000Z',
    setIds: [],
    status: 'active',
  });
  return id;
}

describe('set.start', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('returns NO_ACTIVE_SESSION when no session is open (EC-03)', async () => {
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });

    const r = await h.invoke('set.start', {});
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('NO_ACTIVE_SESSION');
    expect(h.live.set).toBeUndefined();
    expect(h.store.putSet).not.toHaveBeenCalled();
  });

  it('returns SET_ALREADY_ACTIVE when one is already running (EC-13)', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    const r1 = await h.invoke('set.start', {});
    expect(r1.isError).toBeUndefined();
    const setId1 = (parseResult(r1) as { setId: string }).setId;

    const r2 = await h.invoke('set.start', {});
    expect(r2.isError).toBe(true);
    expect((parseResult(r2) as { code: string }).code).toBe('SET_ALREADY_ACTIVE');
    expect(h.live.set?.setId).toBe(setId1);
    expect(h.store.putSet).not.toHaveBeenCalled();
  });

  it('starts a set and stamps live state with a generated setId', async () => {
    const sessionId = startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 75, trainingMode: 'WeightTraining' });

    const r = await h.invoke('set.start', {});
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { setId: string };
    expect(typeof body.setId).toBe('string');
    expect(body.setId.length).toBeGreaterThan(0);
    expect(h.live.set?.setId).toBe(body.setId);
    expect(h.live.set?.sessionId).toBe(sessionId);
    expect(h.live.set?.status).toBe('active');
  });
});

describe('set.end', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('persists with partial=false and reps from live state', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 75, trainingMode: 'WeightTraining' });
    const startResult = await h.invoke('set.start', {});
    const setId = (parseResult(startResult) as { setId: string }).setId;
    h.live.appendRep(makeRep(1));
    h.live.appendRep(makeRep(2));
    h.live.appendRep(makeRep(3));

    const r = await h.invoke('set.end', {});
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { ok: boolean; reps: number };
    expect(body.ok).toBe(true);
    expect(body.reps).toBe(3);

    expect(h.store.putSet).toHaveBeenCalledTimes(1);
    const stored = h.store.putSet.mock.calls[0][0] as StoredSet;
    expect(stored.id).toBe(setId);
    expect(stored.partial).toBe(false);
    expect(stored.partialReason).toBeUndefined();
    expect(stored.reps.length).toBe(3);
    expect(stored.weightLbs).toBe(75);
    expect(stored.trainingMode).toBe('WeightTraining');
    expect(h.live.set).toBeUndefined();
  });

  it('captures the device snapshot at set.start time, not set.end time', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});
    // Mid-set, the user changes the weight on the device.
    h.live.applySettings({ weightLbs: 250, trainingMode: 'IsometricTraining' });

    await h.invoke('set.end', {});
    const stored = h.store.putSet.mock.calls[0][0] as StoredSet;
    expect(stored.weightLbs).toBe(100);
    expect(stored.trainingMode).toBe('WeightTraining');
  });

  it('returns NO_ACTIVE_SET when no set is active', async () => {
    const r = await h.invoke('set.end', {});
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('NO_ACTIVE_SET');
    expect(h.store.putSet).not.toHaveBeenCalled();
  });

  it('returns NO_ACTIVE_SET when invoked twice without a new set.start', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 75, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});
    await h.invoke('set.end', {});

    const r = await h.invoke('set.end', {});
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('NO_ACTIVE_SET');
  });

  it('maps reps to StoredRep with sequential index and parent setId', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 75, trainingMode: 'WeightTraining' });
    const startResult = await h.invoke('set.start', {});
    const setId = (parseResult(startResult) as { setId: string }).setId;
    h.live.appendRep(makeRep(1));
    h.live.appendRep(makeRep(2));

    await h.invoke('set.end', {});
    const stored = h.store.putSet.mock.calls[0][0] as StoredSet;
    expect(stored.reps).toHaveLength(2);
    expect(stored.reps[0].setId).toBe(setId);
    expect(stored.reps[1].setId).toBe(setId);
    expect(stored.reps[0].index).toBe(0);
    expect(stored.reps[1].index).toBe(1);
    expect(stored.reps[0].id).not.toEqual(stored.reps[1].id);
  });
});

describe('set.live_metrics', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('returns the live set snapshot when one is active (AC-12)', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 75, trainingMode: 'WeightTraining' });
    const startResult = await h.invoke('set.start', {});
    const setId = (parseResult(startResult) as { setId: string }).setId;
    h.live.appendRep(makeRep(1));

    const r = await h.invoke('set.live_metrics', {});
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { setId?: string; reps?: unknown[]; status?: string };
    expect(body.setId).toBe(setId);
    expect(body.reps).toHaveLength(1);
    expect(body.status).toBe('active');
  });

  it('returns { active: false } when no set is active', async () => {
    const r = await h.invoke('set.live_metrics', {});
    expect(r.isError).toBeUndefined();
    expect(parseResult(r)).toEqual({ active: false });
  });
});
