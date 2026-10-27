// The persona core (VW-936): a seeded store the lifter-facing reads count, a
// fatigue shape that is the sim's own, and a seed that fixes every byte.

import type * as CryptoModule from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as sim from '../../../scripts/sim/lifter-model.js';
import { afterRest, performSet, type LifterParams } from '../personas/fatigue.js';
import { makeRng, personaById, seedPersona } from '../personas/index.js';
import { median } from '../../analytics/stats.js';
import { fetchGoalProgressViews } from '../../dashboard/goal-progress-api.js';
import { buildSessionSummary } from '../../dashboard/read-models/session-summary.js';
import { exportStore } from '../../store/portable/export.js';
import { openTestStore } from '../../store/__tests__/open-test-store.js';

// The store mints some row ids with randomUUID (weigh-ins, schedules). Counted
// here so two seeds of the same persona can be compared byte for byte.
const uuids = vi.hoisted(() => ({ next: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof CryptoModule>();
  const randomUUID = (): string =>
    `00000000-0000-4000-8000-${String(++uuids.next).padStart(12, '0')}`;
  return { ...actual, randomUUID, default: { ...actual, randomUUID } };
});

const NOW = new Date('2026-10-14T15:00:00.000Z');
const scratch: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  uuids.next = 0;
});

afterEach(() => {
  vi.useRealTimers();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'personas-core-'));
  scratch.push(dir);
  return dir;
}

/** Seed `personaId` into a fresh store file and export it; returns every exported file's bytes. */
async function seedAndExport(personaId: string, seed: number): Promise<Map<string, string>> {
  uuids.next = 0;
  const dir = scratchDir();
  const storePath = join(dir, 'store.sqlite');
  const store = openTestStore({ path: storePath });
  await seedPersona(store, personaById(personaId), NOW, makeRng(seed));
  await store.close();
  const outDir = join(dir, 'export');
  exportStore(storePath, outDir);
  return new Map(
    readdirSync(outDir).map((file) => [file, readFileSync(join(outDir, file), 'utf8')]),
  );
}

describe('seeding the steady persona', () => {
  it('lists twelve weeks of four training sessions under the default filter', async () => {
    const store = openTestStore();
    await seedPersona(store, personaById('steady'), NOW, makeRng(1));

    const sessions = await store.listSessions({});

    expect(sessions).toHaveLength(48);
    await store.close();
  });

  it('writes every session before now, on local Mondays through Fridays', async () => {
    const store = openTestStore();
    await seedPersona(store, personaById('steady'), NOW, makeRng(1));

    const sessions = await store.listSessions({});

    const days = new Set(sessions.map((s) => new Date(s.startedAt).getDay()));
    expect([...days].sort()).toEqual([1, 2, 4, 5]);
    expect(sessions.every((s) => Date.parse(s.endedAt ?? '') < NOW.getTime())).toBe(true);
    await store.close();
  });
});

/** Each declared goal's status, read through the same projection the goals route serves. */
async function goalStatuses(personaId: string): Promise<string[]> {
  const store = openTestStore();
  await seedPersona(store, personaById(personaId), NOW, makeRng(1));
  const statuses: string[] = [];
  for (const priority of await store.listPriorities('local')) {
    for (const view of await fetchGoalProgressViews(store, priority, NOW)) {
      statuses.push(view.status);
    }
  }
  await store.close();
  return statuses;
}

describe('persona goals', () => {
  it("reads all three of steady's goals on track", async () => {
    expect(await goalStatuses('steady')).toEqual(['on_track', 'on_track', 'on_track']);
  });

  it("reads the first-timer's one goal as calibrating", async () => {
    expect(await goalStatuses('first-timer')).toEqual(['calibrating']);
  });
});

/** Every exercise card across the persona's sessions, as the summary read model builds it. */
async function summaryExercises(personaId: string) {
  const store = openTestStore();
  await seedPersona(store, personaById(personaId), NOW, makeRng(1));
  const sessions = await store.listSessions({});
  const exercises = [];
  for (const session of sessions) {
    const summary = await buildSessionSummary({ store, nameOf: () => undefined }, session.id);
    exercises.push(...(summary?.exercises ?? []));
  }
  await store.close();
  return exercises;
}

// VW-952: steady's sets used to end one rep short of failure, so every working set
// lost about 55% of its velocity and every exercise read as grinding.
describe("steady's effort", () => {
  it('stops its working sets at a typical hypertrophy velocity loss', async () => {
    const exercises = await summaryExercises('steady');

    const losses = exercises
      .flatMap((exercise) => exercise.sets)
      .filter((set) => set.setPurpose === 'working')
      .map((set) => set.velocityLossPct)
      .filter((loss): loss is number => loss !== null);

    expect(losses.length).toBeGreaterThan(0);
    expect(median(losses)).toBeGreaterThanOrEqual(10);
    expect(median(losses)).toBeLessThanOrEqual(30);
  });

  it('reads grinding or form breakdown on at most a minority of exercises', async () => {
    const exercises = await summaryExercises('steady');

    const hard = exercises.filter(
      (exercise) =>
        exercise.verdict?.state === 'grinding' || exercise.verdict?.state === 'form-breakdown',
    );

    expect(exercises.length).toBeGreaterThan(0);
    expect(hard.length).toBeLessThan(exercises.length / 2);
  });
});

describe('the fresh persona', () => {
  it('writes no sessions and no profile', async () => {
    const store = openTestStore();
    await seedPersona(store, personaById('fresh'), NOW, makeRng(1));

    expect(await store.listSessions({ kind: 'any' })).toHaveLength(0);
    expect(await store.getTrainingProfile('local')).toBeUndefined();
    await store.close();
  });
});

describe('the fatigue port', () => {
  const params: LifterParams = {
    v0: 0.6,
    vFail: 0.22,
    n0: 9,
    tauSec: 90,
    fatigueCost: 0.3,
    repsPenalty: 0.3,
    velocityPenalty: 0.15,
    cv: 0.03,
  };

  function fourSets(
    perform: typeof performSet,
    rest: typeof afterRest,
    rng: () => number,
  ): number[] {
    const velocities: number[] = [];
    let fatigue = 0;
    for (let set = 0; set < 4; set++) {
      const done = perform(params, fatigue, { targetReps: 8 }, rng);
      velocities.push(...done.velocities);
      fatigue = rest(params, done.fatigueAfter, 120);
    }
    return velocities;
  }

  it('matches the sim lifter model for seed 7', () => {
    const expected = fourSets(sim.performSet, sim.afterRest, sim.makeRng(7));

    const actual = fourSets(performSet, afterRest, makeRng(7));

    expect(actual).toHaveLength(expected.length);
    actual.forEach((velocity, index) => expect(velocity).toBeCloseTo(expected[index]!, 9));
  });
});

// first-timer rather than steady: every rng consumer (rep noise, weigh-ins, the check-in)
// writes at least once, and a file-backed steady seed costs one synced write per row.
describe('a persona seed', () => {
  it('exports byte-identical stores for the same seed', async () => {
    const first = await seedAndExport('first-timer', 42);

    const second = await seedAndExport('first-timer', 42);

    expect([...second.keys()]).toEqual([...first.keys()]);
    for (const [file, bytes] of first) expect(second.get(file), file).toBe(bytes);
  });
});
