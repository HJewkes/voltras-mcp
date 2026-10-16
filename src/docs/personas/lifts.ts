// The lifts personas train, and the one synthetic lifter shape behind them.

import type { LifterParams } from './fatigue.js';
import type { PersonaLift } from './types.js';

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

export function lift(exerciseId: string, name: string, startLoadLbs: number): PersonaLift {
  const lower = /squat|deadlift|pull-through|kickback/.test(exerciseId);
  return {
    exerciseId,
    name,
    startLoadLbs,
    lifter: lower ? nearEightRepMax(0.65, 0.28) : nearEightRepMax(0.6, 0.22),
  };
}

export const CHEST_PRESS = lift('cable-chest-press', 'Cable Chest Press', 60);
export const ROW = lift('cable-row', 'Cable Row', 70);
// A lower-body lift ramps in bigger steps, so it climbs faster to stay inside its band.
export const SQUAT: PersonaLift = { ...lift('cable-squat', 'Cable Squat', 80), weeklyGain: 0.015 };
export const SHOULDER_PRESS = lift('cable-shoulder-press', 'Cable Shoulder Press', 40);
export const LAT_PULLDOWN = lift('cable-lat-pulldown', 'Cable Lat Pulldown', 70);
export const BICEP_CURL = lift('cable-bicep-curl', 'Cable Bicep Curl', 30);
export const ROMANIAN_DEADLIFT = lift('cable-romanian-deadlift', 'Cable Romanian Deadlift', 90);
export const TRICEP_EXTENSION = lift(
  'cable-overhead-tricep-extension',
  'Cable Overhead Tricep Extension',
  30,
);
