// Synthetic lifters for exercising every page against a believable store
// (share-readiness plan, deliverable B). Each persona is pure data; seed one
// with `seedPersona(store, persona, now, makeRng(seed))`. All of it is invented.

import { CATALOG_PERSONAS } from './catalog.js';
import {
  BICEP_CURL,
  CHEST_PRESS,
  LAT_PULLDOWN,
  lift,
  ROMANIAN_DEADLIFT,
  ROW,
  SHOULDER_PRESS,
  SQUAT,
  TRICEP_EXTENSION,
} from './lifts.js';
import type { Persona } from './types.js';

export { makeRng, type Rng } from './rng.js';
export { seedPersona, type PersonaSeedReport, type PersonaStore } from './write.js';
export type * from './types.js';

const fresh: Persona = {
  id: 'fresh',
  summary: 'A new install: onboarding not done and no rows at all.',
  onboarded: false,
};

const firstTimer: Persona = {
  id: 'first-timer',
  summary:
    'Onboarded, one session of three sets, one weigh-in, one check-in and a goal still calibrating.',
  onboarded: true,
  training: {
    weeks: 1,
    workouts: [{ name: 'First session', dayOffset: 0, lifts: [CHEST_PRESS] }],
    blocks: [],
    setsPerLift: 3,
    targetReps: 8,
    restSec: 120,
    weeklyGain: 0,
    startHour: 18,
  },
  body: { startLbs: 165, weighInsPerWeek: 1, weeklyCheckins: true },
  goals: [{ exerciseId: CHEST_PRESS.exerciseId, level: 'specialize', acceptedCold: true }],
};

const steady: Persona = {
  id: 'steady',
  summary:
    'Twelve weeks of an upper/lower split four days a week across two blocks with a deload, ' +
    'weekly check-ins, five weigh-ins a week and three lift goals on track.',
  onboarded: true,
  training: {
    weeks: 12,
    workouts: [
      {
        name: 'Upper A',
        dayOffset: 0,
        lifts: [CHEST_PRESS, ROW, TRICEP_EXTENSION],
      },
      {
        name: 'Lower A',
        dayOffset: 1,
        lifts: [SQUAT, ROMANIAN_DEADLIFT, lift('cable-hip-abduction', 'Cable Hip Abduction', 25)],
      },
      {
        name: 'Upper B',
        dayOffset: 3,
        lifts: [SHOULDER_PRESS, LAT_PULLDOWN, BICEP_CURL],
      },
      {
        name: 'Lower B',
        dayOffset: 4,
        lifts: [
          lift('cable-pull-through', 'Cable Pull-Through', 70),
          lift('cable-glute-kickback', 'Cable Glute Kickback', 20),
          lift('cable-crunch', 'Cable Crunch', 40),
        ],
      },
    ],
    // The second block's deload is the current week, still to come.
    blocks: [
      { name: 'Block 1 — Base', weeks: 6, deloadWeek: 6 },
      { name: 'Block 2 — Build', weeks: 7, deloadWeek: 7 },
    ],
    setsPerLift: 3,
    targetReps: 8,
    restSec: 120,
    weeklyGain: 0.0125,
    startHour: 18,
  },
  body: { startLbs: 180, weighInsPerWeek: 5, weeklyCheckins: true },
  goals: [
    { exerciseId: CHEST_PRESS.exerciseId, level: 'specialize' },
    { exerciseId: ROW.exerciseId, level: 'maintain' },
    { exerciseId: SQUAT.exerciseId, level: 'maintain' },
  ],
};

export const PERSONAS: readonly Persona[] = [fresh, firstTimer, steady, ...CATALOG_PERSONAS];

export function personaById(id: string): Persona {
  const found = PERSONAS.find((persona) => persona.id === id);
  if (found === undefined) {
    throw new Error(`unknown persona ${id}; known: ${PERSONAS.map((p) => p.id).join(', ')}`);
  }
  return found;
}
