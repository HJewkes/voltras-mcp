// The personas past the core three (share-readiness plan, section 3): each one
// guards an edge the steady lifter never reaches. All of it is invented.

import { kgInLbs } from './calendar.js';
import { seedGoalMix } from './goal-mix.js';
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
import { messyExtras } from './messy.js';
import type { Persona, PersonaLift, PersonaTraining, PersonaWorkout } from './types.js';

type TrainingShape = Partial<PersonaTraining> & Pick<PersonaTraining, 'weeks' | 'workouts'>;

/** Off-plan, three sets of eight, two minutes' rest, a 1.25% weekly climb, evenings. */
function training(shape: TrainingShape): PersonaTraining {
  return {
    blocks: [],
    setsPerLift: 3,
    targetReps: 8,
    restSec: 120,
    weeklyGain: 0.0125,
    startHour: 18,
    ...shape,
  };
}

function workout(name: string, dayOffset: number, lifts: readonly PersonaLift[]): PersonaWorkout {
  return { name, dayOffset, lifts };
}

const FULL_BODY = [CHEST_PRESS, ROW, SQUAT];

const returner: Persona = {
  id: 'returner',
  summary: 'Sixteen weeks with a three-week and a five-week break, the load lower after each.',
  onboarded: true,
  training: training({
    weeks: 16,
    workouts: [workout('Full body A', 0, FULL_BODY), workout('Full body B', 3, FULL_BODY)],
    breaks: [
      { fromWeek: 4, weeks: 3 },
      { fromWeek: 9, weeks: 5 },
    ],
    startHour: 7,
  }),
};

const HELD = { weeklyGain: 0 } as const;
const CURL_OVER_MRV: PersonaLift = { ...BICEP_CURL, sets: 10 };

const plateau: Persona = {
  id: 'plateau',
  summary:
    'Eight flat weeks on the main lifts, a stalled chest-press goal, and twenty curl sets a ' +
    'week: biceps past their recoverable volume.',
  onboarded: true,
  training: training({
    weeks: 8,
    workouts: [
      workout('Upper', 0, [{ ...CHEST_PRESS, ...HELD }, { ...ROW, ...HELD }, CURL_OVER_MRV]),
      workout('Lower', 1, [
        { ...SQUAT, ...HELD },
        { ...ROMANIAN_DEADLIFT, ...HELD },
      ]),
      workout('Arms', 3, [CURL_OVER_MRV, TRICEP_EXTENSION]),
    ],
    blocks: [{ name: 'Block 1 — Push', weeks: 9 }],
    weeklyGain: 0.0125,
  }),
  goals: [{ exerciseId: CHEST_PRESS.exerciseId, level: 'specialize' }],
};

const goalMix: Persona = {
  id: 'goal-mix',
  summary:
    'Every goal status at once: a lift behind, one on track, one ahead, and a cut with a ' +
    'bodyweight goal and a 28-day session goal.',
  onboarded: true,
  // The preview histories are pinned at a beginner's bands.
  declaredTier: 'beginner',
  seedExtras: (store, now) => seedGoalMix(store, now),
};

function kgLift(base: PersonaLift, kg: number): PersonaLift {
  return { ...base, startLoadLbs: kgInLbs(kg) };
}

const kgLifter: Persona = {
  id: 'kg-lifter',
  summary: 'Every load a whole number of kilograms, stored in pounds, read in kg.',
  onboarded: true,
  displayUnit: 'kg',
  training: training({
    weeks: 8,
    workouts: [
      workout('Push', 0, [kgLift(CHEST_PRESS, 30), kgLift(SHOULDER_PRESS, 18)]),
      workout('Pull', 2, [kgLift(ROW, 32), kgLift(LAT_PULLDOWN, 30)]),
      workout('Legs', 4, [kgLift(SQUAT, 40), kgLift(ROMANIAN_DEADLIFT, 42)]),
    ],
    blocks: [{ name: 'Block 1 — Base', weeks: 9, deloadWeek: 5 }],
    weeklyGain: 0.025,
    loadUnit: 'kg',
  }),
  body: { startLbs: kgInLbs(78), weighInsPerWeek: 3, weeklyCheckins: true },
  goals: [{ exerciseId: CHEST_PRESS.exerciseId, level: 'maintain' }],
};

const damperBand: Persona = {
  id: 'damper-band',
  summary: 'Damper, band and isokinetic sets only; damper and isokinetic sets store no weight.',
  onboarded: true,
  training: training({
    weeks: 6,
    workouts: [
      workout('Damper', 0, [
        { ...ROW, mode: { trainingMode: 'Damper', damperLevel: 5 } },
        { ...LAT_PULLDOWN, mode: { trainingMode: 'Damper', damperLevel: 7 } },
      ]),
      workout('Band', 2, [
        { ...CHEST_PRESS, mode: { trainingMode: 'Resistance Band', chainsLbs: 20 } },
        { ...BICEP_CURL, mode: { trainingMode: 'Resistance Band', chainsLbs: 10 } },
      ]),
      workout('Isokinetic', 4, [
        { ...SQUAT, mode: { trainingMode: 'Isokinetic' } },
        { ...ROMANIAN_DEADLIFT, mode: { trainingMode: 'Isokinetic' } },
      ]),
    ],
  }),
};

const messy: Persona = {
  id: 'messy',
  summary:
    'Four ordinary weeks plus every odd row: no exercise, auto-armed, partial, warm-up, probe ' +
    'and technique sets, a guest, unreviewed and test sessions, and one left open.',
  onboarded: true,
  training: training({
    weeks: 4,
    workouts: [workout('Upper', 0, [CHEST_PRESS, ROW]), workout('Lower', 3, [SQUAT])],
  }),
  seedExtras: messyExtras(CHEST_PRESS),
};

const PAIRED = { bilateral: { leftLoadShare: 0.9 } } as const;

const bilateral: Persona = {
  id: 'bilateral',
  summary: 'Two units, left and right paired on every set, the left side 10% lighter.',
  onboarded: true,
  training: training({
    weeks: 6,
    workouts: [
      workout('Upper', 1, [
        { ...CHEST_PRESS, ...PAIRED },
        { ...ROW, ...PAIRED },
      ]),
      workout('Lower', 4, [{ ...SQUAT, ...PAIRED }, { ...BICEP_CURL, ...PAIRED }, SHOULDER_PRESS]),
    ],
  }),
};

// Long enough that any zone with daylight saving has a change inside the history, and the
// Sunday 01:00 session runs past 02:00 on that night.
const nightOwl: Persona = {
  id: 'night-owl',
  summary:
    'Thirty-five weeks of sessions starting between 23:00 and 01:00 local, one of them across ' +
    'a daylight-saving change.',
  onboarded: true,
  training: training({
    weeks: 35,
    workouts: [
      { ...workout('Late upper', 1, [CHEST_PRESS, ROW, TRICEP_EXTENSION]), startHour: 23 },
      {
        ...workout('Late lower', 3, [SQUAT, ROMANIAN_DEADLIFT]),
        startHour: 23,
        startMinute: 30,
      },
      {
        ...workout('After midnight', 6, [
          SHOULDER_PRESS,
          LAT_PULLDOWN,
          BICEP_CURL,
          CHEST_PRESS,
          ROW,
        ]),
        startHour: 1,
      },
    ],
    setsPerLift: 4,
    restSec: 200,
    weeklyGain: 0.005,
  }),
};

const year: Persona = {
  id: 'year',
  summary: 'Fifty-two weeks at five days a week in thirteen four-week blocks.',
  onboarded: true,
  training: training({
    weeks: 52,
    workouts: [
      workout('Push', 0, [CHEST_PRESS, SHOULDER_PRESS, TRICEP_EXTENSION]),
      workout('Pull', 1, [ROW, LAT_PULLDOWN, BICEP_CURL]),
      workout('Legs', 2, [
        SQUAT,
        ROMANIAN_DEADLIFT,
        lift('cable-pull-through', 'Cable Pull-Through', 70),
      ]),
      workout('Upper', 3, [CHEST_PRESS, ROW]),
      workout('Lower', 4, [SQUAT, lift('cable-glute-kickback', 'Cable Glute Kickback', 20)]),
    ],
    blocks: Array.from({ length: 13 }, (_, index) => ({
      name: `Block ${index + 1}`,
      weeks: 4,
      deloadWeek: 4,
    })),
    weeklyGain: 0.01,
    startHour: 6,
  }),
  body: { startLbs: 175, weighInsPerWeek: 2, weeklyCheckins: true },
};

const truecoach: Persona = {
  id: 'truecoach',
  summary: 'Six weeks trained against a plan imported from TrueCoach, external ids on every row.',
  onboarded: true,
  training: training({
    weeks: 6,
    workouts: [
      workout('Day 1', 0, [CHEST_PRESS, ROW]),
      workout('Day 2', 2, [SQUAT, ROMANIAN_DEADLIFT]),
      workout('Day 3', 4, [SHOULDER_PRESS, LAT_PULLDOWN]),
    ],
    blocks: [{ name: 'TrueCoach import', weeks: 7 }],
    planSource: 'truecoach',
  }),
};

export const CATALOG_PERSONAS: readonly Persona[] = [
  returner,
  plateau,
  goalMix,
  kgLifter,
  damperBand,
  messy,
  bilateral,
  nightOwl,
  year,
  truecoach,
];
