// End-to-end coverage for the setup-inference hook on set close (VW-119).
//
// Runs against a REAL in-memory `SqliteSessionStore`, because what is being
// tested is that a `setup_id` lands on the persisted row — a hand-written fake
// would report success whether or not the writer ran.
//
// Two ordering guarantees are load-bearing and asserted here:
//
//   * The inference runs AFTER the set is finalized and persisted. It never
//     delays or reorders the close.
//   * A clustering failure is logged and swallowed. `set.end`'s caller is a
//     coach mid-workout; a derived-state failure must not read as a failed set.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Rep } from '@voltras/workout-analytics';

import type { LiveState as LiveStateType } from '../../state/live-state.js';
import type { ServerState } from '../../state/server-state.js';
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
  return {
    VoltraSDKError: FakeVoltraSDKError,
    TrainingMode: { Idle: 0, WeightTraining: 1 },
    TrainingModeNames: { 0: 'Idle', 1: 'WeightTraining' },
  };
});

const { LiveState } = await import('../../state/live-state.js');
const { ModeRevertGuard } = await import('../../state/mode-revert-guard.js');
const { SetWatchdog } = await import('../../state/set-watchdog.js');
const { RestTimerRegistry } = await import('../../state/rest-timer.js');
const { SlotBindingsStore } = await import('../../state/slot-bindings.js');
const { SqliteSessionStore } = await import('../../store/sqlite-store.js');
const { registerSessionTools } = await import('../session-tools.js');
const { registerSetTools } = await import('../set-tools.js');

const TOOL_NAMES = [
  'session.start',
  'session.end',
  'session.set_exercise',
  'session.set_lifter',
  'session.list',
  'session.get',
  'set.start',
  'set.end',
  'set.live_metrics',
  'set.update',
  'set.get',
];

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

interface FakeRegisteredTool {
  callback?: (args: unknown, extra?: unknown) => Promise<unknown>;
  update(updates: { callback: (args: unknown, extra?: unknown) => Promise<unknown> }): void;
  remove(): void;
}

type ToolResult = { content: { text: string }[]; isError?: boolean };

function makeFakePlaceholders(): {
  placeholders: Map<string, FakeRegisteredTool>;
  invoke: (name: string, args: unknown) => Promise<ToolResult>;
} {
  const placeholders = new Map<string, FakeRegisteredTool>();
  for (const name of TOOL_NAMES) {
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
  return {
    placeholders,
    invoke: async (name, args) => {
      const cb = placeholders.get(name)?.callback;
      if (!cb) throw new Error(`no callback installed for ${name}`);
      return cb(args) as Promise<ToolResult>;
    },
  };
}

/** A rep whose concentric travels `romM` metres — the only input the clustering reads. */
function makeRep(n: number, romM: number): Rep {
  const phase = {
    samples: [],
    startTime: n * 3000,
    endTime: n * 3000 + 1500,
    startPosition: 0,
    endPosition: romM,
    _totalVelocity: 0.6,
    _totalForce: 100,
    _totalLoad: 100,
    _movementSampleCount: 4,
    _totalHoldDuration: 0,
    peakVelocity: 0.6,
    peakForce: 100,
    peakLoad: 100,
  };
  return { repNumber: n, concentric: { ...phase }, eccentric: { ...phase } };
}

interface Harness {
  state: ServerState;
  invoke: (name: string, args: unknown) => Promise<ToolResult>;
  store: InstanceType<typeof SqliteSessionStore>;
  live: LiveStateType;
  cleanup: () => void;
}

function setup(): Harness {
  const live = new LiveState();
  const store = SqliteSessionStore.open(':memory:');
  const client = {
    startRecording: vi.fn().mockResolvedValue(undefined),
    endSet: vi.fn().mockResolvedValue(undefined),
    isRowingActive: false,
    connectedDeviceId: null,
  };
  const channels = { publish: () => undefined, forSlot: () => channels };
  const slots = new Map();
  slots.set('primary', { slotId: 'primary', client, live, modeRevertGuard: new ModeRevertGuard() });
  const bindingDir = mkdtempSync(join(tmpdir(), 'vmcp-setup-bindings-'));
  const slotBindings = SlotBindingsStore.open(join(bindingDir, 'slot-bindings.json'));
  const exercises = {
    search: vi.fn(() => [BENCH]),
    getById: vi.fn((id: string) => (id === BENCH.id ? BENCH : undefined)),
  } as unknown as ExerciseService;

  const state = {
    config: { restTimer: 'off' } as never,
    manager: {} as never,
    slots,
    store,
    exercises,
    channels,
    setStartDeviceSnapshots: new Map(),
    lastSetEndedAtMs: new Map(),
    setWatchdog: new SetWatchdog(),
    restTimers: new RestTimerRegistry(),
    slotBindings,
  } as unknown as ServerState;

  const { placeholders, invoke } = makeFakePlaceholders();
  const server = { tool: vi.fn() } as never;
  const cast = placeholders as unknown as Parameters<typeof registerSessionTools>[2];
  registerSessionTools(server, state, cast);
  registerSetTools(server, state, cast);

  return {
    state,
    invoke,
    store,
    live,
    cleanup: () => {
      rmSync(bindingDir, { recursive: true, force: true });
      void store.close();
    },
  };
}

function parse(r: ToolResult): Record<string, unknown> {
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

/** Open a set, feed it four reps at `romM`, close it, and return its row id. */
async function performSet(h: Harness, romM: number): Promise<string> {
  const setId = (parse(await h.invoke('set.start', {})) as { setId: string }).setId;
  for (let i = 1; i <= 4; i++) h.live.appendRep(makeRep(i, romM));
  await h.invoke('set.end', {});
  return setId;
}

describe('set.end infers the physical setup (VW-119)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = setup();
    await h.invoke('session.start', { exerciseId: 'bench-press' });
  });
  afterEach(() => {
    h.cleanup();
  });

  it('stamps the just-closed set with the setup it was performed at', async () => {
    const setId = await performSet(h, 0.5);

    const stored = await h.store.getSet(setId);
    expect(stored?.setupId).toBeDefined();
    const setups = await h.store.listExerciseSetups({
      userId: 'local',
      exerciseId: 'bench-press',
    });
    expect(setups.map((s) => s.id)).toEqual([stored?.setupId]);
    expect(setups[0].label).toBe('setup 1');
    expect(setups[0].confirmedAt).toBeUndefined();
  });

  it('joins a like-for-like set to the same setup and a distant one to a new setup', async () => {
    const first = await performSet(h, 0.5);
    const alike = await performSet(h, 0.51);
    const different = await performSet(h, 0.9);

    const [a, b, c] = await Promise.all([first, alike, different].map((id) => h.store.getSet(id)));
    expect(b?.setupId).toBe(a?.setupId);
    expect(c?.setupId).not.toBe(a?.setupId);
    expect(
      await h.store.listExerciseSetups({ userId: 'local', exerciseId: 'bench-press' }),
    ).toHaveLength(2);
  });

  it('closes the set normally when the clustering throws', async () => {
    // The durable record is the set row, and it is already written by the time
    // the hook runs. A derived-state failure must never read as a failed close.
    const boom = vi
      .spyOn(h.store, 'putExerciseSetup')
      .mockRejectedValue(new Error('clustering exploded'));

    const setId = await performSet(h, 0.5);

    expect(boom).toHaveBeenCalled();
    const stored = await h.store.getSet(setId);
    expect(stored).toBeDefined();
    expect(stored?.reps).toHaveLength(4);
    expect(stored?.setupId).toBeUndefined();
  });
});
