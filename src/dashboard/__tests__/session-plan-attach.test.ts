// `/api/session-plan` attach resolution (VW-641): a plan attaches to a live
// session either as a whole template or as one planned exercise, and the first
// assignment that covers the active exercise wins.

import { describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';

import {
  DEFAULT_DASHBOARD_HOST,
  startDashboardServer,
  type DashboardServerState,
} from '../server.js';
import type { PrescriptionView } from '../read-models/session-plan.js';
import type {
  StoredPlannedExercise,
  StoredProgramAssignment,
  StoredTrainingBlock,
  StoredTrainingWeek,
  StoredWorkoutTemplate,
} from '../../store/types.js';

const SESSION_ID = 'sess-attach';

const TEMPLATE: StoredWorkoutTemplate = {
  id: 'tpl-1',
  weekId: 'wk-1',
  name: 'Push A',
  orderIndex: 0,
};
const WEEK: StoredTrainingWeek = { id: 'wk-1', blockId: 'blk-1', orderIndex: 0, isDeload: false };
const BLOCK: StoredTrainingBlock = {
  id: 'blk-1',
  programId: 'prog-1',
  orderIndex: 0,
  name: 'Push',
  focus: 'hypertrophy',
  weeksCount: 1,
};

function row(
  id: string,
  exerciseId: string,
  overrides: Partial<StoredPlannedExercise> = {},
): StoredPlannedExercise {
  return {
    id,
    workoutTemplateId: TEMPLATE.id,
    exerciseId,
    orderIndex: 0,
    targetSets: 3,
    targetRepsLow: 8,
    targetRepsHigh: 10,
    targetWeightLbs: 100,
    ...overrides,
  };
}

const TEMPLATE_ROWS = [
  row('pe-bench', 'bench', { targetSets: 4 }),
  row('pe-row', 'row', { orderIndex: 1 }),
];
const SINGLE_BENCH = row('pe-single-bench', 'bench', {
  targetSets: 5,
  targetRepsLow: 3,
  targetRepsHigh: 5,
  targetWeightLbs: 185,
});
const SINGLE_SQUAT = row('pe-single-squat', 'squat');

function assignment(target: Partial<StoredProgramAssignment>): StoredProgramAssignment {
  return {
    id: `a-${Object.values(target).join('-')}`,
    sessionId: SESSION_ID,
    assignedAt: '',
    ...target,
  };
}

function stateWith(assignments: StoredProgramAssignment[]): DashboardServerState {
  const singles = [SINGLE_BENCH, SINGLE_SQUAT];
  return {
    slots: new Map([
      [
        'primary',
        {
          live: {
            snapshotDevice: () => ({ connected: false }),
            snapshotSession: () => ({
              sessionId: SESSION_ID,
              startedAt: '2026-05-09T12:00:00.000Z',
              exerciseId: 'bench',
              exerciseName: 'Bench',
              setIds: [],
              status: 'active',
            }),
            snapshotSet: () => undefined,
          },
        },
      ],
    ]),
    exercises: {
      getById: (id) => ({ name: id === 'bench' ? 'Bench Press' : id, muscleGroups: [] }),
    },
    store: {
      listSessions: () => Promise.resolve([]),
      getAssignmentsForSession: () => Promise.resolve(assignments),
      getPlannedExercisesForTemplate: () => Promise.resolve(TEMPLATE_ROWS),
      getPlannedExercise: (id) => Promise.resolve(singles.find((p) => p.id === id)),
      getWorkoutTemplate: () => Promise.resolve(TEMPLATE),
      getTrainingWeek: () => Promise.resolve(WEEK),
      getTrainingBlock: () => Promise.resolve(BLOCK),
    },
  };
}

function getJson(port: number, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: DEFAULT_DASHBOARD_HOST, port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchPlan(
  assignments: StoredProgramAssignment[],
): Promise<{ plan: PrescriptionView | null }> {
  const handle = await startDashboardServer({ port: 0, state: stateWith(assignments) });
  try {
    return (await getJson(handle.port, '/api/session-plan')) as {
      plan: PrescriptionView | null;
    };
  } finally {
    await handle.close();
  }
}

describe('/api/session-plan attach resolution (VW-641)', () => {
  it('marks a template attach as prescribed and rails the whole template', async () => {
    const { plan: prescription } = await fetchPlan([
      assignment({ workoutTemplateId: TEMPLATE.id }),
    ]);

    expect(prescription?.source).toBe('prescribed');
    expect(prescription?.sets).toBe(4);
    expect(prescription?.exercises?.map((e) => e.name)).toEqual(['Bench Press', 'row']);
  });

  it('resolves a single-exercise attach to its targets, a one-row rail and the template title', async () => {
    const { plan: prescription } = await fetchPlan([
      assignment({ plannedExerciseId: SINGLE_BENCH.id }),
    ]);

    expect(prescription).toMatchObject({
      source: 'prescribed',
      sets: 5,
      repsLow: 3,
      repsHigh: 5,
      weightLbs: 185,
      title: 'Push A · Hypertrophy',
    });
    expect(prescription?.exercises).toEqual([
      {
        exerciseId: 'bench',
        name: 'Bench Press',
        order: 0,
        sets: 5,
        repsLow: 3,
        repsHigh: 5,
        weightLbs: 185,
        active: true,
      },
    ]);
  });

  it('returns no prescription for a single-exercise attach on another exercise', async () => {
    const { plan: prescription } = await fetchPlan([
      assignment({ plannedExerciseId: SINGLE_SQUAT.id }),
    ]);

    expect(prescription).toBeNull();
  });

  it('lets the first assignment that covers the active exercise win', async () => {
    const singleFirst = await fetchPlan([
      assignment({ plannedExerciseId: SINGLE_BENCH.id }),
      assignment({ workoutTemplateId: TEMPLATE.id }),
    ]);
    const templateFirst = await fetchPlan([
      assignment({ workoutTemplateId: TEMPLATE.id }),
      assignment({ plannedExerciseId: SINGLE_BENCH.id }),
    ]);

    expect(singleFirst.plan?.sets).toBe(5);
    expect(templateFirst.plan?.sets).toBe(4);
  });
});
