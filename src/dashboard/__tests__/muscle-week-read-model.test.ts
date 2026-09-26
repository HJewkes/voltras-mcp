// Unit tests for the muscle-week read-model (VW-329, B2 of the body-map plan).
//
// Pure shaping only — no store, no HTTP. Covers: per-muscle set counts and the
// statuses they classify to against the population landmarks, the target-only
// rule (a secondary muscle group never counts), the mock/non-owner/non-working
// exclusions, every titan slug being present with zeros, `lastTrainedAt`, and
// the `landmarkBasis` literal.

import { describe, expect, it } from 'vitest';

import {
  buildMuscleWeekView,
  classifyWeeklyVolume,
  POPULATION_VOLUME_LANDMARKS,
  type MuscleWeekRows,
} from '../read-models/muscle-week.js';
import { MUSCLE_MAP_VERSION, TITAN_MUSCLE_GROUPS } from '../../exercises/muscle-map.js';
import { SEED_CABLE_EXERCISES } from '../../exercises/seed-catalog.js';
import type { StoredRep, StoredSet } from '../../store/types.js';

const MONDAY = '2026-07-06T00:00:00.000Z';
const NOW = new Date('2026-07-08T12:00:00.000Z'); // Wednesday of the same week

/**
 * `chest-press` names `triceps` as a SECONDARY group. Every assertion about
 * triceps below is the target-only guard (B47): the retired `muscle-volume.ts`
 * would have credited it half a set per chest-press set.
 */
const CATALOG = [
  {
    id: 'chest-press',
    name: 'Chest Press',
    muscleGroups: ['chest'],
    secondaryMuscleGroups: ['triceps'],
  },
  { id: 'cable-row', name: 'Cable Row', muscleGroups: ['back'] },
  { id: 'lateral-raise', name: 'Lateral Raise', muscleGroups: ['shoulders'] },
];

const catalog: MuscleWeekRows['catalog'] = (id) => CATALOG.find((e) => e.id === id);

let nextSetId = 0;

/** A working, owner-owned, device-counted set — the eligible baseline every case starts from. */
function set(exerciseId: string, startedAt: string, overrides: Partial<StoredSet> = {}): StoredSet {
  nextSetId += 1;
  return {
    id: `set-${nextSetId}`,
    sessionId: 'sess-1',
    startedAt,
    endedAt: startedAt,
    partial: false,
    reps: [],
    exerciseId,
    firmwareRepCount: 8,
    ...overrides,
  };
}

function build(sets: StoredSet[], now = NOW) {
  return buildMuscleWeekView({ sets, catalog, now });
}

function muscle(view: ReturnType<typeof build>, slug: string) {
  return view.muscles.find((m) => m.muscle === slug);
}

describe('buildMuscleWeekView', () => {
  it('counts working sets per primary muscle and classifies them against the landmarks', () => {
    // 9 chest-press sets: chest landmarks are mev 8 / mav 14 / mrv 20, so 9 is
    // at-or-above MEV but below MAV.
    const sets = Array.from({ length: 9 }, (_, i) =>
      set('chest-press', `2026-07-07T0${i}:00:00.000Z`),
    );
    const view = build(sets);

    expect(muscle(view, 'chest')).toMatchObject({
      sets: 9,
      status: 'maintenance',
      landmarks: { mev: 8, mav: 14, mrv: 20 },
    });
  });

  it('reports the week boundary, map version and population landmark basis', () => {
    const view = build([set('cable-row', '2026-07-07T10:00:00.000Z')]);

    expect(view.weekStart).toBe(MONDAY);
    expect(view.muscleMapVersion).toBe(MUSCLE_MAP_VERSION);
    expect(view.landmarkBasis).toBe('population-default');
  });

  it('never counts a secondary muscle group (target-only, B47)', () => {
    // 12 chest-press sets would put triceps (mev 4) well past MEV if the
    // exercise's SECONDARY group counted at any weight. It does not.
    const sets = Array.from({ length: 12 }, (_, i) =>
      set('chest-press', `2026-07-07T${String(i).padStart(2, '0')}:00:00.000Z`),
    );
    const view = build(sets);

    expect(muscle(view, 'chest')?.sets).toBe(12);
    expect(muscle(view, 'triceps')).toMatchObject({ sets: 0, lastTrainedAt: null });
  });

  it('credits every titan slug a coarse catalog group maps to, in full', () => {
    const view = build([set('lateral-raise', '2026-07-07T10:00:00.000Z')]);

    for (const slug of ['front_delts', 'side_delts', 'rear_delts']) {
      expect(muscle(view, slug)?.sets).toBe(1);
    }
  });

  it('excludes mock-adapter, guest and non-working sets', () => {
    const view = build([
      set('cable-row', '2026-07-07T10:00:00.000Z', { source: 'mock' }),
      set('cable-row', '2026-07-07T11:00:00.000Z', { lifter: 'guest' }),
      set('cable-row', '2026-07-07T12:00:00.000Z', { setPurpose: 'warmup', isWarmup: true }),
      set('cable-row', '2026-07-07T13:00:00.000Z', { firmwareRepCount: 0, reps: [] }),
    ]);

    expect(muscle(view, 'lats')).toMatchObject({ sets: 0, lastTrainedAt: null });
    expect(muscle(view, 'upper_back')?.sets).toBe(0);
  });

  it('falls back to the derived rep array when the device counted nothing', () => {
    // Only `reps.length` is read for eligibility, so a bare placeholder rep is enough.
    const derivedOnly: StoredSet = {
      id: 'set-derived',
      sessionId: 'sess-1',
      startedAt: '2026-07-07T10:00:00.000Z',
      endedAt: '2026-07-07T10:01:00.000Z',
      partial: false,
      exerciseId: 'cable-row',
      reps: [{} as StoredRep],
    };

    expect(muscle(build([derivedOnly]), 'lats')?.sets).toBe(1);
  });

  it('returns all 15 titan slugs, with zeros for untrained muscles', () => {
    const view = build([]);

    expect(view.muscles.map((m) => m.muscle)).toEqual([...TITAN_MUSCLE_GROUPS]);
    expect(view.muscles.every((m) => m.sets === 0)).toBe(true);
    expect(view.muscles.every((m) => m.lastTrainedAt === null)).toBe(true);
  });

  it('scopes the count to the calendar week but lets lastTrainedAt reach back past it', () => {
    const view = build([
      set('cable-row', '2026-06-30T10:00:00.000Z'), // previous week
      set('chest-press', '2026-07-09T10:00:00.000Z'), // this week, Thursday
      set('chest-press', '2026-07-14T10:00:00.000Z'), // next week — after the boundary
    ]);

    expect(muscle(view, 'lats')).toMatchObject({
      sets: 0,
      lastTrainedAt: '2026-06-30T10:00:00.000Z',
    });
    expect(muscle(view, 'chest')).toMatchObject({
      sets: 1,
      lastTrainedAt: '2026-07-09T10:00:00.000Z',
    });
  });

  it('picks the week from any instant inside it', () => {
    const sunday = new Date('2026-07-12T23:59:59.000Z');
    expect(build([], sunday).weekStart).toBe(MONDAY);
    expect(build([], new Date(MONDAY)).weekStart).toBe(MONDAY);
  });

  it('ignores a set that resolves to no exercise or to an unmapped group', () => {
    const noExercise: StoredSet = {
      id: 'set-orphan',
      sessionId: 'sess-1',
      startedAt: '2026-07-07T10:00:00.000Z',
      endedAt: '2026-07-07T10:01:00.000Z',
      partial: false,
      reps: [],
      firmwareRepCount: 8,
    };
    const view = build([noExercise, set('unknown-exercise', '2026-07-07T11:00:00.000Z')]);

    expect(view.muscles.every((m) => m.sets === 0)).toBe(true);
  });
});

describe('buildMuscleWeekView: landmark and dose reads (VW-561)', () => {
  const seedCatalog: MuscleWeekRows['catalog'] = (id) =>
    SEED_CABLE_EXERCISES.find((exercise) => exercise.id === id);
  const seeded = (sets: StoredSet[]) =>
    buildMuscleWeekView({ sets, catalog: seedCatalog, now: NOW });
  const MON = '2026-07-06T10:00:00.000Z';
  const THU = '2026-07-09T10:00:00.000Z';

  it('counts a shoulder press toward front delts only in the landmark read (Q4)', () => {
    const view = seeded([set('cable-shoulder-press', MON), set('cable-shoulder-press', MON)]);

    expect(muscle(view, 'front_delts')).toMatchObject({ sets: 2, dose: { sets: 2 } });
    expect(muscle(view, 'side_delts')).toMatchObject({ sets: 0, dose: { sets: 1 } });
    expect(muscle(view, 'rear_delts')).toMatchObject({ sets: 0, dose: { sets: 0 } });
  });

  it('classifies the landmark sets whatever the dose adds (R5)', () => {
    const sets = Array.from({ length: 4 }, () => set('cable-chest-press', MON));
    const view = seeded(sets);

    expect(muscle(view, 'triceps')).toMatchObject({ sets: 0, status: 'under', dose: { sets: 2 } });
  });

  it('draws no verdict for glutes at any set count (R8c)', () => {
    const none = seeded([]);
    const many = seeded(Array.from({ length: 20 }, () => set('cable-glute-kickback', MON)));

    expect(muscle(none, 'glutes')?.status).toBeNull();
    expect(muscle(many, 'glutes')).toMatchObject({ sets: 20, status: null });
  });

  it('counts a day toward frequency only for the muscles its exercises target (Q5)', () => {
    const view = seeded([
      set('cable-romanian-deadlift', MON),
      set('cable-romanian-deadlift', MON),
      set('cable-squat', THU),
    ]);

    expect(muscle(view, 'hamstrings')).toMatchObject({ sessions: 1, dose: { sessions: 1 } });
    expect(muscle(view, 'glutes')).toMatchObject({ sessions: 0, dose: { sessions: 1 } });
    expect(muscle(view, 'quads')).toMatchObject({ sessions: 1, dose: { sessions: 1 } });
  });

  it('keeps a set outside the week out of both reads and both frequencies', () => {
    const view = seeded([set('cable-romanian-deadlift', '2026-06-30T10:00:00.000Z')]);

    expect(muscle(view, 'hamstrings')).toMatchObject({
      sets: 0,
      sessions: 0,
      dose: { sets: 0, sessions: 0 },
      lastTrainedAt: '2026-06-30T10:00:00.000Z',
    });
  });
});

describe('classifyWeeklyVolume', () => {
  const chest = POPULATION_VOLUME_LANDMARKS.chest; // mev 8, mav 14, mrv 20

  it('walks the four statuses across the landmark thresholds', () => {
    expect(classifyWeeklyVolume(7, chest)).toBe('under');
    expect(classifyWeeklyVolume(8, chest)).toBe('maintenance');
    expect(classifyWeeklyVolume(13, chest)).toBe('maintenance');
    expect(classifyWeeklyVolume(14, chest)).toBe('productive');
    expect(classifyWeeklyVolume(19, chest)).toBe('productive');
    expect(classifyWeeklyVolume(20, chest)).toBe('over');
    expect(classifyWeeklyVolume(40, chest)).toBe('over');
  });

  it('keeps the whole MAV-to-MRV band productive, as VolumeStatus has no "approaching"', () => {
    // Titan's `zoneForSets` splits this band at the midpoint for the heatmap
    // fill; `approaching` is derived at render time from `intensity`, not here.
    expect(classifyWeeklyVolume(17, chest)).toBe('productive');
  });

  it('calls a zero-MEV muscle maintenance at zero sets, as titan does', () => {
    expect(POPULATION_VOLUME_LANDMARKS.abs.mev).toBe(0);
    expect(classifyWeeklyVolume(0, POPULATION_VOLUME_LANDMARKS.abs)).toBe('maintenance');
  });
});
