// Byte-identical HTTP snapshot for the three routes touched by the w3-50
// read-model extraction (VMCP-03.03): `/api/session-plan`, `/api/history`, and
// `/api/session-summary/:id`. Written FIRST against the pre-refactor code and
// left unmodified through the extraction — a stored snapshot changing under
// the refactor is a behaviour change, which this task is not allowed to make.

import { describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import {
  addSampleToSet,
  createSet,
  MovementPhase,
  type Rep,
  type WorkoutSample,
} from '@voltras/workout-analytics';

import {
  DEFAULT_DASHBOARD_HOST,
  startDashboardServer,
  type DashboardServerState,
} from '../server.js';
import type { ActiveSession } from '../../state/live-state.js';
import type {
  StoredPlannedExercise,
  StoredSession,
  StoredSet,
  StoredTrainingBlock,
  StoredTrainingProgram,
  StoredTrainingWeek,
  StoredWorkoutTemplate,
} from '../../store/types.js';

function fetchPath(
  host: string,
  port: number,
  path: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// ── /api/session-plan fixture: tempo override, title chain, and an ordered,
// partly-catalog-named exercise rail all in one response ────────────────────

const SESSION: ActiveSession = {
  sessionId: 'sess-P',
  startedAt: '2026-05-09T12:00:00.000Z',
  exerciseId: 'bench',
  exerciseName: 'Bench',
  setIds: [],
  status: 'active',
};

const PLANNED: StoredPlannedExercise[] = [
  { id: 'pe2', workoutTemplateId: 't1', exerciseId: 'bench', orderIndex: 1, targetSets: 3 },
  {
    id: 'pe1',
    workoutTemplateId: 't1',
    exerciseId: 'squat',
    orderIndex: 0,
    targetSets: 4,
    targetRepsLow: 5,
    targetRepsHigh: 5,
    targetWeightLbs: 185,
    targetRpe: 8,
    restSec: 180,
    targetTempo: { ecc: 4, pauseBottom: 2, con: 1, pauseTop: 0 },
  },
  { id: 'pe3', workoutTemplateId: 't1', exerciseId: 'row', orderIndex: 2, targetSets: 3 },
];

// ── /api/history fixture: several sessions, exercised through a non-default limit ──

function storedSession(id: string): StoredSession {
  return { id, startedAt: `2026-05-0${id}T09:00:00.000Z`, endedAt: `2026-05-0${id}T10:00:00.000Z` };
}
const HISTORY_SESSIONS: StoredSession[] = [
  storedSession('1'),
  storedSession('2'),
  storedSession('3'),
];

// ── /api/session-summary fixture: multi-exercise, real VBT reps, a working
// progression recommendation, and a warm-up excluded from the working count ──

const PROGRAM: StoredTrainingProgram = {
  id: 'prog-1',
  name: 'Base Build',
  createdAt: '2026-07-01T00:00:00.000Z',
};
const BLOCK: StoredTrainingBlock = {
  id: 'blk-1',
  programId: 'prog-1',
  orderIndex: 0,
  name: 'Push',
  focus: 'hypertrophy',
  weeksCount: 1,
};
const WEEK: StoredTrainingWeek = { id: 'wk-1', blockId: 'blk-1', orderIndex: 0 };
const TEMPLATE: StoredWorkoutTemplate = {
  id: 'tpl-1',
  weekId: 'wk-1',
  name: 'Push A',
  orderIndex: 0,
};

const SUMMARY_SESSION: StoredSession = {
  id: 'sess-S',
  startedAt: '2026-07-30T10:00:00.000Z',
  endedAt: '2026-07-30T11:00:00.000Z',
  exerciseId: 'bench',
};

function plannedRow(exerciseId: string): StoredPlannedExercise {
  return {
    id: `pe-${exerciseId}`,
    workoutTemplateId: 'tpl-1',
    exerciseId,
    orderIndex: 0,
    targetSets: 3,
    targetRepsLow: 8,
    targetRepsHigh: 10,
    targetWeightLbs: 100,
  };
}

/** Four samples spanning one rep's concentric + eccentric phase. */
function repSamples(concVel: number, seq: number, t0: number): WorkoutSample[] {
  return [
    {
      sequence: seq,
      timestamp: t0,
      phase: MovementPhase.CONCENTRIC,
      position: 0,
      velocity: concVel,
      force: 100,
    },
    {
      sequence: seq + 1,
      timestamp: t0 + 500,
      phase: MovementPhase.CONCENTRIC,
      position: 0.5,
      velocity: concVel,
      force: 100,
    },
    {
      sequence: seq + 2,
      timestamp: t0 + 600,
      phase: MovementPhase.ECCENTRIC,
      position: 0.5,
      velocity: concVel * 0.5,
      force: 80,
    },
    {
      sequence: seq + 3,
      timestamp: t0 + 1600,
      phase: MovementPhase.ECCENTRIC,
      position: 0,
      velocity: concVel * 0.5,
      force: 80,
    },
  ];
}

function buildReps(repCount: number, first: number, last: number): Rep[] {
  let set = createSet();
  let t = 1000;
  for (let i = 0; i < repCount; i += 1) {
    const ratio = repCount === 1 ? 0 : i / (repCount - 1);
    const velocity = first + (last - first) * ratio;
    for (const sample of repSamples(velocity, i * 4, t)) set = addSampleToSet(set, sample);
    t += 3000;
  }
  return [...set.reps];
}

function makeSet(
  id: string,
  exerciseId: string,
  repCount: number,
  overrides: Partial<StoredSet> = {},
): StoredSet {
  return {
    id,
    sessionId: SUMMARY_SESSION.id,
    startedAt: '2026-07-30T10:00:00.000Z',
    endedAt: '2026-07-30T10:02:00.000Z',
    partial: false,
    weightLbs: 100,
    exerciseId,
    reps: buildReps(repCount, 0.9, 0.6) as StoredSet['reps'],
    ...overrides,
  };
}

const SUMMARY_SETS: StoredSet[] = [
  makeSet('s0', 'bench', 5, { isWarmup: true, weightLbs: 45 }),
  makeSet('s1', 'bench', 10),
  makeSet('s2', 'bench', 8, { weightLbs: 120 }),
  makeSet('s3', 'row', 10, { weightLbs: 90 }),
];

const CATALOG_NAMES: Record<string, { name: string; movementPattern?: string }> = {
  squat: { name: 'Back Squat', movementPattern: 'squat' },
  bench: { name: 'Bench Press', movementPattern: 'push' },
};

function buildFixtureState(): DashboardServerState {
  return {
    slots: new Map([
      [
        'primary',
        {
          live: {
            snapshotDevice: () => ({ connected: false }),
            snapshotSession: () => SESSION,
            snapshotSet: () => undefined,
          },
        },
      ],
    ]),
    exercises: { getById: (id) => CATALOG_NAMES[id] },
    store: {
      listSessions: () => Promise.resolve(HISTORY_SESSIONS),
      getAssignmentsForSession: (sessionId) =>
        Promise.resolve(
          sessionId === SESSION.sessionId
            ? [{ id: 'a1', sessionId, workoutTemplateId: 't1', assignedAt: '' }]
            : [],
        ),
      getPlannedExercisesForTemplate: () => Promise.resolve(PLANNED),
      getWorkoutTemplate: () => Promise.resolve(TEMPLATE),
      getTrainingWeek: () => Promise.resolve(WEEK),
      getTrainingBlock: () => Promise.resolve(BLOCK),
      getSession: (id) => Promise.resolve(id === SUMMARY_SESSION.id ? SUMMARY_SESSION : undefined),
      getSetsForSession: (id) => Promise.resolve(id === SUMMARY_SESSION.id ? SUMMARY_SETS : []),
      listTrainingPrograms: () => Promise.resolve([PROGRAM]),
      getTrainingProgram: () => Promise.resolve(PROGRAM),
      getTrainingBlocksForProgram: () => Promise.resolve([BLOCK]),
      getTrainingWeeksForBlock: () => Promise.resolve([WEEK]),
      getWorkoutTemplatesForWeek: () => Promise.resolve([TEMPLATE]),
      getPlannedExercise: (id) =>
        Promise.resolve([plannedRow('bench'), plannedRow('row')].find((p) => p.id === id)),
      getAssignmentsForTemplate: () => Promise.resolve([]),
      putTrainingProgram: () => Promise.resolve(),
      putTrainingBlock: () => Promise.resolve(),
      putTrainingWeek: () => Promise.resolve(),
      putWorkoutTemplate: () => Promise.resolve(),
      putPlannedExercise: () => Promise.resolve(),
      deletePlannedExercise: () => Promise.resolve(true),
    },
  };
}

describe('dashboard route JSON — byte-identical before/after the read-model extraction', () => {
  it('GET /api/session-plan', async () => {
    const handle = await startDashboardServer({ port: 0, state: buildFixtureState() });
    try {
      const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/session-plan');
      expect(res.status).toBe(200);
      expect(res.body).toMatchSnapshot();
    } finally {
      await handle.close();
    }
  });

  it('GET /api/history', async () => {
    const handle = await startDashboardServer({ port: 0, state: buildFixtureState() });
    try {
      const res = await fetchPath(DEFAULT_DASHBOARD_HOST, handle.port, '/api/history?limit=2');
      expect(res.status).toBe(200);
      expect(res.body).toMatchSnapshot();
    } finally {
      await handle.close();
    }
  });

  it('GET /api/session-summary/:id', async () => {
    const handle = await startDashboardServer({ port: 0, state: buildFixtureState() });
    try {
      const res = await fetchPath(
        DEFAULT_DASHBOARD_HOST,
        handle.port,
        `/api/session-summary/${SUMMARY_SESSION.id}`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchSnapshot();
    } finally {
      await handle.close();
    }
  });
});
