// Unit tests for `session.checkin` and the `checkin` block on `session.end`
// (VMCP-06.12 / B41).
//
// Covers the five behaviours named in the brief:
//   (a) ending with a check-in writes N rows, and session.get returns them
//   (b) ending without one writes nothing
//   (c) the week-1 gate withholds soreness/joint/motivation for a lifter
//       with zero completed prior sessions
//   (d) a guest session (named `lifter`) writes nothing
//   (e) an unknown answer code is refused with INVALID_INPUT
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerState } from '../../state/server-state.js';
import type { SessionStore, StoredSelfReport, StoredSession } from '../../store/types.js';

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
const { registerSessionTools } = await import('../session-tools.js');
const { ModeRevertGuard } = await import('../../state/mode-revert-guard.js');

interface FakeRegisteredTool {
  callback?: (args: unknown, extra?: unknown) => Promise<unknown>;
  update(updates: { callback: (args: unknown, extra?: unknown) => Promise<unknown> }): void;
  remove(): void;
}

const TOOL_NAMES = [
  'session.start',
  'session.end',
  'session.checkin',
  'session.set_exercise',
  'session.set_lifter',
  'session.list',
  'session.get',
];

function makeFakePlaceholders(): {
  placeholders: Map<string, FakeRegisteredTool>;
  invoke: (
    name: string,
    args: unknown,
  ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
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
      return cb(args) as Promise<{ content: { text: string }[]; isError?: boolean }>;
    },
  };
}

type FakeStore = SessionStore & {
  countSessions: ReturnType<typeof vi.fn>;
  putSelfReport: ReturnType<typeof vi.fn>;
  getSelfReportsForSession: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
};

function makeStore(): FakeStore {
  const rows: StoredSelfReport[] = [];
  const sessions = new Map<string, StoredSession>();
  return {
    putSession: vi.fn(async (s: StoredSession) => {
      sessions.set(s.id, s);
    }),
    putSet: vi.fn(async () => {}),
    getSession: vi.fn(async (id: string) => sessions.get(id)),
    getSet: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => []),
    getSetsForSession: vi.fn(async () => []),
    countSessions: vi.fn(async () => 0),
    putSelfReport: vi.fn(async (r: StoredSelfReport) => {
      rows.push(r);
    }),
    getSelfReportsForSession: vi.fn(async (sessionId: string, kind?: string) =>
      rows.filter((r) => r.sessionId === sessionId && (kind === undefined || r.kind === kind)),
    ),
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
  } as unknown as FakeStore;
}

interface Harness {
  state: ServerState;
  invoke: (
    name: string,
    args: unknown,
  ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  store: FakeStore;
}

function setup(): Harness {
  const live = new LiveState();
  const store = makeStore();
  const slots = new Map();
  slots.set('primary', {
    slotId: 'primary',
    client: { endSet: vi.fn(async () => {}) } as never,
    live,
    modeRevertGuard: new ModeRevertGuard(),
  });
  const slotPublisher = {
    publish: () => {},
    forSlot: () => slotPublisher,
  };
  const state = {
    config: {} as never,
    manager: {} as never,
    slots,
    store,
    exercises: { search: vi.fn(() => []), getById: vi.fn(() => undefined) } as never,
    setWatchdog: { register: vi.fn(), reset: vi.fn(), cancel: vi.fn(), has: vi.fn(() => false) },
    restTimers: { start: vi.fn(), cancel: vi.fn(), dispose: vi.fn(), has: vi.fn(() => false) },
    setStartDeviceSnapshots: new Map(),
    lastSetEndedAtMs: new Map(),
    channels: { forSlot: () => slotPublisher },
    slotBindings: { get: () => null },
  } as unknown as ServerState;
  const { placeholders, invoke } = makeFakePlaceholders();
  registerSessionTools(
    { tool: vi.fn() } as unknown as Parameters<typeof registerSessionTools>[0],
    state,
    placeholders as unknown as Parameters<typeof registerSessionTools>[2],
  );
  return { state, invoke, store };
}

function parseResult(r: { content: { text: string }[] }): unknown {
  return JSON.parse(r.content[0].text);
}

describe('session.checkin (VMCP-06.12 / B41)', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('(a) session.end with a check-in writes one row per answer, and session.get returns them', async () => {
    // One prior completed session, so the week-1 gate does not withhold anything.
    h.store.countSessions.mockResolvedValue(1);
    await h.invoke('session.start', { exerciseName: 'Bench Press' });
    const sessionId = h.state.slots.get('primary')!.live.session!.sessionId;

    const r = await h.invoke('session.end', {
      checkin: {
        answers: [
          { code: 'went', value: 'Got all my sets in.' },
          { code: 'felt', value: 'Heavier than usual.' },
          { code: 'off', value: 'Left shoulder pinched on the last rep.' },
          { code: 'questions', value: 'Should I deload next week?' },
          { code: 'next', value: 'medium' },
        ],
      },
    });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { checkin?: { written: number; withheld: string[] } };
    expect(body.checkin).toEqual({ sessionId, written: 5, withheld: [] });
    expect(h.store.putSelfReport).toHaveBeenCalledTimes(5);

    const getResult = await h.invoke('session.get', { id: sessionId });
    const getBody = parseResult(getResult) as {
      checkin?: { answers: { code: string; value: string }[] };
    };
    expect(getBody.checkin?.answers).toHaveLength(5);
    expect(getBody.checkin?.answers).toEqual(
      expect.arrayContaining([{ code: 'went', value: 'Got all my sets in.' }]),
    );
  });

  it('(b) session.end without a check-in writes nothing and behaves exactly as before', async () => {
    await h.invoke('session.start', { exerciseName: 'Bench Press' });
    const r = await h.invoke('session.end', {});
    expect(r.isError).toBeUndefined();
    expect(parseResult(r)).toEqual({ ok: true });
    expect(h.store.putSelfReport).not.toHaveBeenCalled();
  });

  it('(c) the week-1 gate withholds soreness/joint/motivation for a lifter with no completed prior session', async () => {
    h.store.countSessions.mockResolvedValue(0);
    await h.invoke('session.start', { exerciseName: 'Bench Press' });

    const r = await h.invoke('session.end', {
      checkin: {
        answers: [
          { code: 'went', value: 'First session done.' },
          { code: 'soreness', value: 'low' },
          { code: 'joint', value: 'low' },
          { code: 'motivation', value: 'high' },
        ],
      },
    });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { checkin?: { written: number; withheld: string[] } };
    expect(body.checkin?.written).toBe(1);
    expect(body.checkin?.withheld.sort()).toEqual(['joint', 'motivation', 'soreness']);
    // Only the ungated answer actually landed in the store.
    expect(h.store.putSelfReport).toHaveBeenCalledTimes(1);
    expect((h.store.putSelfReport.mock.calls[0][0] as StoredSelfReport).questionCode).toBe('went');
  });

  it('(d) a guest session (named lifter) writes nothing', async () => {
    h.store.countSessions.mockResolvedValue(5);
    await h.invoke('session.start', { exerciseName: 'Bench Press', lifter: 'Jordan' });

    const r = await h.invoke('session.end', {
      checkin: { answers: [{ code: 'went', value: 'Worked in.' }] },
    });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { checkin?: { written: number; withheld: string[] } };
    expect(body.checkin).toEqual({
      sessionId: expect.any(String),
      written: 0,
      withheld: [],
    });
    expect(h.store.putSelfReport).not.toHaveBeenCalled();
  });

  it('(e) an unknown answer code is refused with INVALID_INPUT', async () => {
    await h.invoke('session.start', { exerciseName: 'Bench Press' });
    const r = await h.invoke('session.end', {
      checkin: { answers: [{ code: 'bogus', value: 'whatever' }] },
    });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
    expect(h.store.putSelfReport).not.toHaveBeenCalled();
  });

  it('the standalone session.checkin tool writes against the slot active session', async () => {
    h.store.countSessions.mockResolvedValue(2);
    await h.invoke('session.start', { exerciseName: 'Bench Press' });
    const sessionId = h.state.slots.get('primary')!.live.session!.sessionId;

    const r = await h.invoke('session.checkin', {
      answers: [{ code: 'felt', value: 'Solid.' }],
    });
    expect(r.isError).toBeUndefined();
    expect(parseResult(r)).toEqual({ sessionId, written: 1, withheld: [] });
  });

  it('session.checkin returns NO_ACTIVE_SESSION when no session is active and no sessionId is given', async () => {
    const r = await h.invoke('session.checkin', { answers: [{ code: 'felt', value: 'Solid.' }] });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('NO_ACTIVE_SESSION');
  });

  it('rejects a scale answer that is not low/medium/high with INVALID_INPUT', async () => {
    await h.invoke('session.start', { exerciseName: 'Bench Press' });
    const r = await h.invoke('session.end', {
      checkin: { answers: [{ code: 'next', value: 'super pumped' }] },
    });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('session.checkin sets preSessionCarbs on the active session (VW-307)', async () => {
    h.store.countSessions.mockResolvedValue(2);
    await h.invoke('session.start', { exerciseName: 'Bench Press' });
    const sessionId = h.state.slots.get('primary')!.live.session!.sessionId;

    const r = await h.invoke('session.checkin', {
      answers: [{ code: 'felt', value: 'Solid.' }],
      preSessionCarbs: { level: 'normal', hoursSinceLastMeal: 3 },
    });
    expect(r.isError).toBeUndefined();

    const stored = await h.store.getSession(sessionId);
    expect(stored?.preSessionCarbs).toEqual({ level: 'normal', hoursSinceLastMeal: 3 });
  });

  it('preSessionCarbs set via session.checkin survives the later session.end re-put', async () => {
    h.store.countSessions.mockResolvedValue(2);
    await h.invoke('session.start', { exerciseName: 'Bench Press' });
    const sessionId = h.state.slots.get('primary')!.live.session!.sessionId;

    await h.invoke('session.checkin', {
      answers: [{ code: 'felt', value: 'Solid.' }],
      preSessionCarbs: { level: 'high' },
    });
    await h.invoke('session.end', {});

    const stored = await h.store.getSession(sessionId);
    expect(stored?.preSessionCarbs).toEqual({ level: 'high' });
  });
});
