// Mapping tests, driven by the two hand-written fixtures.
//
// The fixtures are hand-written from the field names the OSS clients document
// and contain no real account data — nothing in this file, or anywhere in this
// suite, makes a request to truecoach.co.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isoWeekLabel, mapPlan, UNPARSED_TARGET_SETS, type ExerciseLookup } from '../map.js';
import type { RawWorkoutsPage } from '../types.js';

function fixture(name: string): RawWorkoutsPage {
  const path = join(import.meta.dirname, 'fixtures', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as RawWorkoutsPage;
}

/**
 * Deliberately ranked and permissive, like the real catalog: it returns a
 * plausible-looking first hit for a name it does not actually have, so a
 * mapper that trusts the first result fails these tests.
 */
const CATALOG_NAMES = [
  'Cable Chest Press',
  'Cable Row',
  'Cable Tricep Pushdown',
  'Cable Squat',
  'Cable Romanian Deadlift',
  'Cable Pull-Through',
  'Cable Shoulder Press',
  'Cable Lateral Raise',
  'Cable Face Pull',
];

const catalog: ExerciseLookup = {
  search(query: string) {
    const key = query.toLowerCase();
    const ranked = CATALOG_NAMES.map((name) => ({
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name,
    })).sort((a, b) => score(b.name, key) - score(a.name, key));
    return ranked.slice(0, 5);
  },
};

function score(name: string, query: string): number {
  const words = query.split(/\s+/);
  return words.filter((word) => name.toLowerCase().includes(word)).length;
}

const RANGE = { from: '2026-09-07', to: '2026-09-13' };
const options = { ...RANGE, catalog, mapping: {} };

describe('mapPlan', () => {
  it('maps every workout in range onto exact catalog matches', () => {
    const plan = mapPlan([fixture('workouts-page-basic')], options);

    expect(plan.workouts.map((w) => w.name)).toEqual(['Upper A', 'Lower A']);
    expect(plan.unmapped).toEqual([]);
    expect(plan.workouts[0]!.externalId).toBe('tc:workout:900001');
    expect(plan.workouts[0]!.exercises.map((e) => e.exerciseId)).toEqual([
      'cable-chest-press',
      'cable-row',
      'cable-tricep-pushdown',
    ]);
    expect(plan.workouts[0]!.exercises[0]!.externalId).toBe('tc:item:700001');
  });

  it('keeps the coach text verbatim and carries the parsed targets alongside it', () => {
    const plan = mapPlan([fixture('workouts-page-basic')], options);
    const press = plan.workouts[0]!.exercises[0]!;

    expect(press.notes).toBe('3 x 8-10 @ 135lb, rest 90s');
    expect(press.targets).toMatchObject({
      targetSets: 3,
      targetRepsLow: 8,
      targetRepsHigh: 10,
      targetWeightLbs: 135,
      restSec: 90,
    });
    expect(plan.workouts[0]!.notes).toBe('Warmup: 5 min bike, band pull-aparts');
    expect(plan.workouts[1]!.notes).toBe('Cooldown: Easy walk, 10 min');
  });

  it('drops workouts whose due date falls outside the range', () => {
    const plan = mapPlan([fixture('workouts-page-basic')], {
      ...options,
      from: '2026-09-08',
      to: '2026-09-13',
    });
    expect(plan.workouts.map((w) => w.name)).toEqual(['Lower A']);
  });

  it('orders a superset by position, matching each item by its own name', () => {
    const page = fixture('workouts-page-superset');
    // The fixture lists E2 before E1 in the array: trusting index order would
    // pair the "E1." instruction with the lateral raise.
    expect(page.workout_items![0]!.name).toBe('Cable Lateral Raise');

    const plan = mapPlan([page], { ...options, from: '2026-09-07', to: '2026-09-13' });
    const exercises = plan.workouts[0]!.exercises;

    expect(exercises.map((e) => e.sourceName)).toEqual([
      'Cable Shoulder Press',
      'Cable Lateral Raise',
      'Cable Face Pull',
    ]);
    expect(exercises[0]!.notes).toBe('E1. 3 x 8 @ 95lb');
    expect(exercises[0]!.exerciseId).toBe('cable-shoulder-press');
    expect(exercises.map((e) => e.orderIndex)).toEqual([0, 1, 2]);
  });

  it('reports an unmatched name as unmapped with candidates and still lands the template', () => {
    const plan = mapPlan([fixture('workouts-page-superset')], {
      ...options,
      from: '2026-09-07',
      to: '2026-09-13',
    });

    expect(plan.workouts).toHaveLength(1);
    expect(plan.unmapped).toHaveLength(1);
    expect(plan.unmapped[0]!.name).toBe('Bulgarian Split Squat');
    expect(plan.unmapped[0]!.candidates.length).toBeLessThanOrEqual(3);
    expect(plan.workouts[0]!.exercises.map((e) => e.sourceName)).not.toContain(
      'Bulgarian Split Squat',
    );
  });

  it('honours a caller-supplied mapping override for an unmatched name', () => {
    const plan = mapPlan([fixture('workouts-page-superset')], {
      ...options,
      from: '2026-09-07',
      to: '2026-09-13',
      mapping: { 'Bulgarian Split Squat': 'cable-squat' },
    });

    expect(plan.unmapped).toEqual([]);
    const mapped = plan.workouts[0]!.exercises.find(
      (e) => e.sourceName === 'Bulgarian Split Squat',
    );
    expect(mapped?.exerciseId).toBe('cable-squat');
  });

  it('falls back to one set when the instruction carries no readable set count', () => {
    const plan = mapPlan([fixture('workouts-page-superset')], {
      ...options,
      from: '2026-09-07',
      to: '2026-09-13',
    });
    const facePull = plan.workouts[0]!.exercises[2]!;

    expect(facePull.targetSets).toBe(UNPARSED_TARGET_SETS);
    expect(facePull.notes).toBe("Work up to a heavy single, coach's discretion.");
    expect(facePull.targets.targetRepsLow).toBeUndefined();
  });

  it('never throws on unknown extra keys or missing known ones', () => {
    const page: RawWorkoutsPage = {
      workouts: [{ id: 1, due: '2026-09-08', brand_new_field: true }],
      workout_items: [{ id: 2, workout_id: 1, name: 'Cable Row', surprise: [1, 2] }],
    };
    const plan = mapPlan([page], options);

    expect(plan.workouts[0]!.name).toBe('TrueCoach workout 2026-09-08');
    expect(plan.workouts[0]!.exercises[0]!.exerciseId).toBe('cable-row');
    expect(plan.workouts[0]!.exercises[0]!.notes).toBeUndefined();
  });

  it('groups workouts into one training week per ISO week, in date order', () => {
    const nextWeek: RawWorkoutsPage = {
      workouts: [{ id: 3, title: 'Upper B', due: '2026-09-15' }],
      workout_items: [{ id: 4, workout_id: 3, name: 'Cable Row', info: '3 x 10', position: 1 }],
    };
    const plan = mapPlan([fixture('workouts-page-basic'), nextWeek], {
      ...options,
      from: '2026-09-01',
      to: '2026-09-30',
    });

    expect(plan.weeks).toEqual(['2026-W37', '2026-W38']);
    expect(plan.workouts.map((w) => w.dayLabel)).toEqual([
      '2026-09-07',
      '2026-09-09',
      '2026-09-15',
    ]);
  });
});

describe('isoWeekLabel', () => {
  it.each([
    ['2026-09-07', '2026-W37'],
    ['2026-09-13', '2026-W37'],
    ['2026-09-14', '2026-W38'],
    ['2026-01-01', '2026-W01'],
    ['2027-01-03', '2026-W53'],
  ])('%s is %s', (date, label) => {
    expect(isoWeekLabel(date)).toBe(label);
  });
});
