// A persona's lift goals, accepted the way `goal.propose_targets` stores them:
// the band comes from the real derivation over the persona's own history, so the
// goal line and the band agree at acceptance (see `seedGoalPreview`).

import { blockEndsAt } from '../../analytics/goal-block-weeks.js';
import { LOCAL_USER_ID } from '../../store/types.js';
import { readDerivationContext } from '../../tools/goal-derivation.js';
import { acceptedBandOf } from '../preview-seeds.js';
import { localAt, weekLoadLbs, weekMonday } from './calendar.js';
import type { Persona, PersonaGoal, PersonaTraining } from './types.js';
import type { PersonaStore } from './write.js';

const GOAL_HORIZON_WEEKS = 8;
/** The start reading is taken this many weeks before the newest week, so `now` reads mid-goal. */
const START_WEEKS_BEFORE_NEWEST = 3;

export async function seedGoals(
  store: PersonaStore,
  persona: Persona,
  training: PersonaTraining,
  now: Date,
): Promise<number> {
  const goals = persona.goals ?? [];
  for (const goal of goals) await seedGoal(store, persona.id, training, goal, now);
  return goals.length;
}

async function seedGoal(
  store: PersonaStore,
  personaId: string,
  training: PersonaTraining,
  goal: PersonaGoal,
  now: Date,
): Promise<void> {
  const workout = training.workouts.find((w) =>
    w.lifts.some((l) => l.exerciseId === goal.exerciseId),
  );
  const lift = workout?.lifts.find((l) => l.exerciseId === goal.exerciseId);
  if (workout === undefined || lift === undefined) {
    throw new Error(`persona ${personaId}: goal on ${goal.exerciseId}, which it never trains`);
  }
  const week = Math.max(0, training.weeks - 1 - START_WEEKS_BEFORE_NEWEST);
  const monday = weekMonday(training, now, week);
  const startMeasuredAt = localAt(monday, workout.dayOffset, training.startHour).toISOString();
  const startValue = weekLoadLbs(training, lift, week);
  const id = `${personaId}-goal-${goal.exerciseId}`;
  const priority = await store.putPriority({
    id: `${id}-priority`,
    userId: LOCAL_USER_ID,
    horizonWeeks: GOAL_HORIZON_WEEKS,
    kind: 'lift',
    ref: goal.exerciseId,
    level: goal.level,
    declaredAt: startMeasuredAt,
    mesosHeld: 1,
  });
  const context = await readDerivationContext({ store }, priority);
  const level = goal.acceptedCold === true ? 'cold' : 'ramp';
  const band = acceptedBandOf(context, startValue, level, goal.exerciseId);
  await store.putGoalTarget({
    id: `${id}-target`,
    priorityId: priority.id,
    metric: 'top_load_at_reps',
    exerciseId: goal.exerciseId,
    anchorReps: training.targetReps,
    startValue,
    startMeasuredAt,
    bandLowPctPerWeek: band.bandLowPctPerWeek,
    bandHighPctPerWeek: band.bandHighPctPerWeek,
    committedValue: band.committedValue,
    stretchValue: band.stretchValue,
    basis: band.basis,
    infoLevel: band.infoLevel,
    tierUsed: context.tier,
    tierProvisional: context.tierProvisional,
    dietPhaseAtDerivation: context.dietState.phase,
    acceptedBy: 'user',
    acknowledgedStretch: false,
    derivedAt: startMeasuredAt,
    endsAt: blockEndsAt(startMeasuredAt, GOAL_HORIZON_WEEKS),
  });
}
