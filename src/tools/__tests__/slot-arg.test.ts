// Slot-argument acceptance tests (Step 2 of dual-Voltras refactor).
//
// Step 2 threads an optional `slot` field through every slot-bound tool
// schema. The contract is:
//   * omitting `slot` resolves to `PRIMARY_SLOT` (covered exhaustively by
//     the existing per-category test suites — those bodies pass `{}` and
//     still pass after Step 2).
//   * passing `slot: 'primary'` is accepted and routes to the primary slot.
//   * passing an unknown slot id propagates `Unknown slot: ...` from
//     `getSlot` as a structured tool error (no INVALID_INPUT — `slot` is
//     a free-form string in the schema).
//
// Coverage strategy: ONE happy-path + ONE unknown-slot test per tool
// category (device, set, session, mock). Replicating every existing test
// with a slot variant would double the suite without strengthening the
// invariant — Step 2 is pure plumbing, the per-category suites already
// cover handler behavior.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LiveState as LiveStateType } from '../../state/live-state.js';
import type { ServerState } from '../../state/server-state.js';
import type { SessionStore } from '../../store/types.js';
import type { Exercise, ExerciseService } from '../../exercises/exercise-service.js';

// SDK is stubbed so the static import chain doesn't pull native peers, and
// `TrainingMode` exists for device-tools' enum-name → number mapping.
class FakeVoltraSDKError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'VoltraSDKError';
    this.code = code;
  }
}

const FakeTrainingMode = {
  Idle: 0,
  WeightTraining: 1,
  ResistanceBand: 2,
  Rowing: 3,
  Damper: 4,
  CustomCurves: 6,
  Isokinetic: 7,
  Isometric: 8,
  0: 'Idle',
  1: 'WeightTraining',
  2: 'ResistanceBand',
  3: 'Rowing',
  4: 'Damper',
  6: 'CustomCurves',
  7: 'Isokinetic',
  8: 'Isometric',
} as const;

vi.mock('@voltras/node-sdk', () => ({
  TrainingMode: FakeTrainingMode,
  VoltraSDKError: FakeVoltraSDKError,
  VoltraClient: class {},
  VoltraManager: class {},
  MockBLEAdapter: class {},
}));

const { LiveState } = await import('../../state/live-state.js');
const { registerSessionTools } = await import('../session-tools.js');
const { registerSetTools } = await import('../set-tools.js');
const { registerDeviceTools } = await import('../device-tools.js');
const { registerMockTools } = await import('../mock-tools.js');
const { SetWatchdog } = await import('../../state/set-watchdog.js');

// ── Fakes ────────────────────────────────────────────────────────────────

interface FakeRegisteredTool {
  callback?: (args: unknown, extra?: unknown) => Promise<unknown>;
  update(updates: {
    paramsSchema?: unknown;
    callback: (args: unknown, extra?: unknown) => Promise<unknown>;
  }): void;
  remove(): void;
}

function makeFakePlaceholders(names: readonly string[]): {
  placeholders: Map<string, FakeRegisteredTool>;
  invoke: (
    name: string,
    args: unknown,
  ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
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
  return {
    placeholders,
    invoke: async (name, args) => {
      const cb = placeholders.get(name)?.callback;
      if (!cb) throw new Error(`no callback installed for ${name}`);
      return cb(args) as Promise<{ content: { text: string }[]; isError?: boolean }>;
    },
  };
}

function makeStore(): SessionStore {
  return {
    putSession: vi.fn(async () => {}),
    putSet: vi.fn(async () => {}),
    getSession: vi.fn(async () => undefined),
    getSet: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => []),
    getSetsForSession: vi.fn(async () => []),
    close: vi.fn(async () => {}),
  } as unknown as SessionStore;
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

function makeExercises(): ExerciseService {
  return {
    search: vi.fn(() => [BENCH]),
    getById: vi.fn((id: string) => (id === 'bench-press' ? BENCH : undefined)),
  } as unknown as ExerciseService;
}

interface FakeClient {
  isConnected: boolean;
  connectionState: string;
  connectedDeviceId: string | null;
  settings: {
    weight: number;
    chains: number;
    inverseChains: number;
    eccentric: number;
    mode: number;
    battery: number | null;
  };
  setAdapter: ReturnType<typeof vi.fn>;
  setWeight: ReturnType<typeof vi.fn>;
  setMode: ReturnType<typeof vi.fn>;
  setChains: ReturnType<typeof vi.fn>;
  setEccentric: ReturnType<typeof vi.fn>;
  startRecording: ReturnType<typeof vi.fn>;
  endSet: ReturnType<typeof vi.fn>;
  onPerRep: ReturnType<typeof vi.fn>;
  onInProgress: ReturnType<typeof vi.fn>;
  onSettingsUpdate: ReturnType<typeof vi.fn>;
  onConnectionStateChange: ReturnType<typeof vi.fn>;
  onFrame: ReturnType<typeof vi.fn>;
}

function makeFakeClient(): FakeClient {
  return {
    isConnected: false,
    connectionState: 'disconnected',
    connectedDeviceId: null,
    settings: {
      weight: 5,
      chains: 0,
      inverseChains: 0,
      eccentric: 0,
      mode: FakeTrainingMode.Idle,
      battery: null,
    },
    setAdapter: vi.fn(),
    setWeight: vi.fn(async () => undefined),
    setMode: vi.fn(async () => undefined),
    setChains: vi.fn(async () => undefined),
    setEccentric: vi.fn(async () => undefined),
    startRecording: vi.fn(async () => undefined),
    endSet: vi.fn(async () => undefined),
    onPerRep: vi.fn(),
    onInProgress: vi.fn(),
    onSettingsUpdate: vi.fn(),
    onConnectionStateChange: vi.fn(),
    onFrame: vi.fn(),
  };
}

interface Harness {
  state: ServerState;
  live: LiveStateType;
  client: FakeClient;
  invoke: (
    name: string,
    args: unknown,
  ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
}

const ALL_TOOL_NAMES = [
  // device
  'device.scan',
  'device.connect',
  'device.disconnect',
  'device.set_weight',
  'device.set_mode',
  'device.set_chains',
  'device.set_eccentric',
  'device.get_state',
  // session
  'session.start',
  'session.end',
  'session.list',
  'session.get',
  // set
  'set.start',
  'set.end',
  'set.live_metrics',
  'set.get',
  // mock
  'mock.configure',
  'mock.inject_error',
] as const;

function setup(): Harness {
  const live = new LiveState();
  const client = makeFakeClient();
  const slots = new Map();
  slots.set('primary', { slotId: 'primary', client, live });
  // ChannelPublisher fake: full interface (publish + forSlot) so the
  // production set-tools code can call `state.channels.forSlot(slotId).publish(...)`
  // without crashing. Slot-scoped publishes still resolve back to the
  // top-level `publish` mock, mirroring the real shape — tests that
  // care about slot meta can read it from the merged event.
  type FakeChannels = {
    publish: ReturnType<typeof vi.fn>;
    forSlot: (slotId: string) => {
      publish: (e: unknown) => void;
      forSlot: FakeChannels['forSlot'];
    };
  };
  const channels: FakeChannels = {
    publish: vi.fn(),
    forSlot: (slotId: string) => ({
      publish: (event: unknown) => {
        const e = event as { content: string; meta: Record<string, string> };
        channels.publish({ content: e.content, meta: { slot: slotId, ...e.meta } });
      },
      forSlot: channels.forSlot,
    }),
  };
  const state = {
    config: {} as never,
    manager: { scan: vi.fn(async () => []) } as never,
    slots,
    store: makeStore(),
    exercises: makeExercises(),
    channels,
    setStartDeviceSnapshots: new Map(),
    setWatchdog: new SetWatchdog(),
  } as unknown as ServerState;

  const { placeholders, invoke } = makeFakePlaceholders(ALL_TOOL_NAMES);
  const fakeServer = { tool: vi.fn() } as never;
  registerDeviceTools(fakeServer, state, placeholders as never);
  registerSessionTools(fakeServer, state, placeholders as never);
  registerSetTools(fakeServer, state, placeholders as never);
  registerMockTools(fakeServer, state, placeholders as never);
  return { state, live, client, invoke };
}

function parse(r: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

describe('slot argument plumbing (Step 2)', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  describe('device category', () => {
    it("accepts slot: 'primary' on device.set_weight and routes to the primary slot's client", async () => {
      const r = await h.invoke('device.set_weight', { lbs: 50, slot: 'primary' });
      expect(r.isError).toBeUndefined();
      expect(parse(r)).toEqual({ ok: true });
      expect(h.client.setWeight).toHaveBeenCalledWith(50);
    });

    it("rejects an unknown slot on device.set_weight with 'Unknown slot' (no client call)", async () => {
      const r = await h.invoke('device.set_weight', { lbs: 50, slot: 'left' });
      expect(r.isError).toBe(true);
      expect(String(parse(r).message)).toMatch(/Unknown slot/i);
      expect(h.client.setWeight).not.toHaveBeenCalled();
    });
  });

  describe('session category', () => {
    it("accepts slot: 'primary' on session.start and creates the session on that slot", async () => {
      const r = await h.invoke('session.start', { exerciseId: 'bench-press', slot: 'primary' });
      expect(r.isError).toBeUndefined();
      const body = parse(r);
      expect(typeof body.sessionId).toBe('string');
      expect(h.live.session?.sessionId).toBe(body.sessionId);
    });

    it('rejects an unknown slot on session.start with Unknown slot', async () => {
      const r = await h.invoke('session.start', {
        exerciseId: 'bench-press',
        slot: 'phantom',
      });
      expect(r.isError).toBe(true);
      expect(String(parse(r).message)).toMatch(/Unknown slot/i);
      expect(h.live.session).toBeUndefined();
    });
  });

  describe('set category', () => {
    it("accepts slot: 'primary' on set.start (after a session is active)", async () => {
      h.live.startSession({
        sessionId: 'sess-1',
        startedAt: '2025-01-01T00:00:00.000Z',
        setIds: [],
        status: 'active',
      });
      h.live.applySettings({ connected: true, weightLbs: 50, trainingMode: 'WeightTraining' });
      const r = await h.invoke('set.start', { slot: 'primary' });
      expect(r.isError).toBeUndefined();
      expect(typeof parse(r).setId).toBe('string');
      expect(h.client.startRecording).toHaveBeenCalled();
    });

    it('rejects an unknown slot on set.start with Unknown slot', async () => {
      h.live.startSession({
        sessionId: 'sess-1',
        startedAt: '2025-01-01T00:00:00.000Z',
        setIds: [],
        status: 'active',
      });
      const r = await h.invoke('set.start', { slot: 'right' });
      expect(r.isError).toBe(true);
      expect(String(parse(r).message)).toMatch(/Unknown slot/i);
      expect(h.client.startRecording).not.toHaveBeenCalled();
    });
  });

  describe('mock category', () => {
    it("accepts slot: 'primary' on mock.configure (still NOT_IMPLEMENTED but valid)", async () => {
      const r = await h.invoke('mock.configure', { weight: 50, slot: 'primary' });
      expect(r.isError).toBe(true);
      expect(parse(r).code).toBe('NOT_IMPLEMENTED');
    });

    it("accepts slot: 'primary' on mock.inject_error (still NOT_IMPLEMENTED but valid)", async () => {
      const r = await h.invoke('mock.inject_error', { type: 'connection', slot: 'primary' });
      expect(r.isError).toBe(true);
      expect(parse(r).code).toBe('NOT_IMPLEMENTED');
    });
  });
});
