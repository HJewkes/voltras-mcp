// Unit tests for src/tools/set-tools.ts.
//
// Covers the `set.start` / `set.end` / `set.live_metrics` handlers:
//   * NO_ACTIVE_SESSION when set.start is invoked without a session (EC-03)
//   * SET_ALREADY_ACTIVE when a set is already in flight (EC-13)
//   * Set metadata at start time comes from `live.snapshotDevice()`
//   * NO_ACTIVE_SET on set.end without an active set (AC-17)
//   * set.live_metrics returns the live snapshot or `{ active: false }`
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
const { registerSetTools } = await import('../set-tools.js');
const { SetWatchdog } = await import('../../state/set-watchdog.js');
const { ModeRevertGuard } = await import('../../state/mode-revert-guard.js');
const { RestTimerRegistry } = await import('../../state/rest-timer.js');

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

const TOOL_NAMES = ['set.start', 'set.end', 'set.live_metrics', 'set.get'];

interface Harness {
  state: ServerState;
  invoke: (
    name: string,
    args: unknown,
  ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  store: ReturnType<typeof makeStore>;
  live: LiveStateType;
  channels: { publish: ReturnType<typeof vi.fn> };
}

function setup(): Harness {
  const live = new LiveState();
  const store = makeStore();
  const client = {
    startRecording: vi.fn().mockResolvedValue(undefined),
    endSet: vi.fn().mockResolvedValue(undefined),
    // <Bug-22> Default `isRowingActive` to false so existing tests are
    // unaffected; rowing-specific tests below override this on the slot's
    // client to exercise the guard.
    isRowingActive: false,
    // </Bug-22>
  };
  // Top-level publish mock collects every event; `forSlot(slotId)` returns
  // a publisher that re-routes through the same mock with `slot: slotId`
  // injected into meta. Mirrors the production
  // `slotScopedPublisher` shape so tests that don't touch slot meta keep
  // working unchanged while bilateral-aware assertions can read meta.slot.
  const channels: {
    publish: ReturnType<typeof vi.fn>;
    forSlot: (slotId: string) => {
      publish: (e: unknown) => void;
      forSlot: typeof channels.forSlot;
    };
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
  const state = {
    config: {} as never,
    manager: {} as never,
    slots,
    store,
    exercises: {} as never,
    channels,
    setStartDeviceSnapshots: new Map(),
    setWatchdog: new SetWatchdog(),
    restTimers: new RestTimerRegistry(),
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
    channels,
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

  it('publishes a set_started claude/channel event with full payload', async () => {
    const sessionId = startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 75, trainingMode: 'WeightTraining' });

    const r = await h.invoke('set.start', {});
    const setId = (parseResult(r) as { setId: string }).setId;
    expect(h.channels.publish).toHaveBeenCalledTimes(1);
    const event = h.channels.publish.mock.calls[0][0] as {
      content: string;
      meta: Record<string, string>;
    };
    expect(event.meta).toMatchObject({
      source: 'voltras',
      event_type: 'set_started',
      set_id: setId,
      session_id: sessionId,
      weight_lbs: '75',
      training_mode: 'WeightTraining',
    });
    const parsed = JSON.parse(event.content) as {
      summary: string;
      set: { set_id: string; session_id: string; weight_lbs: number; training_mode: string };
      previous_set_summary: unknown;
    };
    expect(parsed.summary).toContain('75 lbs');
    expect(parsed.summary).toContain('WeightTraining');
    expect(parsed.set).toMatchObject({
      set_id: setId,
      session_id: sessionId,
      weight_lbs: 75,
      training_mode: 'WeightTraining',
    });
    // First set in the session — no previous set to summarize.
    expect(parsed.previous_set_summary).toBeNull();
  });

  it('accepts a watch config and stores it on the active set', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    const r = await h.invoke('set.start', {
      watch: {
        notifyOn: [
          { type: 'rep_count_reached', value: 8 },
          { type: 'velocity_loss_exceeded', pct: 25 },
        ],
      },
    });
    expect(r.isError).toBeUndefined();
    expect(h.live.set?.watch).toBeDefined();
    expect(h.live.set?.watch?.notifyOn).toEqual([
      { type: 'rep_count_reached', value: 8 },
      { type: 'velocity_loss_exceeded', pct: 25 },
    ]);
    // A fresh dedupe ledger is provisioned alongside the watch config.
    expect(h.live.set?.firedTriggers).toBeInstanceOf(Set);
    expect(h.live.set?.firedTriggers?.size).toBe(0);
  });

  it('rejects an invalid watch spec via INVALID_INPUT (out-of-range pct)', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    const r = await h.invoke('set.start', {
      watch: {
        notifyOn: [{ type: 'velocity_loss_exceeded', pct: 150 }],
      },
    });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
    expect(h.live.set).toBeUndefined();
  });

  it('omitted watch config leaves live.set.watch + firedTriggers undefined', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});
    expect(h.live.set?.watch).toBeUndefined();
    expect(h.live.set?.firedTriggers).toBeUndefined();
  });

  it('set_started includes previous_set_summary when a prior set exists in the session', async () => {
    const sessionId = startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });

    const priorSet: StoredSet = {
      id: 'set-prev',
      sessionId,
      startedAt: '2025-01-01T00:00:00.000Z',
      endedAt: '2025-01-01T00:01:00.000Z',
      partial: false,
      trainingMode: 'WeightTraining',
      weightLbs: 100,
      reps: [
        { ...makeRep(1), id: 'r1', setId: 'set-prev', index: 0 },
        { ...makeRep(2), id: 'r2', setId: 'set-prev', index: 1 },
      ],
    };
    h.store.getSetsForSession.mockResolvedValueOnce([priorSet]);

    const r = await h.invoke('set.start', {});
    expect(r.isError).toBeUndefined();
    const event = h.channels.publish.mock.calls[0][0] as {
      content: string;
      meta: Record<string, string>;
    };
    const parsed = JSON.parse(event.content) as {
      previous_set_summary: { set_id: string; rep_count: number; weight_lbs: number };
    };
    expect(parsed.previous_set_summary).toMatchObject({
      set_id: 'set-prev',
      rep_count: 2,
      weight_lbs: 100,
    });
    expect(h.store.getSetsForSession).toHaveBeenCalledWith(sessionId);
  });

  // <Bug-22>
  describe('Rowing safety guard', () => {
    it('refuses set.start when trainingMode is Rowing — does NOT call startRecording', async () => {
      startSession(h.live);
      h.live.applySettings({ connected: true, weightLbs: 0, trainingMode: 'Rowing' });

      const r = await h.invoke('set.start', {});
      expect(r.isError).toBe(true);
      expect((parseResult(r) as { code: string }).code).toBe('ROWING_USE_TWO_STAGE');
      const slot = (
        h.state as unknown as {
          slots: Map<string, { client: { startRecording: ReturnType<typeof vi.fn> } }>;
        }
      ).slots.get('primary')!;
      expect(slot.client.startRecording).not.toHaveBeenCalled();
      expect(h.live.set).toBeUndefined();
    });

    it('refuses set.start when client.isRowingActive is true', async () => {
      startSession(h.live);
      h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
      const slot = (
        h.state as unknown as {
          slots: Map<
            string,
            { client: { startRecording: ReturnType<typeof vi.fn>; isRowingActive: boolean } }
          >;
        }
      ).slots.get('primary')!;
      slot.client.isRowingActive = true;

      const r = await h.invoke('set.start', {});
      expect(r.isError).toBe(true);
      expect((parseResult(r) as { code: string }).code).toBe('ROWING_USE_TWO_STAGE');
      expect(slot.client.startRecording).not.toHaveBeenCalled();
    });

    it('error message mentions the two-stage rowing tools', async () => {
      startSession(h.live);
      h.live.applySettings({ connected: true, weightLbs: 0, trainingMode: 'Rowing' });

      const r = await h.invoke('set.start', {});
      const payload = parseResult(r) as { message?: string };
      expect(payload.message ?? '').toMatch(/device\.enter_row_mode/);
      expect(payload.message ?? '').toMatch(/device\.start_row/);
    });
  });
  // </Bug-22>
});

// ── Bug 22 — Mode-revert guard refusal at set.start ──────────────────────
describe('set.start — mode-revert guard (Bug 22)', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  function arm(slot: { modeRevertGuard: { arm: (m: number) => void } }, mode: number): void {
    slot.modeRevertGuard.arm(mode);
  }

  it('refuses to engage the motor when the slot guard is latched (Rowing → WT revert)', async () => {
    startSession(h.live);
    // Device's *current* mode is the post-revert state (WT). The user
    // originally requested Rowing; the latch records that provenance.
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    const slot = h.state.slots.get('primary')!;
    // Simulate the bridge having observed a settings_update mid-window
    // that reported WeightTraining instead of the user-requested Rowing.
    arm(slot as never, 3); // Rowing
    (
      slot as never as { modeRevertGuard: { onSettingsUpdate: (m: number) => void } }
    ).modeRevertGuard.onSettingsUpdate(1); // WT

    const r = await h.invoke('set.start', {});
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('SET_ABORTED_BY_MODE_REVERT');
    // Motor must NOT have engaged.
    expect(
      (slot.client as { startRecording: ReturnType<typeof vi.fn> }).startRecording,
    ).not.toHaveBeenCalled();
    // No set should be active in live state.
    expect(h.live.set).toBeUndefined();
  });

  it('publishes a set_aborted_by_mode_revert channel event with requested/actual mode names', async () => {
    startSession(h.live);
    // Device's *current* mode is the post-revert state (WT). The user
    // originally requested Rowing; the latch records that provenance.
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    const slot = h.state.slots.get('primary')!;
    arm(slot as never, 3); // Rowing
    (
      slot as never as { modeRevertGuard: { onSettingsUpdate: (m: number) => void } }
    ).modeRevertGuard.onSettingsUpdate(1); // WT

    h.channels.publish.mockClear();
    await h.invoke('set.start', {});

    const abortEvent = h.channels.publish.mock.calls
      .map((c) => c[0] as { meta: Record<string, string>; content: string })
      .find((e) => e.meta.event_type === 'set_aborted_by_mode_revert');
    expect(abortEvent).toBeDefined();
    expect(abortEvent!.meta.requested_mode).toBe('Rowing');
    expect(abortEvent!.meta.actual_mode).toBe('WeightTraining');
    const parsed = JSON.parse(abortEvent!.content);
    expect(parsed.summary).toContain('reverted from Rowing to WeightTraining');
    expect(parsed.summary).toContain('Motor not engaged');
    expect(parsed.abort.reason).toBe('mode_revert');
  });

  it('clears the abort latch after refusal so a subsequent valid set.start can proceed', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    const slot = h.state.slots.get('primary')!;
    arm(slot as never, 3); // Rowing requested
    (
      slot as never as { modeRevertGuard: { onSettingsUpdate: (m: number) => void } }
    ).modeRevertGuard.onSettingsUpdate(1); // WT — latch

    // First call refuses.
    const refused = await h.invoke('set.start', {});
    expect(refused.isError).toBe(true);

    // Second call (user accepted the safety abort, retried with WT-as-current-mode):
    // the latch was consumed by the first refusal, the new arm at set.start
    // records WT (current mode), and no new revert has been observed.
    const retry = await h.invoke('set.start', {});
    expect(retry.isError).toBeUndefined();
    expect(
      (slot.client as { startRecording: ReturnType<typeof vi.fn> }).startRecording,
    ).toHaveBeenCalledTimes(1);
  });

  it('does NOT refuse when the guard is idle (no abort latched)', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });

    const r = await h.invoke('set.start', {});
    expect(r.isError).toBeUndefined();
    expect(
      (h.state.slots.get('primary')!.client as { startRecording: ReturnType<typeof vi.fn> })
        .startRecording,
    ).toHaveBeenCalled();
  });

  // ── VMCP-02.14: matched-mode cascade auto-clears the latch ─────────
  it('VMCP-02.14: a matched-mode setter cascade auto-clears the latch before set.start is retried', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    const slot = h.state.slots.get('primary')!;
    arm(slot as never, 7); // Isokinetic requested
    (
      slot as never as { modeRevertGuard: { onSettingsUpdate: (m: number) => void } }
    ).modeRevertGuard.onSettingsUpdate(1); // WT — latches the abort
    expect(
      (
        slot as never as { modeRevertGuard: { isAborted: () => boolean } }
      ).modeRevertGuard.isAborted(),
    ).toBe(true);

    // User re-issues the setter cascade for Isokinetic. The device echoes
    // back Isokinetic within the window — the guard auto-clears the
    // latch (VMCP-02.14 recovery path) without anyone calling
    // session.end or consuming the abort via a refused set.start.
    arm(slot as never, 7); // Isokinetic re-armed
    (
      slot as never as { modeRevertGuard: { onSettingsUpdate: (m: number) => void } }
    ).modeRevertGuard.onSettingsUpdate(7); // Isokinetic echo → auto-clear

    expect(
      (
        slot as never as { modeRevertGuard: { isAborted: () => boolean } }
      ).modeRevertGuard.isAborted(),
    ).toBe(false);

    // set.start now proceeds normally — no refusal, motor engages.
    const r = await h.invoke('set.start', {});
    expect(r.isError).toBeUndefined();
    expect(
      (slot.client as { startRecording: ReturnType<typeof vi.fn> }).startRecording,
    ).toHaveBeenCalledTimes(1);
  });

  // ── VMCP-02.14: error message documents recovery paths ──────────────
  it('VMCP-02.14: SET_ABORTED_BY_MODE_REVERT message describes both recovery paths', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    const slot = h.state.slots.get('primary')!;
    arm(slot as never, 3); // Rowing requested
    (
      slot as never as { modeRevertGuard: { onSettingsUpdate: (m: number) => void } }
    ).modeRevertGuard.onSettingsUpdate(1); // WT — latch

    const r = await h.invoke('set.start', {});
    expect(r.isError).toBe(true);
    const body = parseResult(r) as { code: string; message: string };
    expect(body.code).toBe('SET_ABORTED_BY_MODE_REVERT');
    // Mentions the matched-mode cascade auto-clear recovery path.
    expect(body.message).toMatch(/re-issue the setter cascade/i);
    expect(body.message).toMatch(/auto-clears/i);
    // Mentions the session reset fallback.
    expect(body.message).toMatch(/session\.end \+ session\.start/i);
    // Points callers at get_state for inspection.
    expect(body.message).toMatch(/device\.get_state/);
    expect(body.message).toMatch(/mode_revert_latched/);
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

  it('publishes a set_ended claude/channel event with full rep array + vbt summary', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 75, trainingMode: 'WeightTraining' });
    const startResult = await h.invoke('set.start', {});
    const setId = (parseResult(startResult) as { setId: string }).setId;
    h.live.appendRep(makeRep(1));
    h.live.appendRep(makeRep(2));
    h.channels.publish.mockClear();

    await h.invoke('set.end', {});
    // set.end publishes both `set_ended` AND the initial passive
    // `rest_status` (VMCP-02.08) before this assertion runs. Filter to the
    // set_ended event for this test's intent.
    const setEndedCalls = h.channels.publish.mock.calls.filter(
      (c: unknown[]) => (c[0] as { meta: Record<string, string> }).meta.event_type === 'set_ended',
    );
    expect(setEndedCalls).toHaveLength(1);
    const event = setEndedCalls[0][0] as {
      content: string;
      meta: Record<string, string>;
    };
    expect(event.meta).toMatchObject({
      source: 'voltras',
      event_type: 'set_ended',
      set_id: setId,
      rep_count: '2',
    });
    // duration_ms is a non-negative integer string.
    expect(event.meta.duration_ms).toMatch(/^\d+$/);

    const parsed = JSON.parse(event.content) as {
      summary: string;
      set: { set_id: string; weight_lbs: number; training_mode: string; partial_reason: unknown };
      reps: Array<{ rep_number: number }>;
      vbt_summary: {
        first_rep_v: number | null;
        peak_rep_v: number | null;
        peak_rep_number: number | null;
        last_rep_v: number | null;
        velocity_loss_pct: number | null;
        mean_velocity: number | null;
      };
    };
    expect(parsed.summary).toContain('2 reps');
    expect(parsed.set.set_id).toBe(setId);
    expect(parsed.set.weight_lbs).toBe(75);
    expect(parsed.set.training_mode).toBe('WeightTraining');
    expect(parsed.set.partial_reason).toBeNull();
    // reps array length matches the meta rep_count.
    expect(parsed.reps).toHaveLength(2);
    expect(parsed.reps[0].rep_number).toBe(1);
    expect(parsed.reps[1].rep_number).toBe(2);
    // makeRep produces zero-velocity phases — vbt.velocity_loss_pct is null
    // (peak baseline <= 0 disables the loss calc), but the rest of the
    // vbt_summary fields are present and numeric.
    expect(parsed.vbt_summary.first_rep_v).toBe(0);
    expect(parsed.vbt_summary.last_rep_v).toBe(0);
    expect(parsed.vbt_summary.velocity_loss_pct).toBeNull();
  });

  it('explicit set.end produces unified set_ended with closed_by=tool', async () => {
    // Regression guard: the tool-driven set.end path emits the unified
    // `set_ended` event with `closed_by='tool'` and no `partial_reason`
    // so analytics consumers don't see a spurious partial flag on
    // graceful set ends. The autonomous device-signal close also uses
    // `set_ended` but with `closed_by='device'` (covered in event-bridge
    // tests).
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 50, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});
    h.live.appendRep(makeRep(1));
    h.channels.publish.mockClear();

    await h.invoke('set.end', {});
    const event = h.channels.publish.mock.calls[0][0] as {
      meta: Record<string, string>;
      content: string;
    };
    expect(event.meta.event_type).toBe('set_ended');
    expect(event.meta.closed_by).toBe('tool');
    expect(event.meta.partial_reason).toBeUndefined();
    const parsed = JSON.parse(event.content) as {
      set: { partial_reason: unknown; closed_by: string };
    };
    expect(parsed.set.partial_reason).toBeNull();
    expect(parsed.set.closed_by).toBe('tool');
  });

  it('attaches device_summary to set_ended when an onSummary landed during the set', async () => {
    // Tool-driven set.end path symmetry with the device-signal close:
    // if applySummary fired during the set's lifetime, finalizeSet harvests
    // the captured summary via consumeLatestSummary and threads it into the
    // payload's device_summary block.
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 75, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});
    h.live.appendRep(makeRep(1));
    h.live.appendRep(makeRep(2));
    h.live.applySummary({
      schemaVersion: 3,
      setCounter: 1,
      repCount: 2,
      raw: new Uint8Array(140),
    });
    h.channels.publish.mockClear();

    await h.invoke('set.end', {});
    const event = h.channels.publish.mock.calls[0][0] as {
      meta: Record<string, string>;
      content: string;
    };
    expect(event.meta.event_type).toBe('set_ended');
    expect(event.meta.device_rep_count).toBe('2');
    expect(event.meta.device_schema_version).toBe('3');
    const parsed = JSON.parse(event.content) as {
      device_summary: { rep_count: number; schema_version: number };
    };
    expect(parsed.device_summary).toEqual({ rep_count: 2, schema_version: 3 });
  });

  it('omits device_summary from set_ended when no onSummary fired during the set', async () => {
    // Backwards-compat: pre-PR-C consumers reading the payload without a
    // device_summary expectation must still parse it cleanly.
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 75, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});
    h.live.appendRep(makeRep(1));
    h.channels.publish.mockClear();

    await h.invoke('set.end', {});
    const event = h.channels.publish.mock.calls[0][0] as {
      meta: Record<string, string>;
      content: string;
    };
    expect(event.meta.device_rep_count).toBeUndefined();
    expect(event.meta.device_schema_version).toBeUndefined();
    const parsed = JSON.parse(event.content) as { device_summary?: unknown };
    expect(parsed.device_summary).toBeUndefined();
  });

  it('set_ended vbt_summary.velocity_loss_pct is null when fewer than 2 reps', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 75, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});
    h.live.appendRep(makeRep(1));
    h.channels.publish.mockClear();

    await h.invoke('set.end', {});
    const event = h.channels.publish.mock.calls[0][0] as { content: string };
    const parsed = JSON.parse(event.content) as {
      reps: unknown[];
      vbt_summary: { velocity_loss_pct: number | null };
    };
    expect(parsed.reps).toHaveLength(1);
    expect(parsed.vbt_summary.velocity_loss_pct).toBeNull();
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

  it('omits latestInProgress when no onInProgress payload has landed', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});

    const r = await h.invoke('set.live_metrics', {});
    const body = parseResult(r) as { latestInProgress?: unknown };
    expect(body.latestInProgress).toBeUndefined();
  });

  it('surfaces latestInProgress once an onInProgress payload has been captured', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 135, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});

    h.live.applyInProgress(
      {
        peakForceTenths: 1500,
        currentForceTenths: 900,
        velocityCmPerSec: 42,
        targetWeightTenths: 1350,
        raw: new Uint8Array(79),
      },
      1_700_000_000_000,
    );

    const r = await h.invoke('set.live_metrics', {});
    const body = parseResult(r) as {
      latestInProgress?: {
        peakForceTenths: number;
        currentForceTenths: number;
        velocityCmPerSec: number;
        targetWeightTenths: number;
        capturedAt: number;
      };
    };
    expect(body.latestInProgress).toEqual({
      peakForceTenths: 1500,
      currentForceTenths: 900,
      velocityCmPerSec: 42,
      targetWeightTenths: 1350,
      capturedAt: 1_700_000_000_000,
    });
  });

  it('does not surface latestSummary through set.live_metrics (PR-C surface)', async () => {
    // latestSummary is captured on the active set but is intentionally
    // private — the persisted-set surface is what consumes it (the
    // unified `set_ended` payload's `device_summary` block). This test
    // pins the contract that live_metrics output does not include it as
    // a coaching read.
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {});
    h.live.applySummary({
      schemaVersion: 1,
      setCounter: 1,
      repCount: 5,
      raw: new Uint8Array(140),
    });

    const r = await h.invoke('set.live_metrics', {});
    // The structural snapshot DOES include latestSummary today (it lives on
    // ActiveSet), but the brief's contract is that we don't expose it as a
    // dedicated coaching surface — i.e. callers shouldn't treat it as a
    // documented field. We assert here only that latestInProgress is not
    // accidentally populated by an onSummary call.
    const body = parseResult(r) as { latestInProgress?: unknown };
    expect(body.latestInProgress).toBeUndefined();
  });
});

describe('set.get', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('returns the stored set including reps when one exists', async () => {
    const stored: StoredSet = {
      id: 'set-XYZ',
      sessionId: 'sess-A',
      startedAt: '2025-01-01T00:00:00.000Z',
      endedAt: '2025-01-01T00:01:00.000Z',
      partial: false,
      trainingMode: 'WeightTraining',
      weightLbs: 100,
      reps: [
        { ...makeRep(1), id: 'r1', setId: 'set-XYZ', index: 0 },
        { ...makeRep(2), id: 'r2', setId: 'set-XYZ', index: 1 },
      ],
    };
    h.store.getSet.mockResolvedValueOnce(stored);

    const r = await h.invoke('set.get', { setId: 'set-XYZ' });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as StoredSet;
    expect(body.id).toBe('set-XYZ');
    expect(body.reps.length).toBe(2);
    expect(body.weightLbs).toBe(100);
    expect(body.trainingMode).toBe('WeightTraining');
    expect(h.store.getSet).toHaveBeenCalledWith('set-XYZ');
  });

  it('returns SET_NOT_FOUND when no row exists for the given id', async () => {
    h.store.getSet.mockResolvedValueOnce(undefined);
    const r = await h.invoke('set.get', { setId: 'no-such-set' });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('SET_NOT_FOUND');
  });

  it('returns INVALID_INPUT when setId is missing', async () => {
    const r = await h.invoke('set.get', {});
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
  });
});

describe('set.start — idle_timeout_ms watchdog', () => {
  let h: Harness;

  beforeEach(() => {
    vi.useFakeTimers();
    h = setup();
  });

  afterEach(() => {
    // Drain any leftover scheduled idle timers between cases so background
    // setTimeouts don't bleed into the next test's assertions.
    (h.state.setWatchdog as { clearAll: () => void }).clearAll();
    vi.useRealTimers();
  });

  async function flushMicrotasks(): Promise<void> {
    // Drain a handful of microtask turns so void-chained awaits inside
    // fireIdleTimeout → finalizeSet (await client.endSet → await
    // store.putSet → publish) all settle before assertions. setImmediate
    // is intercepted by vi.useFakeTimers() so we use real Promise turns.
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
  }

  it('does not arm a watchdog when watch config has no inactivityTimeoutMs', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    const r = await h.invoke('set.start', {
      watch: { notifyOn: [{ type: 'rep_count_reached', value: 5 }] },
    });
    const id = (parseResult(r) as { setId: string }).setId;
    expect((h.state.setWatchdog as { has: (s: string) => boolean }).has(id)).toBe(false);
  });

  it('inactivityTimeoutMs arms the watchdog and force-closes on expiry', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    const r = await h.invoke('set.start', {
      watch: { inactivityTimeoutMs: 45_000 },
    });
    const setId = (parseResult(r) as { setId: string }).setId;
    expect((h.state.setWatchdog as { has: (id: string) => boolean }).has(setId)).toBe(true);
    h.channels.publish.mockClear();

    await vi.advanceTimersByTimeAsync(45_000);
    await flushMicrotasks();

    // idle_timeout publishes BEFORE set_ended.
    const eventTypes = h.channels.publish.mock.calls.map(
      (c) => (c[0] as { meta: Record<string, string> }).meta.event_type,
    );
    const idleIdx = eventTypes.indexOf('idle_timeout');
    const endedIdx = eventTypes.indexOf('set_ended');
    expect(idleIdx).toBeGreaterThan(-1);
    expect(endedIdx).toBeGreaterThan(idleIdx);

    // Inactivity is the one remaining force-close path: row stamped
    // partial with `inactivity_timeout`. Unified payload meta.closed_by
    // discriminator carries the close cause; the legacy auto_stop_cause
    // field is gone.
    expect(h.live.set).toBeUndefined();
    expect(h.store.putSet).toHaveBeenCalledTimes(1);
    const stored = h.store.putSet.mock.calls[0][0] as StoredSet;
    expect(stored.partial).toBe(true);
    expect(stored.partialReason).toBe('inactivity_timeout');

    const setEnded = h.channels.publish.mock.calls
      .map((c) => c[0] as { meta: Record<string, string> })
      .find((e) => e.meta.event_type === 'set_ended');
    expect(setEnded?.meta.closed_by).toBe('inactivity_timeout');
    expect(setEnded?.meta.auto_stop_cause).toBeUndefined();
  });

  it('rep finalization resets the watchdog so an active lifter does not trip it', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    const r = await h.invoke('set.start', {
      watch: { inactivityTimeoutMs: 30_000 },
    });
    const setId = (parseResult(r) as { setId: string }).setId;
    h.channels.publish.mockClear();

    // Advance 25s, then exercise resetIdleWatchdog directly (the bridge
    // does this on rep_finalized; we don't pull the bridge into this
    // unit-scoped harness).
    await vi.advanceTimersByTimeAsync(25_000);
    const { resetIdleWatchdog } = await import('../set-tools.js');
    resetIdleWatchdog(h.state, setId, h.live.set?.watch);

    // Another 25s with no further reset still leaves us at 25s into the
    // new 30s window — no fire.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(
      h.channels.publish.mock.calls.find(
        (c) => (c[0] as { meta: Record<string, string> }).meta.event_type === 'idle_timeout',
      ),
    ).toBeUndefined();

    // 5s more — total 30s since reset → fire.
    await vi.advanceTimersByTimeAsync(5_000);
    await flushMicrotasks();
    expect(
      h.channels.publish.mock.calls.find(
        (c) => (c[0] as { meta: Record<string, string> }).meta.event_type === 'idle_timeout',
      ),
    ).toBeDefined();
  });

  it('explicit set.end cancels the watchdog so no spurious fire after', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    await h.invoke('set.start', {
      watch: { inactivityTimeoutMs: 30_000 },
    });
    h.channels.publish.mockClear();

    await h.invoke('set.end', {});
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    // Only the set_ended event from the tool path — no idle_timeout.
    const idleEvents = h.channels.publish.mock.calls.filter(
      (c) => (c[0] as { meta: Record<string, string> }).meta.event_type === 'idle_timeout',
    );
    expect(idleEvents).toHaveLength(0);
  });
});

describe('rest_status wiring (VMCP-02.08)', () => {
  let h: Harness;

  beforeEach(() => {
    h = setup();
  });

  it('set.end publishes a rest_status (elapsed=0) immediately after set_ended', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });
    const startResult = await h.invoke('set.start', {});
    const setId = (parseResult(startResult) as { setId: string }).setId;
    h.channels.publish.mockClear();

    await h.invoke('set.end', {});
    // Expect: [set_ended, rest_status] (in that order — set_ended publishes
    // first, then the registry's initial emit).
    const eventTypes = h.channels.publish.mock.calls.map(
      (c) => (c[0] as { meta: Record<string, string> }).meta.event_type,
    );
    expect(eventTypes).toEqual(['set_ended', 'rest_status']);
    const restCall = h.channels.publish.mock.calls.find(
      (c) => (c[0] as { meta: Record<string, string> }).meta.event_type === 'rest_status',
    );
    expect(restCall).toBeDefined();
    const restEvent = restCall![0] as { meta: Record<string, string> };
    expect(restEvent.meta).toMatchObject({
      event_type: 'rest_status',
      slot: 'primary',
      set_id: setId,
      elapsed_seconds: '0',
    });
  });

  it('set.start cancels any in-flight rest_status before publishing set_started', async () => {
    startSession(h.live);
    h.live.applySettings({ connected: true, weightLbs: 100, trainingMode: 'WeightTraining' });

    // Run a full set.start → set.end cycle to arm the rest timer.
    await h.invoke('set.start', {});
    await h.invoke('set.end', {});
    expect(h.state.restTimers.has('primary')).toBe(true);

    // Next set.start cancels the in-flight rest timer for the slot.
    h.channels.publish.mockClear();
    await h.invoke('set.start', {});
    expect(h.state.restTimers.has('primary')).toBe(false);

    // The cancel runs AFTER the set_started publish, so the call sequence
    // observed on the channel during set.start is just `[set_started]`.
    const eventTypes = h.channels.publish.mock.calls.map(
      (c) => (c[0] as { meta: Record<string, string> }).meta.event_type,
    );
    expect(eventTypes).toEqual(['set_started']);
  });
});
