// The session kind has to survive the lifecycle that PRODUCES it (VW-489).
//
// The reviewer of #479 found the hole these cases close: every other test in
// this repo seeds history by calling `store.putSession({ kind: 'training' })`
// directly, so nothing exercised what the tool layer actually writes. It wrote
// the kind at `session.start` and then threw it away at `session.end`, because
// `endSession` rebuilds the row from LIVE state — which carries no kind — and
// `putSession`'s upsert updated the column from it. A session that had just
// been trained ended up unreviewed, and unreviewed is excluded from every
// lifter-facing read: the workout vanished the moment it finished.
//
// So these run against a REAL store through the REAL handlers, start to end.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { readTrainingDays } from '../../analytics/training-days.js';
import type { ServerState } from '../../state/server-state.js';
import type { Exercise, ExerciseService } from '../../exercises/exercise-service.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

vi.mock('@voltras/node-sdk', () => ({
  VoltraSDKError: class extends Error {},
  TrainingMode: { Idle: 0, WeightTraining: 1 },
  TrainingModeNames: { 0: 'Idle', 1: 'WeightTraining' },
}));

const { LiveState } = await import('../../state/live-state.js');
const { registerSessionTools } = await import('../session-tools.js');
const { ModeRevertGuard } = await import('../../state/mode-revert-guard.js');
const { reapGuidedLoadScaffold } = await import('../../state/guided-load-reap.js');

const BENCH: Exercise = {
  id: 'bench-press',
  name: 'Bench Press',
  primaryMuscles: [],
  secondaryMuscles: [],
} as unknown as Exercise;

const TOOL_NAMES = [
  'session.start',
  'session.end',
  'session.checkin',
  'session.set_exercise',
  'session.set_lifter',
  'session.list',
  'session.get',
  'session.mark_kind',
  'session.review_list',
];

interface FakeTool {
  callback?: (args: unknown) => Promise<unknown>;
  update(updates: { callback: (args: unknown) => Promise<unknown> }): void;
  remove(): void;
}

interface Harness {
  state: ServerState;
  store: SessionStore;
  live: InstanceType<typeof LiveState>;
  invoke: (name: string, args: unknown) => Promise<{ isError?: boolean }>;
}

function setup(adapter: 'node' | 'mock' = 'node'): Harness {
  const store = openTestStore();
  const live = new LiveState();
  const slots = new Map();
  slots.set('primary', {
    slotId: 'primary',
    client: { endSet: vi.fn(async () => {}) } as never,
    live,
    modeRevertGuard: new ModeRevertGuard(),
  });
  const publisher: { publish: () => void; forSlot: () => unknown } = {
    publish: () => {},
    forSlot: () => publisher,
  };
  const exercises = {
    getById: (id: string) => (id === BENCH.id ? BENCH : undefined),
  } as unknown as ExerciseService;
  const state = {
    config: { adapter },
    manager: {} as never,
    slots,
    store,
    exercises,
    setWatchdog: { register: vi.fn(), reset: vi.fn(), cancel: vi.fn(), has: vi.fn(() => false) },
    restTimers: { start: vi.fn(), cancel: vi.fn(), dispose: vi.fn(), has: vi.fn(() => false) },
    setStartDeviceSnapshots: new Map(),
    lastSetEndedAtMs: new Map(),
    channels: { forSlot: () => publisher },
    slotBindings: { get: () => null },
  } as unknown as ServerState;

  const placeholders = new Map<string, FakeTool>();
  for (const name of TOOL_NAMES) {
    const tool: FakeTool = {
      update(updates) {
        tool.callback = updates.callback;
      },
      remove() {
        /* unused */
      },
    };
    placeholders.set(name, tool);
  }
  registerSessionTools(
    { tool: vi.fn() } as unknown as Parameters<typeof registerSessionTools>[0],
    state,
    placeholders as unknown as Parameters<typeof registerSessionTools>[2],
  );
  return {
    state,
    store,
    live,
    invoke: async (name, args) => {
      const callback = placeholders.get(name)?.callback;
      if (callback === undefined) throw new Error(`no callback installed for ${name}`);
      return (await callback(args)) as { isError?: boolean };
    },
  };
}

/** One working set on the slot's live session, written the way `set.end` writes it. */
async function recordWorkingSet(h: Harness, at: string): Promise<void> {
  const sessionId = h.live.session?.sessionId;
  if (sessionId === undefined) throw new Error('no active session');
  await h.store.putSet({
    id: `${sessionId}-work`,
    sessionId,
    startedAt: at,
    endedAt: at,
    partial: false,
    weightLbs: 135,
    exerciseId: BENCH.id,
    reps: [],
  });
}

const AT = '2026-09-19T15:00:00.000Z';
/** The suite pins TZ=UTC, so a fixed clock makes the local day of every write knowable. */
const NOW = new Date('2026-09-19T16:00:00.000Z');
let h: Harness;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  h = setup();
});
afterEach(async () => {
  await h.store.close();
  vi.useRealTimers();
});

describe('a session keeps its kind across the lifecycle that made it', () => {
  it('survives session.end as training, and counts as a training day', async () => {
    await h.invoke('session.start', { exerciseId: BENCH.id });
    const sessionId = h.live.session?.sessionId ?? '';
    await recordWorkingSet(h, AT);

    await h.invoke('session.end', {});

    const stored = await h.store.getSession(sessionId);
    expect(stored?.kind).toBe('training');
    expect(stored?.endedAt).toBeDefined();
    expect(await readTrainingDays(h.store, NOW.toISOString())).toEqual(['2026-09-19']);
  });

  it('survives session.end as test when the caller said test', async () => {
    await h.invoke('session.start', { exerciseId: BENCH.id, kind: 'test' });
    const sessionId = h.live.session?.sessionId ?? '';
    await recordWorkingSet(h, AT);

    await h.invoke('session.end', {});

    expect((await h.store.getSession(sessionId))?.kind).toBe('test');
    expect(await readTrainingDays(h.store, NOW.toISOString())).toEqual([]);
  });

  it('survives session.end as test under the mock adapter', async () => {
    const mock = setup('mock');
    try {
      await mock.invoke('session.start', { exerciseId: BENCH.id });
      const sessionId = mock.live.session?.sessionId ?? '';
      await recordWorkingSet(mock, AT);

      await mock.invoke('session.end', {});

      expect((await mock.store.getSession(sessionId))?.kind).toBe('test');
    } finally {
      await mock.store.close();
    }
  });

  it('keeps a mid-session mark through the close', async () => {
    await h.invoke('session.start', { exerciseId: BENCH.id });
    const sessionId = h.live.session?.sessionId ?? '';
    await recordWorkingSet(h, AT);
    await h.invoke('session.mark_kind', { kind: 'test', sessionId });

    await h.invoke('session.end', {});

    expect((await h.store.getSession(sessionId))?.kind).toBe('test');
  });

  it('keeps the auto-armed guided-load session’s kind across the reap', async () => {
    const sessionId = 'auto-1';
    await h.store.putSession({
      id: sessionId,
      startedAt: AT,
      exerciseName: 'Guided Load (auto)',
      kind: 'training',
    });
    h.live.startSession({
      sessionId,
      startedAt: AT,
      setIds: [],
      status: 'active',
      exerciseName: 'Guided Load (auto)',
      autoCreatedBy: 'guided_load',
    });
    await recordWorkingSet(h, AT);

    await reapGuidedLoadScaffold(h.state, 'primary');

    const stored = await h.store.getSession(sessionId);
    expect(stored?.kind).toBe('training');
    expect(stored?.endedAt).toBeDefined();
  });

  it('cannot have its kind cleared by a re-put that carries none', async () => {
    await h.store.putSession({ id: 's1', startedAt: AT, kind: 'training' });

    await h.store.putSession({ id: 's1', startedAt: AT, endedAt: AT });

    expect((await h.store.getSession('s1'))?.kind).toBe('training');
  });
});
