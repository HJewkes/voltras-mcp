// The persona catalog (VW-940): each persona holds the edge it is named for, and
// every one seeds a store that a fresh open migrates without complaint.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { fetchGoalProgressViews } from '../../dashboard/goal-progress-api.js';
import { POPULATION_VOLUME_LANDMARKS } from '../../dashboard/read-models/muscle-week.js';
import { openTestStore } from '../../store/__tests__/open-test-store.js';
import { makeRng, PERSONAS, personaById, seedPersona } from '../personas/index.js';
import { localDay, localMonday } from '../personas/calendar.js';
import { PERSONA_NOW, seedInMemory, type SeededPersona } from './persona-fixture.js';

const KG_PER_LB = 0.45359237;
const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(PERSONA_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

type Invariant = readonly [name: string, check: (seeded: SeededPersona) => Promise<void> | void];

/** Whole weeks between the local Monday of `now` and the local Monday of `at`. */
function weeksBack(at: string): number {
  const monday = localMonday(new Date(at), 0).getTime();
  return Math.round((localMonday(PERSONA_NOW, 0).getTime() - monday) / WEEK_MS);
}

function loadsOf(seeded: SeededPersona, exerciseId: string): number[] {
  return seeded.sets.filter((s) => s.exerciseId === exerciseId).map((s) => s.weightLbs ?? NaN);
}

async function liftGoalStatuses(seeded: SeededPersona): Promise<string[]> {
  const statuses: string[] = [];
  for (const priority of await seeded.store.listPriorities('local')) {
    if (priority.kind !== 'lift') continue;
    for (const view of await fetchGoalProgressViews(seeded.store, priority, PERSONA_NOW)) {
      statuses.push(view.status);
    }
  }
  return statuses.sort();
}

function isWholeKg(lbs: number | undefined): boolean {
  if (lbs === undefined) return false;
  const kg = lbs * KG_PER_LB;
  return Math.abs(kg - Math.round(kg)) < 0.01;
}

/** The trained history weeks, newest first, as weeks before `now`'s. */
function trainedWeeks(seeded: SeededPersona): number[] {
  return [...new Set(seeded.sessions.map((s) => weeksBack(s.startedAt)))].sort((a, b) => a - b);
}

/** Each run of untrained weeks: how long, the last week before it and the first week back. */
function breaks(seeded: SeededPersona): { weeks: number; before: number; back: number }[] {
  const weeks = trainedWeeks(seeded);
  return weeks
    .slice(1)
    .map((before, i) => ({ weeks: before - weeks[i]! - 1, before, back: weeks[i]! }))
    .filter((gap) => gap.weeks > 0);
}

/** The top chest-press load in each history week, keyed by weeks before `now`'s. */
function weeklyChestPress(seeded: SeededPersona): Map<number, number> {
  const byWeek = new Map<number, number>();
  for (const set of seeded.sets) {
    if (set.exerciseId !== 'cable-chest-press') continue;
    const week = weeksBack(set.startedAt);
    byWeek.set(week, Math.max(byWeek.get(week) ?? 0, set.weightLbs ?? 0));
  }
  return byWeek;
}

const INVARIANTS: Readonly<Record<string, readonly Invariant[]>> = {
  fresh: [['writes no sessions', ({ sessions }) => expect(sessions).toHaveLength(0)]],
  'first-timer': [
    [
      'writes one session of three sets',
      ({ sessions, sets }) => {
        expect(sessions).toHaveLength(1);
        expect(sets).toHaveLength(3);
      },
    ],
  ],
  steady: [['writes 48 sessions', ({ sessions }) => expect(sessions).toHaveLength(48)]],
  returner: [
    [
      'leaves a three-week and a five-week gap',
      (seeded) => {
        expect(breaks(seeded).map((gap) => gap.weeks)).toEqual([5, 3]);
      },
    ],
    [
      'comes back lighter after each gap',
      (seeded) => {
        const loads = weeklyChestPress(seeded);
        for (const { before, back } of breaks(seeded)) {
          expect(loads.get(back)!).toBeLessThan(loads.get(before)!);
        }
      },
    ],
  ],
  plateau: [
    [
      'holds the chest press at one load for eight weeks',
      (seeded) => {
        expect(new Set(loadsOf(seeded, 'cable-chest-press'))).toEqual(new Set([60]));
        expect(trainedWeeks(seeded)).toHaveLength(8);
      },
    ],
    [
      'trains biceps past their recoverable volume every week',
      ({ sets }) => {
        const curlsByWeek = new Map<number, number>();
        for (const set of sets.filter((s) => s.exerciseId === 'cable-bicep-curl')) {
          const week = weeksBack(set.startedAt);
          curlsByWeek.set(week, (curlsByWeek.get(week) ?? 0) + 1);
        }
        const mrv = POPULATION_VOLUME_LANDMARKS.biceps.mrv;
        expect([...curlsByWeek.values()].every((count) => count > mrv)).toBe(true);
      },
    ],
    [
      'reads its chest-press goal stalled',
      async (seeded) => {
        expect(await liftGoalStatuses(seeded)).toEqual(['stalled']);
      },
    ],
  ],
  'goal-mix': [
    [
      'reads one lift behind, one on track and one ahead',
      async (seeded) => {
        expect(await liftGoalStatuses(seeded)).toEqual(['ahead', 'behind', 'on_track']);
      },
    ],
    [
      'adds a bodyweight goal and a 28-day session goal',
      async ({ store }) => {
        const refs = (await store.listPriorities('local')).filter((p) => p.kind !== 'lift');
        expect(refs.map((p) => p.ref).sort()).toEqual(['bodyweight', 'sessions']);
      },
    ],
  ],
  'kg-lifter': [
    [
      'stores every set load as whole kilograms',
      ({ sets }) => {
        expect(sets.length).toBeGreaterThan(0);
        expect(sets.filter((s) => !isWholeKg(s.weightLbs))).toEqual([]);
      },
    ],
    [
      'plans every load as whole kilograms',
      async ({ store, sessions }) => {
        const assignment = await store.getAssignmentsForSession(sessions[0]!.id);
        const planned = await store.getPlannedExercisesForTemplate(
          assignment[0]!.workoutTemplateId!,
        );
        expect(planned.every((row) => isWholeKg(row.targetWeightLbs))).toBe(true);
      },
    ],
    ['reads in kg', () => expect(personaById('kg-lifter').displayUnit).toBe('kg')],
  ],
  'damper-band': [
    [
      'stores no weight on damper and isokinetic sets',
      ({ sets }) => {
        const unloaded = sets.filter(
          (s) => s.trainingMode === 'Damper' || s.trainingMode === 'Isokinetic',
        );
        expect(unloaded.length).toBeGreaterThan(0);
        expect(unloaded.every((s) => s.weightLbs === undefined)).toBe(true);
      },
    ],
    [
      'trains no plain weight sets, and every band set has a load',
      ({ sets }) => {
        const modes = new Set(sets.map((s) => s.trainingMode));
        expect([...modes].sort()).toEqual(['Damper', 'Isokinetic', 'Resistance Band']);
        const band = sets.filter((s) => s.trainingMode === 'Resistance Band');
        expect(band.every((s) => s.weightLbs !== undefined && s.chainsLbs !== undefined)).toBe(
          true,
        );
      },
    ],
  ],
  messy: [
    [
      'leaves exactly one session open, its last rep seven hours old',
      ({ store, sessions }) => checkOpenSession(store, sessions),
    ],
    [
      'writes sets with no exercise, auto-armed and partial',
      ({ sets }) => {
        expect(sets.some((s) => s.exerciseId === undefined)).toBe(true);
        expect(sets.some((s) => s.autoCreatedBy === 'idle_rep')).toBe(true);
        expect(sets.some((s) => s.partial)).toBe(true);
      },
    ],
    [
      'writes warm-up, probe and technique sets',
      ({ sets }) => {
        // A working set reads back with no purpose: absent means working.
        const purposes = new Set(sets.map((s) => s.setPurpose ?? 'working'));
        expect([...purposes].sort()).toEqual(['probe', 'technique', 'warmup', 'working']);
      },
    ],
    [
      'keeps unreviewed, test and guest sessions out of the default list',
      async (seeded) => {
        const kinds = seeded.sessions.map((s) => s.kind ?? 'unreviewed');
        expect(kinds).toContain('unreviewed');
        expect(kinds).toContain('test');
        const guest = await seeded.store.listSessions({ lifter: 'Guest', kind: 'any' });
        expect(guest).toHaveLength(1);
        const training = await seeded.store.listSessions({});
        expect(training.length).toBe(seeded.sessions.filter((s) => s.kind === 'training').length);
      },
    ],
  ],
  bilateral: [
    [
      'pairs every paired set left and right, the left 10% lighter',
      ({ sets }) => {
        const groups = Map.groupBy(
          sets.filter((s) => s.bilateralGroupId !== undefined),
          (s) => s.bilateralGroupId!,
        );
        expect(groups.size).toBeGreaterThan(0);
        for (const pair of groups.values()) {
          const left = pair.find((s) => s.side === 'left')!;
          const right = pair.find((s) => s.side === 'right')!;
          expect(pair).toHaveLength(2);
          expect(left.weightLbs! / right.weightLbs!).toBeCloseTo(0.9, 1);
        }
      },
    ],
  ],
  'night-owl': [
    [
      'starts every session between 23:00 and 01:00 local',
      ({ sessions }) => {
        const hours = new Set(sessions.map((s) => new Date(s.startedAt).getHours()));
        expect([...hours].sort()).toEqual([1, 23]);
      },
    ],
  ],
  year: [
    [
      'trains five days a week for 52 weeks',
      (seeded) => {
        expect(seeded.sessions).toHaveLength(260);
        expect(trainedWeeks(seeded)).toHaveLength(52);
      },
    ],
    [
      'plans thirteen blocks',
      async ({ store }) => {
        const [program] = await store.listTrainingPrograms();
        expect(await store.getTrainingBlocksForProgram(program!.id)).toHaveLength(13);
      },
    ],
  ],
  truecoach: [
    [
      'keys every planned row by a TrueCoach external id',
      ({ store, sessions }) => checkImportedPlan(store, sessions),
    ],
    [
      'dates its block as an import',
      async ({ store }) => {
        const schedules = await store.listLiveBlockSchedules();
        expect(schedules.map((s) => s.changedBy)).toEqual(['import']);
      },
    ],
  ],
};

async function checkOpenSession(
  store: SeededPersona['store'],
  sessions: SeededPersona['sessions'],
): Promise<void> {
  const open = sessions.filter((s) => s.endedAt === undefined);
  expect(open).toHaveLength(1);
  const lastRepAt = Math.max(
    ...(await store.getSetsForSession(open[0]!.id)).map((s) => Date.parse(s.endedAt)),
  );
  const ageHours = (PERSONA_NOW.getTime() - lastRepAt) / HOUR_MS;
  expect(ageHours).toBeGreaterThanOrEqual(7);
  expect(ageHours).toBeLessThan(7.5);
}

async function checkImportedPlan(
  store: SeededPersona['store'],
  sessions: SeededPersona['sessions'],
): Promise<void> {
  for (const session of sessions) {
    const [assignment] = await store.getAssignmentsForSession(session.id);
    const template = await store.getWorkoutTemplate(assignment!.workoutTemplateId!);
    expect(template?.externalId).toMatch(/^tc:workout:/);
    expect(template?.dayLabel).toBe(localDay(new Date(session.startedAt)));
    for (const row of await store.getPlannedExercisesForTemplate(template!.id)) {
      expect(row.externalId).toMatch(/^tc:item:/);
      expect(row.notes).toBeDefined();
    }
  }
}

describe('the invariant table', () => {
  it('names every persona', () => {
    expect(Object.keys(INVARIANTS).sort()).toEqual(PERSONAS.map((p) => p.id).sort());
  });
});

describe.each(PERSONAS.map((p) => p.id))('the %s persona', (personaId) => {
  let seeded: SeededPersona;

  beforeAll(async () => {
    seeded = await seedInMemory(personaId);
  });

  afterAll(async () => {
    await seeded.store.close();
  });

  it('lists every session it reports writing', () => {
    const guestSessions = personaId === 'messy' ? 1 : 0;
    expect(seeded.sessions.length + guestSessions).toBe(seeded.report.sessions);
  });

  it.each(INVARIANTS[personaId] ?? [])('%s', async (_name, check) => {
    await check(seeded);
  });
});

// tmpfs where there is one: a store file costs a synced write per row, and on a disk that
// is most of a minute for the larger personas.
function scratchRoot(): string {
  return existsSync('/dev/shm') ? '/dev/shm' : tmpdir();
}

describe('a persona store file', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it.each(PERSONAS.map((p) => p.id))('reopens %s without a migration error', async (personaId) => {
    const dir = mkdtempSync(join(scratchRoot(), 'personas-catalog-'));
    dirs.push(dir);
    const path = join(dir, 'store.sqlite');
    const seeding = openTestStore({ path });
    const report = await seedPersona(seeding, personaById(personaId), PERSONA_NOW, makeRng(1));
    await seeding.close();

    const reopened = openTestStore({ path });
    const sessions = await reopened.listSessions({ kind: 'any' });
    await reopened.close();

    expect(sessions.length).toBeLessThanOrEqual(report.sessions);
    expect(sessions.length === 0).toBe(report.sessions === 0);
  });
});
