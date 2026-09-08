// End-to-end tests for `truecoach.import_week` against a real SQLite store
// and the recorded fixtures.
//
// The network is unreachable from here by construction: every test injects
// `deps.fetchPages`, and the one test that does NOT inject it asserts the tool
// refuses to run at all without credentials. No test in this file constructs a
// `TrueCoachClient`.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../../config.js';
import { ExerciseService } from '../../exercises/exercise-service.js';
import { SEED_CABLE_EXERCISES } from '../../exercises/seed-catalog.js';
import type { FetchedPages } from '../../integrations/truecoach/client.js';
import type { RawWorkoutsPage } from '../../integrations/truecoach/types.js';
import { SqliteSessionStore } from '../../store/sqlite-store.js';
import type { ServerState } from '../../state/server-state.js';
import { importWeek, resolveRange } from '../truecoach-tools.js';
import * as analytics from '@voltras/workout-analytics';

const RANGE = { from: '2026-09-07', to: '2026-09-13' };

function fixture(name: string): RawWorkoutsPage {
  const path = join(
    import.meta.dirname,
    '..',
    '..',
    'integrations',
    'truecoach',
    '__tests__',
    'fixtures',
    `${name}.json`,
  );
  return JSON.parse(readFileSync(path, 'utf8')) as RawWorkoutsPage;
}

function pages(...docs: RawWorkoutsPage[]): (refresh: boolean) => Promise<FetchedPages> {
  return () => Promise.resolve({ clientId: '4242', pages: docs, cacheHit: false });
}

let dir: string;
let store: SqliteSessionStore;
let state: ServerState;

async function seedProgram(): Promise<string> {
  const id = 'prog-1';
  await store.putTrainingProgram({
    id,
    name: 'Voltra Return Block',
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  return id;
}

function makeState(config: Config): ServerState {
  return {
    config,
    store,
    exercises: new ExerciseService(),
  } as unknown as ServerState;
}

beforeEach(async () => {
  (analytics as unknown as { setCatalog: (e: unknown[]) => void }).setCatalog(SEED_CABLE_EXERCISES);
  dir = mkdtempSync(join(tmpdir(), 'vmcp-tc-tool-'));
  store = SqliteSessionStore.open(join(dir, 'tc.sqlite'));
  state = makeState(loadConfig({ HOME: dir, VOLTRA_ADAPTER: 'mock' }));
  await seedProgram();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('truecoach.import_week configuration', () => {
  it('returns NOT_CONFIGURED with the env names and makes no network call', async () => {
    await expect(importWeek(state, { ...RANGE })).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
      message: expect.stringContaining('VMCP_TRUECOACH_USERNAME') as unknown as string,
    });
  });

  it('names the password command as an alternative to the plain password', async () => {
    await expect(importWeek(state, { ...RANGE })).rejects.toThrow(/VMCP_TRUECOACH_PASSWORD_CMD/);
  });
});

describe('truecoach.import_week dry run', () => {
  it('reports the mapped tree and writes nothing', async () => {
    const result = (await importWeek(
      state,
      { ...RANGE, dryRun: true },
      { fetchPages: pages(fixture('workouts-page-basic')) },
    )) as { dryRun: boolean; weeks: string[]; workouts: { name: string }[] };

    expect(result.dryRun).toBe(true);
    expect(result.weeks).toEqual(['2026-W37']);
    expect(result.workouts.map((w) => w.name)).toEqual(['Upper A', 'Lower A']);
    expect(await store.getTrainingBlocksForProgram('prog-1')).toEqual([]);
  });
});

describe('truecoach.import_week write path', () => {
  it('creates the block, the week, the templates and the planned exercises', async () => {
    const result = (await importWeek(
      state,
      { ...RANGE },
      { fetchPages: pages(fixture('workouts-page-basic')) },
    )) as { imported: { templates: number; exercises: number } };

    expect(result.imported).toEqual({ templates: 2, exercises: 6 });

    const blocks = await store.getTrainingBlocksForProgram('prog-1');
    expect(blocks.map((b) => b.name)).toEqual(['TrueCoach import']);
    const weeks = await store.getTrainingWeeksForBlock(blocks[0]!.id);
    expect(weeks.map((w) => w.name)).toEqual(['2026-W37']);
    const templates = await store.getWorkoutTemplatesForWeek(weeks[0]!.id);
    expect(templates.map((t) => t.name)).toEqual(['Upper A', 'Lower A']);
    expect(templates[0]!.externalId).toBe('tc:workout:900001');
    expect(templates[0]!.dayLabel).toBe('2026-09-07');
  });

  it('writes the parsed targets and keeps the coach text verbatim', async () => {
    await importWeek(state, { ...RANGE }, { fetchPages: pages(fixture('workouts-page-basic')) });

    const blocks = await store.getTrainingBlocksForProgram('prog-1');
    const weeks = await store.getTrainingWeeksForBlock(blocks[0]!.id);
    const templates = await store.getWorkoutTemplatesForWeek(weeks[0]!.id);
    const planned = await store.getPlannedExercisesForTemplate(templates[0]!.id);

    expect(planned.map((p) => p.exerciseId)).toEqual([
      'cable-chest-press',
      'cable-row',
      'cable-tricep-pushdown',
    ]);
    expect(planned[0]).toMatchObject({
      targetSets: 3,
      targetRepsLow: 8,
      targetRepsHigh: 10,
      targetWeightLbs: 135,
      restSec: 90,
      notes: '3 x 8-10 @ 135lb, rest 90s',
      externalId: 'tc:item:700001',
    });
  });

  it('reports unmapped names with candidates and still lands the template', async () => {
    const result = (await importWeek(
      state,
      { ...RANGE },
      { fetchPages: pages(fixture('workouts-page-superset')) },
    )) as {
      imported: { templates: number; exercises: number };
      unmapped: { name: string; candidates: string[] }[];
    };

    expect(result.imported).toEqual({ templates: 1, exercises: 3 });
    expect(result.unmapped.map((u) => u.name)).toEqual(['Bulgarian Split Squat']);
    expect(result.unmapped[0]!.candidates.length).toBeLessThanOrEqual(3);
  });

  it('imports an unmapped name once a mapping override is supplied', async () => {
    const fetchPages = pages(fixture('workouts-page-superset'));
    await importWeek(state, { ...RANGE }, { fetchPages });

    const result = (await importWeek(
      state,
      { ...RANGE, mapping: { 'Bulgarian Split Squat': 'cable-squat' } },
      { fetchPages },
    )) as { imported: { exercises: number }; unmapped: unknown[] };

    expect(result.imported.exercises).toBe(1);
    expect(result.unmapped).toEqual([]);
  });
});

describe('truecoach.import_week idempotency', () => {
  it('a second identical import is entirely unchanged and adds no rows', async () => {
    const fetchPages = pages(fixture('workouts-page-basic'));
    const first = (await importWeek(state, { ...RANGE }, { fetchPages })) as {
      imported: { templates: number; exercises: number };
    };
    const countsAfterFirst = await rowCounts();

    const second = (await importWeek(state, { ...RANGE }, { fetchPages })) as {
      imported: { templates: number; exercises: number };
      unchanged: { templates: number; exercises: number };
    };

    expect(second.unchanged).toEqual(first.imported);
    expect(second.imported).toEqual({ templates: 0, exercises: 0 });
    expect(await rowCounts()).toEqual(countsAfterFirst);
  });

  it('an edited workout title counts as one update, not a new row', async () => {
    const original = fixture('workouts-page-basic');
    await importWeek(state, { ...RANGE }, { fetchPages: pages(original) });
    const countsAfterFirst = await rowCounts();

    const edited = JSON.parse(JSON.stringify(original)) as RawWorkoutsPage;
    (edited.workouts as { title: string }[])[0]!.title = 'Upper A (revised)';

    const result = (await importWeek(state, { ...RANGE }, { fetchPages: pages(edited) })) as {
      updated: { templates: number; exercises: number };
      imported: { templates: number };
    };

    expect(result.updated.templates).toBe(1);
    expect(result.imported.templates).toBe(0);
    expect(await rowCounts()).toEqual(countsAfterFirst);

    const blocks = await store.getTrainingBlocksForProgram('prog-1');
    const weeks = await store.getTrainingWeeksForBlock(blocks[0]!.id);
    const templates = await store.getWorkoutTemplatesForWeek(weeks[0]!.id);
    expect(templates.map((t) => t.name)).toContain('Upper A (revised)');
  });

  it('reuses the one import block and adds a week per new ISO week', async () => {
    await importWeek(state, { ...RANGE }, { fetchPages: pages(fixture('workouts-page-basic')) });
    const nextWeek: RawWorkoutsPage = {
      workouts: [{ id: 3, title: 'Upper B', due: '2026-09-15' }],
      workout_items: [{ id: 4, workout_id: 3, name: 'Cable Row', info: '3 x 10', position: 1 }],
    };

    await importWeek(
      state,
      { from: '2026-09-14', to: '2026-09-20' },
      { fetchPages: pages(nextWeek) },
    );

    const blocks = await store.getTrainingBlocksForProgram('prog-1');
    expect(blocks).toHaveLength(1);
    const weeks = await store.getTrainingWeeksForBlock(blocks[0]!.id);
    expect(weeks.map((w) => w.name)).toEqual(['2026-W37', '2026-W38']);
  });
});

describe('resolveRange', () => {
  it('defaults to the Monday-to-Sunday ISO week containing now', () => {
    expect(resolveRange({}, new Date(2026, 8, 9, 14, 30))).toEqual({
      from: '2026-09-07',
      to: '2026-09-13',
    });
  });

  it('keeps an explicit range', () => {
    expect(resolveRange({ from: '2026-01-01', to: '2026-01-31' }, new Date())).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
    });
  });

  it('rejects a reversed range', () => {
    expect(() => resolveRange({ from: '2026-02-01', to: '2026-01-01' }, new Date())).toThrow(
      /is after/,
    );
  });
});

async function rowCounts(): Promise<{ templates: number; exercises: number }> {
  const blocks = await store.getTrainingBlocksForProgram('prog-1');
  let templates = 0;
  let exercises = 0;
  for (const block of blocks) {
    for (const week of await store.getTrainingWeeksForBlock(block.id)) {
      for (const template of await store.getWorkoutTemplatesForWeek(week.id)) {
        templates += 1;
        exercises += (await store.getPlannedExercisesForTemplate(template.id)).length;
      }
    }
  }
  return { templates, exercises };
}
