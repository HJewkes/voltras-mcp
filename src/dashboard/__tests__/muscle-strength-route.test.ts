// Route-level tests for `GET /api/muscle-strength` (VW-330, plan B3).
//
// These run the real `node:http` server against an in-memory store fake, so the
// store gate, the catalog join through the VW-328 muscle map, the per-side
// `history.trend` fan-out and the JSON shape are exercised end to end. The pure
// projection is covered in `read-model-muscle-strength.test.ts`.

import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest, type IncomingMessage } from 'node:http';

import {
  DEFAULT_DASHBOARD_HOST,
  startDashboardServer,
  type DashboardServerHandle,
  type DashboardServerState,
} from '../server.js';
import { TITAN_MUSCLE_GROUPS } from '../../exercises/muscle-map.js';
import type {
  ExerciseSetsFilter,
  StoredDietPhase,
  StoredSession,
  StoredSet,
  StoredSide,
  StoredTrainingProfile,
} from '../../store/types.js';

const handles: DashboardServerHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    await handles
      .pop()
      ?.close()
      .catch(() => undefined);
  }
});

const CATALOG = [
  { id: 'cable-chest-press', name: 'Cable Chest Press', muscleGroups: ['chest'] },
  { id: 'cable-fly', name: 'Cable Fly', muscleGroups: ['chest'] },
  { id: 'single-arm-row', name: 'Single-Arm Row', muscleGroups: ['back'] },
];

/** Weeks back from now, so every fixture set lands inside the 12-week window. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function storedSet(over: Partial<StoredSet> & { id: string }): StoredSet {
  return {
    sessionId: 'ses-1',
    startedAt: daysAgo(7),
    endedAt: daysAgo(7),
    partial: false,
    weightLbs: 100,
    firmwareRepCount: 5,
    reps: [],
    ...over,
  } as StoredSet;
}

/** A month of weekly sessions, so the fit has points to run through. */
function weeklyHistory(exerciseId: string, side?: StoredSide): StoredSet[] {
  return [0, 1, 2, 3].map((week) =>
    storedSet({
      id: `${exerciseId}-${side ?? 'none'}-${week}`,
      sessionId: `ses-${exerciseId}-${side ?? 'none'}-${week}`,
      exerciseId,
      startedAt: daysAgo(28 - week * 7),
      weightLbs: 100 + week * 10,
      ...(side === undefined ? {} : { side }),
    }),
  );
}

class FakeStrengthStore {
  constructor(
    private readonly sets: StoredSet[],
    private readonly profile: StoredTrainingProfile | undefined,
  ) {}

  private inWindow(filter: { from?: string; to?: string }): StoredSet[] {
    return this.sets.filter(
      (set) =>
        (filter.from === undefined || set.startedAt >= filter.from) &&
        (filter.to === undefined || set.startedAt < filter.to),
    );
  }

  listSessions = async (filter: { from?: string; to?: string }): Promise<StoredSession[]> =>
    [...new Set(this.inWindow(filter).map((set) => set.sessionId))].map(
      (id) => ({ id, startedAt: daysAgo(7) }) as StoredSession,
    );

  getSetsForSession = async (sessionId: string): Promise<StoredSet[]> =>
    this.sets.filter((set) => set.sessionId === sessionId);

  getSetsForExercise = async (filter: ExerciseSetsFilter): Promise<StoredSet[]> =>
    this.inWindow(filter).filter(
      (set) =>
        set.exerciseId === filter.exerciseId &&
        (filter.side === undefined || set.side === filter.side),
    );

  getDietPhaseCovering = async (): Promise<StoredDietPhase | undefined> => undefined;

  getTrainingProfile = async (): Promise<StoredTrainingProfile | undefined> => this.profile;
}

function makeState(sets: StoredSet[], profile?: StoredTrainingProfile): DashboardServerState {
  return {
    slots: new Map(),
    store: new FakeStrengthStore(sets, profile) as unknown as DashboardServerState['store'],
    exercises: { getById: (id) => CATALOG.find((e) => e.id === id) },
  };
}

interface StrengthRow {
  exerciseId: string;
  side: 'left' | 'right' | null;
  bestE1rm: { value: number } | null;
  slopePctPerWeek: number | null;
  isPR: boolean;
}

interface StrengthBody {
  muscleMapVersion: string;
  muscles: { muscle: string; exercises: StrengthRow[]; agreement: string; earlyPhase: boolean }[];
}

async function get(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: DEFAULT_DASHBOARD_HOST, port, path, method: 'GET' },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: text === '' ? null : JSON.parse(text) });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function start(state: DashboardServerState): Promise<number> {
  const handle = await startDashboardServer({ port: 0, state });
  handles.push(handle);
  return handle.port;
}

function muscle(body: StrengthBody, slug: string): StrengthBody['muscles'][number] {
  const found = body.muscles.find((m) => m.muscle === slug);
  if (found === undefined) throw new Error(`no muscle row for '${slug}'`);
  return found;
}

describe('GET /api/muscle-strength', () => {
  it('answers every titan slug, joining exercises through the muscle map', async () => {
    const sets = [...weeklyHistory('cable-chest-press'), ...weeklyHistory('cable-fly')];
    const port = await start(makeState(sets));

    const res = await get(port, '/api/muscle-strength');
    const body = res.body as StrengthBody;

    expect(res.status).toBe(200);
    expect(body.muscles.map((m) => m.muscle)).toEqual([...TITAN_MUSCLE_GROUPS]);
    expect(muscle(body, 'chest').exercises.map((row) => row.exerciseId)).toEqual([
      'cable-chest-press',
      'cable-fly',
    ]);
    // `back` maps to lats AND upper_back (VW-328); neither was trained here.
    expect(muscle(body, 'lats').exercises).toEqual([]);
  });

  it('fits a rising pair and calls the muscle stronger', async () => {
    const sets = [...weeklyHistory('cable-chest-press'), ...weeklyHistory('cable-fly')];
    const port = await start(makeState(sets));

    const body = (await get(port, '/api/muscle-strength')).body as StrengthBody;
    const chest = muscle(body, 'chest');

    expect(chest.agreement).toBe('stronger');
    for (const row of chest.exercises) {
      expect(row.slopePctPerWeek).toBeGreaterThan(0);
      expect(row.isPR).toBe(true);
    }
  });

  it('fits each limb of a bilateral exercise separately, never pooled', async () => {
    const sets = [
      ...weeklyHistory('single-arm-row', 'left'),
      ...weeklyHistory('single-arm-row', 'right').map((set) => ({
        ...set,
        weightLbs: (set.weightLbs ?? 0) + 25,
      })),
    ];
    const port = await start(makeState(sets));

    const body = (await get(port, '/api/muscle-strength')).body as StrengthBody;
    const rows = muscle(body, 'lats').exercises;

    expect(rows.map((row) => row.side)).toEqual(['left', 'right']);
    expect(rows.some((row) => row.side === null)).toBe(false);
    const [left, right] = rows;
    expect(right?.bestE1rm?.value).toBeGreaterThan(left?.bestE1rm?.value ?? 0);
    // `upper_back` is the same exercise's other mapped slug: still two rows.
    expect(muscle(body, 'upper_back').exercises).toHaveLength(2);
  });

  it('flags the early phase from a declared training age under six months', async () => {
    const profile: StoredTrainingProfile = {
      userId: 'local',
      yearsTraining: 0.25,
      updatedAt: daysAgo(1),
    };
    const port = await start(makeState(weeklyHistory('cable-chest-press'), profile));

    const body = (await get(port, '/api/muscle-strength')).body as StrengthBody;

    expect(body.muscles.every((m) => m.earlyPhase)).toBe(true);
    expect(muscle(body, 'chest').exercises).toHaveLength(1);
  });

  it('501s rather than half-answering when the store cannot serve the read', async () => {
    const port = await start({
      slots: new Map(),
      store: { listSessions: async () => [] },
    });

    const res = await get(port, '/api/muscle-strength');

    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: 'strength_store_unavailable' });
  });
});
