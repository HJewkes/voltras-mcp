// Set-level exercise scoping across the dashboard read paths (VMCP-01.72a).
//
// One seeded session holds two exercises — a 135 lb bench and a 325 lb squat —
// which today's `session.start` cannot produce. Before the migration the
// history endpoints matched the SESSION on its exercise and then folded the
// session's whole set list, so a squat set registered as a bench PR and the
// muscle heat map credited chest with the squat's sets.

import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { Phase, Rep } from '@voltras/workout-analytics';

import {
  startDashboardServer,
  type DashboardServerHandle,
  type DashboardServerState,
} from '../server.js';
import type { StoredSession, StoredSet } from '../../store/types.js';

const handles: DashboardServerHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    try {
      await handles.pop()?.close();
    } catch {
      // best-effort cleanup
    }
  }
});

const EMPTY_PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 0.4,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

/** Inside the muscle-volume endpoint's trailing-7-day window, whenever it runs. */
const RECENT = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function makeReps(count: number): Rep[] {
  return Array.from(
    { length: count },
    (_, i) =>
      ({
        repNumber: i + 1,
        concentric: {
          ...EMPTY_PHASE,
          peakVelocity: 0.7 - i * 0.03,
          _movementSampleCount: 10,
          _totalVelocity: (0.7 - i * 0.03) * 9,
        },
        eccentric: { ...EMPTY_PHASE, peakVelocity: 0.4 },
      }) as Rep,
  );
}

function makeSet(
  id: string,
  exerciseId: string | undefined,
  weightLbs: number,
  reps: number,
): StoredSet {
  return {
    id,
    sessionId: 'sess-mixed',
    startedAt: RECENT,
    endedAt: RECENT,
    partial: false,
    weightLbs,
    reps: makeReps(reps),
    ...(exerciseId !== undefined ? { exerciseId } : {}),
  } as StoredSet;
}

const MIXED_SESSION: StoredSession = {
  id: 'sess-mixed',
  startedAt: RECENT,
  endedAt: RECENT,
  exerciseId: 'bench-press',
} as StoredSession;

const MIXED_SETS: StoredSet[] = [
  makeSet('bench-1', 'bench-press', 135, 8),
  makeSet('bench-2', 'bench-press', 135, 8),
  makeSet('squat-1', 'back-squat', 325, 3),
];

const CATALOG: Record<string, { name: string; muscleGroups: string[]; secondary: string[] }> = {
  'bench-press': { name: 'Bench Press', muscleGroups: ['chest'], secondary: ['triceps'] },
  'back-squat': { name: 'Back Squat', muscleGroups: ['quads'], secondary: ['glutes'] },
};

function makeState(): DashboardServerState {
  return {
    slots: new Map(),
    store: {
      listSessions: () => Promise.resolve([MIXED_SESSION]),
      getSetsForSession: () => Promise.resolve(MIXED_SETS),
    },
    exercises: {
      getById: (id: string) => {
        const meta = CATALOG[id];
        if (meta === undefined) return undefined;
        return {
          name: meta.name,
          muscleGroups: meta.muscleGroups,
          secondaryMuscleGroups: meta.secondary,
        };
      },
    },
  } as unknown as DashboardServerState;
}

async function getJson(path: string): Promise<Record<string, unknown>> {
  const handle = await startDashboardServer({ port: 0, state: makeState() });
  handles.push(handle);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: handle.port, path, method: 'GET' },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve(JSON.parse(body) as Record<string, unknown>));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('GET /api/muscle-volume — set-level scoping', () => {
  it('credits the exercise with its own sets, not the whole session', async () => {
    const body = (await getJson('/api/muscle-volume')) as { muscles: Record<string, number> };
    // Two bench sets, primary chest at full weight and triceps as secondary.
    // Unscoped, the session's 3 sets are all credited to the bench's muscles.
    expect(body.muscles.chest).toBe(2);
    expect(body.muscles.quads).toBeUndefined();
  });
});

describe('GET /api/pr-history — set-level scoping', () => {
  it('does not register the session squat as a bench PR', async () => {
    const body = (await getJson('/api/pr-history?exerciseId=bench-press')) as {
      records: { type: string; value: number }[];
    };
    const weightPr = body.records.find((r) => r.type === 'weight');
    expect(weightPr?.value).toBe(135);
    for (const record of body.records) {
      expect(record.value).toBeLessThan(325);
    }
  });
});

describe('GET /api/exercise-trend — set-level scoping', () => {
  it('estimates the bench 1RM from bench sets only', async () => {
    const body = (await getJson('/api/exercise-trend?exerciseId=bench-press')) as {
      points: { e1rm: number }[];
    };
    expect(body.points).toHaveLength(1);
    // 135×8 estimates ~171 lb; the 325 lb triple would put it past 300.
    expect(body.points[0]!.e1rm).toBeLessThan(200);
  });
});
