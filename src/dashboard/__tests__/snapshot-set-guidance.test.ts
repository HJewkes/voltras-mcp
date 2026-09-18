// The snapshot's stop threshold (VW-440) and rest countdown (VW-441), and that
// `timer.start` and the dashboard give the same rest for the same inputs.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Phase, Rep } from '@voltras/workout-analytics';

vi.mock('@voltras/node-sdk', () => ({ VoltraSDKError: class extends Error {} }));

const { registerTimerTools, __resetTimerState } = await import('../../tools/timer-tools.js');
const { startDashboardServer } = await import('../server.js');
const { PRIMARY_SLOT } = await import('../../state/server-state.js');

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DashboardServerHandle, DashboardServerState } from '../server.js';
import type { ActiveSession, ActiveSet, DeviceSnapshot } from '../../state/live-state.js';
import type { ServerState } from '../../state/server-state.js';
import type { ToolResult } from '../../tools/helpers.js';
import type {
  StoredPlannedExercise,
  StoredProgramAssignment,
  StoredSet,
} from '../../store/types.js';

const SESSION_ID = 'sess-G';
const EXERCISE_ID = 'row';

const EMPTY_PHASE: Phase = {
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
  _peakVelocityTime: 0,
  _lastMovementVelocity: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

function rep(repNumber: number, peakVelocity: number): Rep {
  return {
    repNumber,
    concentric: {
      ...EMPTY_PHASE,
      peakVelocity,
      _totalVelocity: peakVelocity,
      _movementSampleCount: 1,
    },
    eccentric: { ...EMPTY_PHASE },
  };
}

function closedSet(setId: string, velocities: number[], over: Partial<ActiveSet> = {}): ActiveSet {
  return {
    setId,
    sessionId: SESSION_ID,
    exerciseId: EXERCISE_ID,
    startedAt: '2026-09-18T12:00:00.000Z',
    endedAt: '2026-09-18T12:01:00.000Z',
    status: 'ended',
    reps: velocities.map((v, i) => rep(i + 1, v)),
    ...over,
  };
}

// Under a VL30 threshold the first set crosses at rep 6, the second at rep 5.
const DROPPING = [
  closedSet('set-1', [1.0, 0.95, 0.9, 0.85, 0.8, 0.68, 0.6]),
  closedSet('set-2', [1.0, 0.92, 0.85, 0.78, 0.68]),
];

function planned(over: Partial<StoredPlannedExercise> = {}): StoredPlannedExercise {
  return {
    id: 'pe-1',
    workoutTemplateId: 'tpl-1',
    exerciseId: EXERCISE_ID,
    orderIndex: 0,
    targetSets: 3,
    ...over,
  };
}

interface Fixture {
  sets: ActiveSet[];
  plan?: StoredPlannedExercise;
  noSession?: boolean;
}

function planStore(fixture: Fixture) {
  const assignments: StoredProgramAssignment[] = fixture.plan
    ? [{ id: 'a1', sessionId: SESSION_ID, workoutTemplateId: 'tpl-1', assignedAt: '' }]
    : [];
  return {
    getAssignmentsForSession: async () => assignments,
    getPlannedExercisesForTemplate: async () => (fixture.plan ? [fixture.plan] : []),
    getPlannedExercise: async () => fixture.plan,
  };
}

const session: ActiveSession = {
  sessionId: SESSION_ID,
  startedAt: '2026-09-18T12:00:00.000Z',
  exerciseId: EXERCISE_ID,
  setIds: [],
  status: 'active',
};

function dashboardState(fixture: Fixture): DashboardServerState {
  return {
    slots: new Map([
      [
        'primary',
        {
          live: {
            snapshotDevice: (): DeviceSnapshot => ({ connected: true }),
            snapshotSession: () => (fixture.noSession ? undefined : session),
            snapshotSet: () => undefined,
            snapshotCompletedSets: () =>
              fixture.sets.map((set) => ({ set, device: { connected: true } })),
          },
        },
      ],
    ]),
    store: { listSessions: async () => [], ...planStore(fixture) },
  };
}

const handles: DashboardServerHandle[] = [];

afterEach(async () => {
  __resetTimerState();
  while (handles.length > 0) await handles.pop()?.close();
});

interface GuidanceBody {
  fatigueStop: { pct: number; intent: string | null; source: string };
  rest: { seconds: number; source: string; extensionSeconds: number } | null;
}

async function snapshotGuidance(fixture: Fixture): Promise<GuidanceBody> {
  const handle = await startDashboardServer({ port: 0, state: dashboardState(fixture) });
  handles.push(handle);
  const res = await fetch(`http://127.0.0.1:${String(handle.port)}/api/snapshot`);
  return (await res.json()) as GuidanceBody;
}

async function timerRestSeconds(fixture: Fixture): Promise<number> {
  const stored = fixture.sets.map((set) => ({ ...set, id: set.setId, partial: false }));
  const state = {
    channels: { publish: vi.fn() },
    timers: new Map(),
    slots: new Map([[PRIMARY_SLOT, { live: { session } }]]),
    store: {
      getSetsForSession: async () => stored as unknown as StoredSet[],
      ...planStore(fixture),
    },
  } as unknown as ServerState;
  let start: ((args: unknown) => Promise<ToolResult>) | undefined;
  const placeholders = new Map<string, RegisteredTool>(
    ['timer.wait', 'timer.start', 'timer.cancel'].map((name) => [
      name,
      {
        update: ({ callback }: { callback?: (args: unknown) => Promise<ToolResult> }) => {
          if (name === 'timer.start' && callback) start = callback;
        },
      } as unknown as RegisteredTool,
    ]),
  );
  registerTimerTools({} as McpServer, state, placeholders);
  const result = await start!({ label: 'rest' });
  const body = JSON.parse(result.content[0].text) as { durationMs: number };
  return body.durationMs / 1000;
}

describe('snapshot rest (VW-441)', () => {
  it.each<[string, Fixture, number, string]>([
    ['a coach-set rest', { sets: DROPPING, plan: planned({ restSec: 90 }) }, 90, 'explicit_plan'],
    [
      'the intent default',
      { sets: DROPPING.slice(0, 1), plan: planned({ trainingIntent: 'strength' }) },
      150,
      'intent_default',
    ],
    [
      'the extended default',
      { sets: DROPPING, plan: planned({ trainingIntent: 'hypertrophy' }) },
      135,
      'intent_default_extended',
    ],
    ['the unplanned default', { sets: DROPPING.slice(0, 1) }, 120, 'intent_default'],
  ])('carries %s, the same number timer.start gives', async (_name, fixture, seconds, source) => {
    const body = await snapshotGuidance(fixture);

    expect(body.rest).toMatchObject({ seconds, source });
    expect(await timerRestSeconds(fixture)).toBe(seconds);
  });

  it('carries no rest with no session open', async () => {
    const body = await snapshotGuidance({ sets: [], noSession: true });

    expect(body.rest).toBeNull();
  });
});

describe('snapshot fatigueStop (VW-440)', () => {
  it.each([
    ['strength', 20],
    ['hypertrophy', 30],
    ['power', 10],
  ] as const)("keys a %s exercise's stop to %i%% from the plan", async (intent, pct) => {
    const body = await snapshotGuidance({ sets: [], plan: planned({ trainingIntent: intent }) });

    expect(body.fatigueStop).toEqual({ pct, intent, source: 'plan_intent' });
  });

  it('falls to the named 30% default with no plan intent', async () => {
    const body = await snapshotGuidance({ sets: [] });

    expect(body.fatigueStop).toEqual({ pct: 30, intent: null, source: 'default' });
  });
});
