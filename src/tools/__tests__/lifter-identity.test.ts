// End-to-end coverage for the lifter label (VW-169): a second person works in
// on the owner's rig and must leave no trace in the owner's baselines,
// anchors, progression or history.
//
// These run against a REAL in-memory `SqliteSessionStore` rather than a mock,
// because the whole feature IS the owner-only default on the store's reads.
// A hand-written fake would answer every query the same way whether or not
// the `lifter IS NULL` predicate exists, which is exactly the bug to catch.

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
const { registerProgressionTools } = await import('../progression-tools.js');

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
  'progression.get_for_exercise',
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

/**
 * A rep with enough concentric telemetry to be a real observation: four of
 * these clear the baseline's `minRepsPerShapeSet` gate and the auto-arm's
 * tail-consistency check, so a set built from them actually moves derived
 * state instead of being filtered out before it counts.
 */
function makeRep(n: number): Rep {
  const phase = {
    samples: [],
    startTime: n * 3000,
    endTime: n * 3000 + 1500,
    startPosition: 0,
    endPosition: 0.5,
    _totalVelocity: 0.6,
    _totalForce: 100,
    _totalLoad: 100,
    _movementSampleCount: 1,
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
  published: { content: string; meta: Record<string, string> }[];
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
  const published: { content: string; meta: Record<string, string> }[] = [];
  const channels = {
    publish: (e: unknown) => {
      published.push(e as { content: string; meta: Record<string, string> });
    },
    forSlot: () => channels,
  };
  const slots = new Map();
  slots.set('primary', { slotId: 'primary', client, live, modeRevertGuard: new ModeRevertGuard() });
  const bindingDir = mkdtempSync(join(tmpdir(), 'vmcp-lifter-bindings-'));
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
  registerProgressionTools(server, state, cast);

  return {
    state,
    invoke,
    store,
    live,
    published,
    cleanup: () => {
      rmSync(bindingDir, { recursive: true, force: true });
      void store.close();
    },
  };
}

function parse(r: ToolResult): Record<string, unknown> {
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

/** Feed a set enough reps to be a real working set, then close it. */
async function performSet(h: Harness, repCount = 4): Promise<void> {
  for (let i = 1; i <= repCount; i++) h.live.appendRep(makeRep(i));
  await h.invoke('set.end', {});
}

/**
 * The state auto-arm leaves behind: a set the server opened on the lifter's
 * own reps, not yet claimed by a `set.start`. Installed directly rather than
 * driven through frames — this file is about the label, and the arm's own
 * frame handling is covered in `event-bridge-auto-arm.test.ts`.
 */
function armAutoSet(live: LiveStateType): void {
  live.startSet({
    setId: 'auto-armed-set',
    sessionId: live.session!.sessionId,
    startedAt: '2026-09-08T00:00:05.000Z',
    reps: [],
    status: 'active',
    autoCreatedBy: 'idle_rep',
    ...(live.session!.lifter !== undefined ? { lifter: live.session!.lifter } : {}),
  });
}

describe('a guest working in (VW-169)', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => {
    h.cleanup();
  });

  it('stamps the session lifter on its sets and derives nothing for the owner', async () => {
    // Arrange: the whole session belongs to a guest.
    const harvest = vi.spyOn(h.store, 'harvestFailureAnchor');
    const recalc = vi.spyOn(h.store, 'recalcBaseline');
    const started = parse(
      await h.invoke('session.start', { exerciseId: 'bench-press', lifter: 'Jordan' }),
    );
    const setId = (parse(await h.invoke('set.start', {})) as { setId: string }).setId;

    // Act.
    await performSet(h);

    // Assert: the label is on both rows, and the owner's derivations never ran.
    expect((await h.store.getSet(setId))?.lifter).toBe('Jordan');
    expect((await h.store.getSession(started.sessionId as string))?.lifter).toBe('Jordan');
    expect(harvest).not.toHaveBeenCalled();
    expect(recalc).not.toHaveBeenCalled();
    expect(
      await h.store.getBaseline({ userId: 'local', exerciseId: 'bench-press' }),
    ).toBeUndefined();
  });

  it("keeps deriving the owner's baseline for the owner's own set", async () => {
    // The control for the test above: the same flow without a lifter must
    // still move derived state, or "nothing happened" would prove nothing.
    const recalc = vi.spyOn(h.store, 'recalcBaseline');
    await h.invoke('session.start', { exerciseId: 'bench-press' });
    await h.invoke('set.start', {});

    await performSet(h);

    expect(recalc).toHaveBeenCalledTimes(1);
    expect(await h.store.getBaseline({ userId: 'local', exerciseId: 'bench-press' })).toBeDefined();
  });

  it('rewrites an auto-armed set’s label when set.start names a different lifter', async () => {
    // Arrange: the server armed a set on the lifter's own reps under the
    // owner's default. (The arm's own inheritance is covered where the frame
    // machinery lives, in event-bridge-auto-arm.test.ts.)
    await h.invoke('session.start', { exerciseId: 'bench-press' });
    armAutoSet(h.live);
    expect(h.live.set?.lifter).toBeUndefined();

    // Act: the upgrade is the operator's chance to say "that was Jordan"
    // about reps that had already begun.
    const result = parse(await h.invoke('set.start', { lifter: 'Jordan' }));

    // Assert.
    expect(result.upgraded).toBe(true);
    expect(h.live.set?.lifter).toBe('Jordan');
  });

  it('persists the rewritten label when the upgraded set closes', async () => {
    await h.invoke('session.start', { exerciseId: 'bench-press' });
    armAutoSet(h.live);
    const setId = h.live.set!.setId;

    await h.invoke('set.start', { lifter: 'Jordan' });
    await performSet(h);

    expect((await h.store.getSet(setId))?.lifter).toBe('Jordan');
  });

  it('leaves an open set alone and labels only the next one', async () => {
    // Arrange: the owner is mid-set when the guest is announced.
    await h.invoke('session.start', { exerciseId: 'bench-press' });
    const ownerSetId = (parse(await h.invoke('set.start', {})) as { setId: string }).setId;

    // Act.
    await h.invoke('session.set_lifter', { lifter: 'Jordan' });
    await performSet(h);
    const guestSetId = (parse(await h.invoke('set.start', {})) as { setId: string }).setId;
    await performSet(h);

    // Assert: reps already performed keep their attribution; the next set
    // inherits the new default.
    expect(await h.store.getSet(ownerSetId)).not.toHaveProperty('lifter');
    expect((await h.store.getSet(guestSetId))?.lifter).toBe('Jordan');
  });

  it('hands the rig back to the owner on session.set_lifter with null', async () => {
    await h.invoke('session.start', { exerciseId: 'bench-press', lifter: 'Jordan' });
    await h.invoke('session.set_lifter', { lifter: null });
    const setId = (parse(await h.invoke('set.start', {})) as { setId: string }).setId;

    await performSet(h);

    expect(await h.store.getSet(setId)).not.toHaveProperty('lifter');
  });

  it('carries the lifter on set_started only when someone other than the owner lifts', async () => {
    await h.invoke('session.start', { exerciseId: 'bench-press' });
    await h.invoke('set.start', {});
    await performSet(h);
    await h.invoke('set.start', { lifter: 'Jordan' });

    const startedEvents = h.published.filter((e) => e.meta.event_type === 'set_started');
    expect(startedEvents[0]?.meta).not.toHaveProperty('lifter');
    expect(startedEvents[1]?.meta.lifter).toBe('Jordan');
  });
});

describe('set.update relabelling (VW-169)', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => {
    h.cleanup();
  });

  it("moves a mislabelled set out and re-derives the owner's baseline without it", async () => {
    // Arrange: two sets recorded as the owner's, one of which was the guest's.
    const recalc = vi.spyOn(h.store, 'recalcBaseline');
    await h.invoke('session.start', { exerciseId: 'bench-press' });
    await h.invoke('set.start', {});
    await performSet(h);
    const guestSetId = (parse(await h.invoke('set.start', {})) as { setId: string }).setId;
    await performSet(h);
    const forExercise = vi.spyOn(h.store, 'getSetsForExercise');
    recalc.mockClear();

    // Act.
    const result = parse(await h.invoke('set.update', { setId: guestSetId, lifter: 'Jordan' }));

    // Assert: the row moved, the owner's recalc ran once, and the recalc's
    // own read no longer sees the relabelled set.
    expect(result.lifter).toBe('Jordan');
    expect((await h.store.getSet(guestSetId))?.lifter).toBe('Jordan');
    expect(recalc).toHaveBeenCalledTimes(1);
    const recalcInput = await forExercise.mock.results[0]!.value;
    expect((recalcInput as { id: string }[]).map((s) => s.id)).not.toContain(guestSetId);
  });

  it('moves a set back to the owner when it was labelled by mistake', async () => {
    await h.invoke('session.start', { exerciseId: 'bench-press', lifter: 'Jordan' });
    const setId = (parse(await h.invoke('set.start', {})) as { setId: string }).setId;
    await performSet(h);

    await h.invoke('set.update', { setId, lifter: null });

    expect(await h.store.getSet(setId)).not.toHaveProperty('lifter');
  });

  it('reports SET_NOT_FOUND rather than silently doing nothing', async () => {
    const r = await h.invoke('set.update', { setId: 'no-such-set', lifter: 'Jordan' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('SET_NOT_FOUND');
  });
});

describe('owner-scoped history reads (VW-169)', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => {
    h.cleanup();
  });

  /** One closed session for `lifter`, with a single working set. */
  async function recordSession(lifter: string | null): Promise<string> {
    const started = parse(
      await h.invoke('session.start', {
        exerciseId: 'bench-press',
        ...(lifter !== null ? { lifter } : {}),
      }),
    );
    await h.invoke('set.start', {});
    await performSet(h);
    await h.invoke('session.end', {});
    return started.sessionId as string;
  }

  it('omits a guest session from session.list until it is asked for by label', async () => {
    const ownerSessionId = await recordSession(null);
    const guestSessionId = await recordSession('Jordan');

    const ownerView = JSON.parse((await h.invoke('session.list', {})).content[0]!.text) as {
      id: string;
    }[];
    const guestView = JSON.parse(
      (await h.invoke('session.list', { lifter: 'Jordan' })).content[0]!.text,
    ) as { id: string; lifter?: string }[];

    expect(ownerView.map((e) => e.id)).toEqual([ownerSessionId]);
    expect(guestView.map((e) => e.id)).toEqual([guestSessionId]);
    expect(guestView[0]?.lifter).toBe('Jordan');
  });

  it("keeps a guest's sets out of progression.get_for_exercise", async () => {
    await recordSession(null);
    await recordSession('Jordan');

    const owner = parse(
      await h.invoke('progression.get_for_exercise', { exerciseId: 'bench-press' }),
    );
    const guest = parse(
      await h.invoke('progression.get_for_exercise', {
        exerciseId: 'bench-press',
        lifter: 'Jordan',
      }),
    );

    // One session each: the guest's work never enters the owner's trend, and
    // asking for the guest by name returns theirs alone.
    expect(owner.sessionCount).toBe(1);
    expect(guest.sessionCount).toBe(1);
  });
});
