// End-to-end regression for VMCP-01.72b's headline claim: a set snapshots
// the session's exercise pointer at `set.start`, not at close.
//
// `session-tools.test.ts`'s coverage of `session.set_exercise` asserts
// against `LiveState` directly (calling `live.startSet` by hand with the
// snapshot already computed) — it never goes through the real `set.start`
// tool or `set.end`'s `finalizeSet` → `buildSetCapture` path, which is
// where the behavior actually lives. This file drives the REAL tool chain —
// `session.start` → `set.start` → `session.set_exercise` → `set.end` — using
// both `registerSessionTools` and `registerSetTools` against one shared
// `LiveState`, and asserts on the PERSISTED `StoredSet.exerciseId` (the
// `store.putSet` payload), not on live state a test could have written
// itself.
//
// Mutation-verified: reverting `buildSetCapture` (set-tools.ts) to
// re-read the live session's `exerciseId` at close, instead of the set's
// own start-time snapshot, makes the "does not relabel" assertion below
// fail (the closed set inherits `back-squat` instead of keeping
// `bench-press`).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LiveState as LiveStateType } from '../../state/live-state.js';
import type { ServerState } from '../../state/server-state.js';
import type { Exercise, ExerciseService } from '../../exercises/exercise-service.js';
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
  return {
    VoltraSDKError: FakeVoltraSDKError,
    TrainingMode: {
      Idle: 0,
      WeightTraining: 1,
      ResistanceBand: 2,
      Rowing: 3,
      Damper: 4,
      CustomCurves: 6,
      Isokinetic: 7,
      Isometric: 8,
    },
    TrainingModeNames: {
      0: 'Idle',
      1: 'WeightTraining',
      2: 'ResistanceBand',
      3: 'Rowing',
      4: 'Damper',
      6: 'CustomCurves',
      7: 'Isokinetic',
      8: 'Isometric',
    },
  };
});

const { LiveState } = await import('../../state/live-state.js');
const { registerSessionTools } = await import('../session-tools.js');
const { registerSetTools } = await import('../set-tools.js');
const { ModeRevertGuard } = await import('../../state/mode-revert-guard.js');
const { SetWatchdog } = await import('../../state/set-watchdog.js');
const { RestTimerRegistry } = await import('../../state/rest-timer.js');
const { BilateralReconciler } = await import('../../state/bilateral-reconciler.js');
const { SlotBindingsStore } = await import('../../state/slot-bindings.js');

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

function makeStore(): SessionStore & {
  putSession: ReturnType<typeof vi.fn>;
  putSet: ReturnType<typeof vi.fn>;
} {
  return {
    putSession: vi.fn(async () => {}),
    putSet: vi.fn(async () => {}),
    getSession: vi.fn(async () => undefined),
    getSet: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => []),
    getSetsForSession: vi.fn(async () => []),
    getSetsForExercise: vi.fn(async () => []),
    countSessions: vi.fn(async () => 0),
    countSets: vi.fn(async () => 0),
    putTrainingProgram: vi.fn(async () => {}),
    getTrainingProgram: vi.fn(async () => undefined),
    listTrainingPrograms: vi.fn(async () => []),
    putTrainingBlock: vi.fn(async () => {}),
    getTrainingBlocksForProgram: vi.fn(async () => []),
    putTrainingWeek: vi.fn(async () => {}),
    getTrainingWeeksForBlock: vi.fn(async () => []),
    putWorkoutTemplate: vi.fn(async () => {}),
    getWorkoutTemplate: vi.fn(async () => undefined),
    getWorkoutTemplatesForWeek: vi.fn(async () => []),
    putPlannedExercise: vi.fn(async () => {}),
    getPlannedExercisesForTemplate: vi.fn(async () => []),
    putProgramAssignment: vi.fn(async () => {}),
    getAssignmentsForSession: vi.fn(async () => []),
    getAssignmentsForTemplate: vi.fn(async () => []),
    close: vi.fn(async () => {}),
  } as unknown as SessionStore & {
    putSession: ReturnType<typeof vi.fn>;
    putSet: ReturnType<typeof vi.fn>;
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

const SQUAT: Exercise = {
  id: 'back-squat',
  name: 'Back Squat',
  muscleGroups: ['quads'],
  movementPattern: 'squat',
  exerciseType: 'compound',
  equipment: [{ name: 'barbell', category: 'free-weight' }],
  cableEquivalent: false,
  qualityScore: 100,
};

const TOOL_NAMES = [
  'session.start',
  'session.end',
  'session.set_exercise',
  'session.list',
  'session.get',
  'set.start',
  'set.end',
  'set.live_metrics',
  'set.get',
];

interface Harness {
  invoke: (
    name: string,
    args: unknown,
  ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  store: ReturnType<typeof makeStore>;
  live: LiveStateType;
}

const bindingDirs: string[] = [];

afterEach(() => {
  for (const dir of bindingDirs) rmSync(dir, { recursive: true, force: true });
  bindingDirs.length = 0;
});

function setup(): Harness {
  const live = new LiveState();
  const store = makeStore();
  const exercises = makeExercises({ 'bench-press': BENCH, 'back-squat': SQUAT });
  const client = {
    startRecording: vi.fn().mockResolvedValue(undefined),
    endSet: vi.fn().mockResolvedValue(undefined),
    isRowingActive: false,
    connectedDeviceId: 'AA:BB:CC:DD:EE:01',
  };
  const channels: {
    publish: ReturnType<typeof vi.fn>;
    forSlot: (slotId: string) => { publish: (e: unknown) => void; forSlot: unknown };
  } = {
    publish: vi.fn(),
    forSlot: (slotId: string) => ({
      publish: (event: unknown) => {
        const e = event as { content: string; meta: Record<string, string> };
        channels.publish({ content: e.content, meta: { slot: slotId, ...e.meta } });
      },
      forSlot: channels.forSlot,
    }),
  };
  const slots = new Map();
  slots.set('primary', { slotId: 'primary', client, live, modeRevertGuard: new ModeRevertGuard() });
  const bindingDir = mkdtempSync(join(tmpdir(), 'vmcp-session-set-exercise-e2e-'));
  bindingDirs.push(bindingDir);
  const slotBindings = SlotBindingsStore.open(join(bindingDir, 'slot-bindings.json'));
  const state = {
    config: {} as never,
    manager: {} as never,
    slots,
    store,
    exercises,
    channels,
    setStartDeviceSnapshots: new Map(),
    lastSetEndedAtMs: new Map(),
    setWatchdog: new SetWatchdog(),
    restTimers: new RestTimerRegistry(),
    bilateralReconciler: new BilateralReconciler(),
    slotBindings,
  } as unknown as ServerState;
  const { placeholders, invokers } = makeFakePlaceholders(TOOL_NAMES);
  const server = { tool: vi.fn() } as unknown as Parameters<typeof registerSessionTools>[0];
  registerSessionTools(server, state, placeholders as never);
  registerSetTools(server, state, placeholders as never);
  return {
    invoke: (name, args) => invokers[name](args),
    store,
    live,
  };
}

describe('session.set_exercise + set.start/set.end — persisted attribution (VMCP-01.72b, B2 regression)', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('a set persists the exercise that was active at set.start, unaffected by a LATER session.set_exercise', async () => {
    await h.invoke('session.start', { exerciseId: 'bench-press' });
    h.live.applySettings({ connected: true, weightLbs: 135, trainingMode: 'WeightTraining' });

    const startResult = await h.invoke('set.start', {});
    expect(startResult.isError).toBeUndefined();

    // Switch exercise while the set from the FIRST exercise is still open.
    const switchResult = await h.invoke('session.set_exercise', { exerciseId: 'back-squat' });
    expect(switchResult.isError).toBeUndefined();

    const endResult = await h.invoke('set.end', {});
    expect(endResult.isError).toBeUndefined();

    expect(h.store.putSet).toHaveBeenCalledTimes(1);
    const persisted = h.store.putSet.mock.calls[0][0] as StoredSet;
    // The already-open set must NOT be retroactively relabeled to squat.
    expect(persisted.exerciseId).toBe('bench-press');
  });

  it('a set started AFTER session.set_exercise persists the NEW exercise', async () => {
    await h.invoke('session.start', { exerciseId: 'bench-press' });
    h.live.applySettings({ connected: true, weightLbs: 135, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});
    await h.invoke('set.end', {});

    await h.invoke('session.set_exercise', { exerciseId: 'back-squat' });
    h.live.applySettings({ connected: true, weightLbs: 225, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});
    await h.invoke('set.end', {});

    expect(h.store.putSet).toHaveBeenCalledTimes(2);
    const first = h.store.putSet.mock.calls[0][0] as StoredSet;
    const second = h.store.putSet.mock.calls[1][0] as StoredSet;
    expect(first.exerciseId).toBe('bench-press');
    expect(second.exerciseId).toBe('back-squat');
  });

  it('a full bench→squat→bench session persists each set under its own exercise, in order', async () => {
    await h.invoke('session.start', { exerciseId: 'bench-press' });
    h.live.applySettings({ connected: true, weightLbs: 135, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});
    await h.invoke('set.end', {});

    await h.invoke('session.set_exercise', { exerciseId: 'back-squat' });
    h.live.applySettings({ connected: true, weightLbs: 225, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});
    await h.invoke('set.end', {});

    await h.invoke('session.set_exercise', { exerciseId: 'bench-press' });
    h.live.applySettings({ connected: true, weightLbs: 145, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});
    await h.invoke('set.end', {});

    const persisted = h.store.putSet.mock.calls.map((c) => (c[0] as StoredSet).exerciseId);
    expect(persisted).toEqual(['bench-press', 'back-squat', 'bench-press']);

    // The session row itself (last-write-wins, advisory) reflects the LAST
    // exercise once the session ends.
    await h.invoke('session.end', {});
    const storedSession = h.store.putSession.mock.calls[
      h.store.putSession.mock.calls.length - 1
    ][0] as {
      exerciseId?: string;
    };
    expect(storedSession.exerciseId).toBe('bench-press');
  });
});
