// The seed catalog's attribution table (VW-561): which titan muscles each seed
// exercise targets, and at what weight each muscle enters the dose read.
//
// The seed's `muscleGroups` strings stay the catalog vocabulary for search and
// goal priorities; this table is what every per-muscle read model counts with.
// A target here always narrows the entry's `muscleGroups[0]` and never leaves
// it (pinned by `seed-attribution.test.ts`). Groups follow §2 of the workspace
// report `2026-09-24-muscle-attribution-compound-movements.md`.
//
// Any change here bumps `MUSCLE_MAP_VERSION` (A6, R17).

import {
  attributionFromPrimaries,
  resolveAttribution,
  type AttributionRow,
  type SlugAttribution,
} from './muscle-attribution.js';
import type { TitanMuscleGroup } from './muscle-map.js';

type Row = AttributionRow<TitanMuscleGroup>;

const target = (muscle: TitanMuscleGroup): Row => ({ muscle, weight: 1, target: true });
const half = (muscle: TitanMuscleGroup): Row => ({ muscle, weight: 0.5, target: false });
const none = (muscle: TitanMuscleGroup): Row => ({ muscle, weight: 0, target: false });

const PRESS: Row[] = [target('chest'), half('triceps'), half('front_delts')];
const FLY: Row[] = [target('chest'), half('front_delts')];
const OVERHEAD_PRESS: Row[] = [
  target('front_delts'),
  half('triceps'),
  half('side_delts'),
  none('rear_delts'),
  none('upper_back'),
];
const ROW: Row[] = [target('lats'), target('upper_back'), half('biceps'), half('rear_delts')];
const REAR_DELT: Row[] = [target('rear_delts'), half('upper_back')];
const CURL_WITH_FOREARMS: Row[] = [target('biceps'), half('forearms')];

export const SEED_ATTRIBUTION: Readonly<Record<string, readonly Row[]>> = {
  'cable-chest-press': PRESS,
  'cable-incline-chest-press': PRESS,
  'cable-chest-fly': FLY,
  'cable-low-to-high-fly': FLY,
  'cable-high-to-low-fly': FLY,
  'cable-shoulder-press': OVERHEAD_PRESS,
  'cable-lateral-raise': [target('side_delts')],
  'cable-front-raise': [target('front_delts')],
  'cable-rear-delt-fly': REAR_DELT,
  'cable-tricep-pushdown': [target('triceps')],
  'cable-overhead-tricep-extension': [target('triceps')],
  'cable-row': ROW,
  'cable-single-arm-row': ROW,
  'cable-lat-pulldown': [target('lats'), half('biceps'), half('upper_back')],
  'cable-straight-arm-pulldown': [target('lats')],
  'cable-face-pull': REAR_DELT,
  'cable-bicep-curl': [target('biceps')],
  'cable-hammer-curl': CURL_WITH_FOREARMS,
  'cable-rope-curl': [target('biceps')],
  'cable-bayesian-curl': CURL_WITH_FOREARMS,
  'cable-squat': [
    target('quads'),
    half('glutes'),
    none('hamstrings'),
    none('abs'),
    none('obliques'),
  ],
  'cable-romanian-deadlift': [
    target('hamstrings'),
    half('glutes'),
    none('lats'),
    none('upper_back'),
  ],
  'cable-glute-kickback': [target('glutes'), half('hamstrings')],
  'cable-hip-abduction': [target('glutes')],
  'cable-hip-adduction': [target('quads')],
  'cable-pull-through': [target('glutes'), half('hamstrings'), none('lats'), none('upper_back')],
  'cable-woodchopper': [target('obliques'), half('abs')],
  'cable-pallof-press': [target('abs'), target('obliques')],
  'cable-crunch': [target('abs')],
  'cable-side-bend': [target('obliques')],
};

const RESOLVED_SEED = new Map(
  Object.entries(SEED_ATTRIBUTION).map(([id, rows]) => [id, resolveAttribution(rows)]),
);

/** The catalog fields an exercise's attribution falls back on. */
export interface AttributableExercise {
  id: string;
  muscleGroups: readonly string[];
  secondaryMuscleGroups?: readonly string[];
}

/**
 * One exercise's attribution rows on titan slugs: the seed table's rows, or
 * for an id the table does not hold, its catalog primary as a 1.0 target and
 * each secondary at 0.5.
 */
export function attributionOfExercise(exercise: AttributableExercise): SlugAttribution[] {
  const seeded = RESOLVED_SEED.get(exercise.id);
  if (seeded !== undefined) return seeded;
  const primary = exercise.muscleGroups[0];
  return resolveAttribution(
    attributionFromPrimaries(
      primary === undefined ? [] : [primary],
      exercise.secondaryMuscleGroups ?? [],
    ),
  );
}
