// The persona model: a synthetic lifter's history as pure data, which
// `seedPersona` (write.ts) turns into store rows. Every persona is invented; none
// is derived from anyone's recorded training.

import type { StoredPriorityLevel } from '../../store/types.js';
import type { SessionKind } from '../../store/session-kind.js';
import type { LifterParams } from './fatigue.js';

/** One lift inside a workout. */
export interface PersonaLift {
  readonly exerciseId: string;
  readonly name: string;
  /** Working load in the first seeded week, lb. */
  readonly startLoadLbs: number;
  readonly lifter: LifterParams;
  /** Overrides the training's weekly gain, for a lift only being held. */
  readonly weeklyGain?: number;
}

/** One weekly workout: which day of the local week it falls on, and its lifts. */
export interface PersonaWorkout {
  readonly name: string;
  /** Days after the local Monday, 0 to 6. */
  readonly dayOffset: number;
  readonly lifts: readonly PersonaLift[];
}

/** A training block. Weeks past the seeded history are planned but not yet trained. */
export interface PersonaBlock {
  readonly name: string;
  readonly weeks: number;
  /** The block's deload week, 1-based, if it has one. */
  readonly deloadWeek?: number;
}

export interface PersonaTraining {
  /** Whole local weeks of history, ending the Sunday before `now`'s week. */
  readonly weeks: number;
  readonly workouts: readonly PersonaWorkout[];
  /** Empty means the sessions were trained off-plan. */
  readonly blocks: readonly PersonaBlock[];
  readonly setsPerLift: number;
  readonly targetReps: number;
  readonly restSec: number;
  /** Load added each non-deload week, as a share of the starting load. */
  readonly weeklyGain: number;
  /** Local hour the sessions start at. */
  readonly startHour: number;
}

/** A declared lift goal, accepted when its start reading was taken. */
export interface PersonaGoal {
  readonly exerciseId: string;
  readonly level: StoredPriorityLevel;
  /** Accepted before calibration, so the band is the execution ramp at `cold`. */
  readonly acceptedCold?: boolean;
}

export interface PersonaBody {
  readonly startLbs: number;
  /** Weigh-ins per local week, Monday first, at 07:00. */
  readonly weighInsPerWeek: number;
  readonly weeklyCheckins: boolean;
}

export interface Persona {
  readonly id: string;
  readonly summary: string;
  /** Whether the session-0 intake has been answered. */
  readonly onboarded: boolean;
  /** The review kind stamped on every session; `null` leaves them unreviewed. */
  readonly kind?: SessionKind | null;
  readonly training?: PersonaTraining;
  readonly body?: PersonaBody;
  readonly goals?: readonly PersonaGoal[];
}
