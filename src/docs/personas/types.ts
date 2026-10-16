// The persona model: a synthetic lifter's history as pure data, which
// `seedPersona` (write.ts) turns into store rows. Every persona is invented; none
// is derived from anyone's recorded training.

import type { StoredPriorityLevel } from '../../store/types.js';
import type { SessionKind } from '../../store/session-kind.js';
import type { LifterParams } from './fatigue.js';
import type { Rng } from './rng.js';
import type { PersonaStore } from './write.js';

/** A mode with no load of its own stores no weight: the set row's weight is NULL. */
export interface PersonaMode {
  readonly trainingMode: 'Weight Training' | 'Resistance Band' | 'Damper' | 'Isokinetic';
  readonly damperLevel?: number;
  readonly chainsLbs?: number;
}

/** A lift's fatigue shape. Reps to failure follow from the training's effort (`lifterAt`). */
export type LiftShape = Omit<LifterParams, 'n0'>;

/** One lift inside a workout. */
export interface PersonaLift {
  readonly exerciseId: string;
  readonly name: string;
  /** Working load in the first seeded week, lb. */
  readonly startLoadLbs: number;
  readonly lifter: LiftShape;
  /** Overrides the training's weekly gain, for a lift only being held. */
  readonly weeklyGain?: number;
  /** Overrides the training's sets per lift. */
  readonly sets?: number;
  /** Absent is plain weight training. */
  readonly mode?: PersonaMode;
  /** Trained on two units at once: each set writes a left and a right row. */
  readonly bilateral?: {
    /** The left side's load as a share of the right side's. */
    readonly leftLoadShare: number;
  };
}

/** One weekly workout: which day of the local week it falls on, and its lifts. */
export interface PersonaWorkout {
  readonly name: string;
  /** Days after the local Monday, 0 to 6. */
  readonly dayOffset: number;
  readonly lifts: readonly PersonaLift[];
  /** Overrides the training's start hour, local. */
  readonly startHour?: number;
  readonly startMinute?: number;
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
  /**
   * How hard every set is taken: the velocity loss, in percent, the last target rep
   * reaches on a fresh set. Around 20 is a typical hypertrophy stop; 30 and up is
   * close to failure and reads as grinding.
   */
  readonly targetRepVelocityLossPct: number;
  /**
   * Each lift's last set taken close to failure now and then, outside deloads. Those
   * sets are what a lift's baseline calibrates from, and a goal reads as calibrating
   * until it has some.
   */
  readonly hardSets?: PersonaHardSets;
  readonly restSec: number;
  /** Load added each non-deload week, as a share of the starting load. */
  readonly weeklyGain: number;
  /** Local hour the sessions start at. */
  readonly startHour: number;
  /** Weeks with no training at all. The first week back drops the load. */
  readonly breaks?: readonly PersonaBreak[];
  /** `kg` picks every load as whole kilograms; the store still holds pounds. */
  readonly loadUnit?: 'lb' | 'kg';
  /** `truecoach` writes the plan as the TrueCoach import writes it, external ids and all. */
  readonly planSource?: 'local' | 'truecoach';
}

export interface PersonaHardSets {
  /** One week in this many, counting back from the week before the newest. */
  readonly everyWeeks: number;
  readonly velocityLossPct: number;
}

export interface PersonaBreak {
  /** The first history week with no training, 0-based. */
  readonly fromWeek: number;
  readonly weeks: number;
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

/** What a persona's extra writer added, merged into the seed report. */
export interface PersonaExtrasReport {
  readonly sessions: number;
  readonly sets: number;
  readonly goals: number;
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
  /** The tier the intake declares; absent is intermediate. */
  readonly declaredTier?: 'beginner' | 'intermediate' | 'advanced';
  /** The unit the lifter reads loads in. A wall setting, not a stored one; absent is lb. */
  readonly displayUnit?: 'lb' | 'kg';
  /** Rows the weekly shape cannot express, written after everything else. */
  readonly seedExtras?: (store: PersonaStore, now: Date, rng: Rng) => Promise<PersonaExtrasReport>;
}
