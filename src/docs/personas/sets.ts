// One session's set rows: lift by lift, each lift starting fresh, the fatigue
// shape carried from set to set by the rest between them.

import { LOCAL_USER_ID, type StoredSet, type StoredSide } from '../../store/types.js';
import { roundLoad, weekLoadLbs, weekSlot } from './calendar.js';
import { afterRest, performSet } from './fatigue.js';
import { lifterAt } from './lifts.js';
import { derivedVbt, rep } from './rep.js';
import type { Rng } from './rng.js';
import type { PersonaLift, PersonaMode, PersonaTraining, PersonaWorkout } from './types.js';

export interface SessionSlot {
  readonly week: number;
  readonly index: number;
  readonly workout: PersonaWorkout;
}

const NO_LOAD_MODES: ReadonlySet<string> = new Set(['Damper', 'Isokinetic']);

/** Whether the lift's mode has a load to store. Damper and isokinetic sets have none. */
export function carriesLoad(lift: PersonaLift): boolean {
  return !NO_LOAD_MODES.has(lift.mode?.trainingMode ?? 'Weight Training');
}

/** Sets of `lift` in one session; a deload week drops one. */
export function setsFor(training: PersonaTraining, lift: PersonaLift, deload: boolean): number {
  const sets = lift.sets ?? training.setsPerLift;
  return deload ? Math.max(1, sets - 1) : sets;
}

export function sessionSets(
  training: PersonaTraining,
  slot: SessionSlot,
  sessionId: string,
  startedAt: Date,
  rng: Rng,
): StoredSet[] {
  const deload = weekSlot(training, slot.week)?.deload === true;
  const { targetReps, restSec } = training;
  const sets: StoredSet[] = [];
  let clockMs = startedAt.getTime();
  for (const lift of slot.workout.lifts) {
    const loadLbs = weekLoadLbs(training, lift, slot.week);
    const setCount = setsFor(training, lift, deload);
    let fatigue = 0;
    for (let n = 0; n < setCount; n++) {
      const effort = effortPct(training, slot.week, deload || n < setCount - 1);
      const lifter = lifterAt(lift.lifter, targetReps, effort);
      const done = performSet(lifter, fatigue, { targetReps }, rng);
      const at = { sessionId, lift, loadLbs, startMs: clockMs, order: sets.length };
      const rows = liftRows(training, at, done.velocities);
      if (n > 0) for (const row of rows) row.restBeforeSec = restSec;
      sets.push(...rows);
      clockMs = Date.parse(rows[0]!.endedAt) + restSec * 1000;
      fatigue = afterRest(lifter, done.fatigueAfter, restSec);
    }
  }
  return sets;
}

/**
 * The velocity loss one set is taken to: the training's usual stop, or the hard
 * set's on a lift's last set in a hard week. Hard weeks count back from the
 * newest, which is never one, so the latest session reads like an ordinary day.
 */
function effortPct(training: PersonaTraining, week: number, ordinary: boolean): number {
  const { hardSets } = training;
  if (hardSets === undefined || ordinary) return training.targetRepVelocityLossPct;
  const weeksBack = training.weeks - 1 - week;
  const hard = weeksBack % hardSets.everyWeeks === hardSets.everyWeeks - 1;
  return hard ? hardSets.velocityLossPct : training.targetRepVelocityLossPct;
}

export interface SetPlacement {
  readonly sessionId: string;
  readonly lift: PersonaLift;
  readonly loadLbs: number;
  readonly startMs: number;
  /** 0-based position in the session. */
  readonly order: number;
}

/** One set's rows: one, or a left and a right row paired as the live path pairs them. */
function liftRows(
  training: PersonaTraining,
  at: SetPlacement,
  velocities: readonly number[],
): StoredSet[] {
  const { bilateral } = at.lift;
  if (bilateral === undefined) return [setRow(at, velocities)];
  const groupId = `${at.sessionId}-pair-${at.order + 1}`;
  const leftLoadLbs = roundLoad(training, at.loadLbs * bilateral.leftLoadShare);
  return [
    sideRow(setRow({ ...at, loadLbs: leftLoadLbs }, velocities), 'left', groupId),
    sideRow(setRow({ ...at, order: at.order + 1 }, velocities), 'right', groupId),
  ];
}

function sideRow(set: StoredSet, side: StoredSide, groupId: string): StoredSet {
  return {
    ...set,
    slot: side,
    side,
    deviceId: `synthetic-unit-${side}`,
    bilateralGroupId: groupId,
    groupSource: 'live',
  };
}

const REP_MS = 3_000;

export function setRow(at: SetPlacement, velocities: readonly number[]): StoredSet {
  const id = `${at.sessionId}-set-${at.order + 1}`;
  const weightLbs = carriesLoad(at.lift) ? at.loadLbs : undefined;
  return {
    id,
    sessionId: at.sessionId,
    userId: LOCAL_USER_ID,
    startedAt: new Date(at.startMs).toISOString(),
    endedAt: new Date(at.startMs + velocities.length * REP_MS).toISOString(),
    partial: false,
    exerciseId: at.lift.exerciseId,
    slot: 'primary',
    setPurpose: 'working',
    setIndexInSession: at.order + 1,
    ...resistance(at.lift.mode, weightLbs),
    source: 'local',
    reps: velocities.map((velocity, index) => {
      const mps = Number(velocity.toFixed(3));
      return { ...rep(id, index, mps), derived: derivedVbt(index + 1, mps, weightLbs) };
    }),
  };
}

function resistance(mode: PersonaMode | undefined, weightLbs: number | undefined) {
  return {
    ...(weightLbs !== undefined ? { weightLbs } : {}),
    trainingMode: mode?.trainingMode ?? 'Weight Training',
    ...(mode?.damperLevel !== undefined ? { damperLevel: mode.damperLevel } : {}),
    ...(mode?.chainsLbs !== undefined ? { chainsLbs: mode.chainsLbs } : {}),
  };
}
