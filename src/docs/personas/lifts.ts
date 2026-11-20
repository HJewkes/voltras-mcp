// The lifts personas train, and the one synthetic lifter shape behind them.

import type { LifterParams } from './fatigue.js';
import type { LiftShape, PersonaHardSets, PersonaLift } from './types.js';

function liftShape(v0: number, vFail: number): LiftShape {
  return {
    v0,
    vFail,
    tauSec: 90,
    fatigueCost: 0.3,
    repsPenalty: 0.3,
    velocityPenalty: 0.15,
    cv: 0.03,
  };
}

/** A typical hypertrophy stop, with a few points of headroom for rep noise to read as 20 or so. */
export const TYPICAL_STOP_VELOCITY_LOSS_PCT = 18;

/** A last set taken near failure once a month: enough for a lift's baseline to calibrate. */
export const MONTHLY_HARD_SETS: PersonaHardSets = { everyWeeks: 4, velocityLossPct: 36 };

/**
 * The lifter at a load where a fresh set of `targetReps` ends `velocityLossPct`
 * below its opening velocity, with no noise.
 *
 * The reps to failure this solves for run high (about 25 for eight reps at 18%),
 * because the model's velocity falls in a straight line all the way to failure
 * where a real set's loss is slow early and steep at the end. Solving for the
 * loss rather than for reps in reserve keeps what the pages read believable.
 */
export function lifterAt(
  shape: LiftShape,
  targetReps: number,
  velocityLossPct: number,
): LifterParams {
  const fullLoss = 1 - shape.vFail / shape.v0;
  return { ...shape, n0: 1 + ((targetReps - 1) * fullLoss) / (velocityLossPct / 100) };
}

export function lift(exerciseId: string, name: string, startLoadLbs: number): PersonaLift {
  const lower = /squat|deadlift|pull-through|kickback/.test(exerciseId);
  return {
    exerciseId,
    name,
    startLoadLbs,
    lifter: lower ? liftShape(0.65, 0.28) : liftShape(0.6, 0.22),
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
