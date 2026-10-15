// Synthetic lifters for exercising every page against a believable store
// (share-readiness plan, deliverable B). Each persona is pure data; seed one
// with `seedPersona(store, persona, now, makeRng(seed))`. All of it is invented.

import type { LifterParams } from './fatigue.js';
import type { Persona, PersonaLift } from './types.js';

export { makeRng, type Rng } from './rng.js';
export { seedPersona, type PersonaSeedReport, type PersonaStore } from './write.js';
export type * from './types.js';

/** A lifter working near an eight-rep max: rep 8 lands close to the failure velocity. */
function nearEightRepMax(v0: number, vFail: number): LifterParams {
  return {
    v0,
    vFail,
    n0: 9,
    tauSec: 90,
    fatigueCost: 0.3,
    repsPenalty: 0.3,
    velocityPenalty: 0.15,
    cv: 0.03,
  };
}

function lift(exerciseId: string, name: string, startLoadLbs: number): PersonaLift {
  const lower = /squat|deadlift|pull-through|kickback/.test(exerciseId);
  return {
    exerciseId,
    name,
    startLoadLbs,
    lifter: lower ? nearEightRepMax(0.65, 0.28) : nearEightRepMax(0.6, 0.22),
  };
}

const CHEST_PRESS = lift('cable-chest-press', 'Cable Chest Press', 60);
const ROW = lift('cable-row', 'Cable Row', 70);
// A lower-body lift ramps in bigger steps, so it climbs faster to stay inside its band.
const SQUAT: PersonaLift = { ...lift('cable-squat', 'Cable Squat', 80), weeklyGain: 0.015 };

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
        lifts: [
          CHEST_PRESS,
          ROW,
          lift('cable-overhead-tricep-extension', 'Cable Overhead Tricep Extension', 30),
        ],
      },
      {
        name: 'Lower A',
        dayOffset: 1,
        lifts: [
          SQUAT,
          lift('cable-romanian-deadlift', 'Cable Romanian Deadlift', 90),
          lift('cable-hip-abduction', 'Cable Hip Abduction', 25),
        ],
      },
      {
        name: 'Upper B',
        dayOffset: 3,
        lifts: [
          lift('cable-shoulder-press', 'Cable Shoulder Press', 40),
          lift('cable-lat-pulldown', 'Cable Lat Pulldown', 70),
          lift('cable-bicep-curl', 'Cable Bicep Curl', 30),
        ],
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

export const PERSONAS: readonly Persona[] = [fresh, firstTimer, steady];

export function personaById(id: string): Persona {
  const found = PERSONAS.find((persona) => persona.id === id);
  if (found === undefined) {
    throw new Error(`unknown persona ${id}; known: ${PERSONAS.map((p) => p.id).join(', ')}`);
  }
  return found;
}
