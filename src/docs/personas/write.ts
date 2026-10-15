// `seedPersona`: write one persona into a store through its public methods only,
// the way `seedGoalPreview` does (`../preview-seeds.ts`). Tables no persona has
// a writer for stay empty, as they would on a real store.
//
// Sets are stamped `source: 'local'`, never `'mock'`: the per-muscle read models
// exclude mock sets by design (`read-models/muscle-set-scope.ts`). Sessions are
// stamped `kind: 'training'` unless the persona says otherwise, because every
// lifter-facing read skips an unreviewed session.

import { setCatalog } from '@voltras/workout-analytics';

import { HISTORY_SEED_EXERCISES } from '../../exercises/history-seed-catalog.js';
import { SEED_CABLE_EXERCISES } from '../../exercises/seed-catalog.js';
import { WEEKLY_CHECKIN_CODES, WEEKLY_CHECKIN_KIND } from '../../schemas/profile.js';
import { LOCAL_USER_ID, type SessionStore, type StoredSet } from '../../store/types.js';
import type { GoalDerivationState } from '../../tools/goal-derivation.js';
import { localAt, localDay, localMonday, weekLoadLbs, weekMonday, weekSlot } from './calendar.js';
import { afterRest, performSet } from './fatigue.js';
import { seedGoals } from './goals.js';
import { seedPlan, templateId } from './plan.js';
import { derivedVbt, rep } from './rep.js';
import { gaussian, pick, type Rng } from './rng.js';
import type { Persona, PersonaLift, PersonaTraining, PersonaWorkout } from './types.js';

/** The store slice a persona writes through. Every write is a public store method. */
export type PersonaStore = Pick<
  SessionStore,
  | 'putTrainingProfile'
  | 'putSession'
  | 'putSet'
  | 'putProgramAssignment'
  | 'putTrainingProgram'
  | 'putTrainingBlock'
  | 'putTrainingWeek'
  | 'putWorkoutTemplate'
  | 'putPlannedExercise'
  | 'appendBlockSchedule'
  | 'putBodyMetric'
  | 'putSelfReport'
  | 'putPriority'
  | 'putGoalTarget'
  | 'reharvestExercise'
  | 'recalcBaseline'
> &
  GoalDerivationState['store'];

export interface PersonaSeedReport {
  sessions: number;
  sets: number;
  weighIns: number;
  checkins: number;
  goals: number;
}

export async function seedPersona(
  store: PersonaStore,
  persona: Persona,
  now: Date,
  rng: Rng,
): Promise<PersonaSeedReport> {
  // Goal bands read the lift's ramp class from the catalog the server loads at boot.
  setCatalog([...SEED_CABLE_EXERCISES, ...HISTORY_SEED_EXERCISES]);
  if (persona.onboarded) await seedProfile(store, persona, now);
  const { training } = persona;
  const report: PersonaSeedReport = { sessions: 0, sets: 0, weighIns: 0, checkins: 0, goals: 0 };
  if (training !== undefined) {
    await seedPlan(store, persona.id, training, now);
    Object.assign(report, await seedTraining(store, persona, training, now, rng));
    await refreshBaselines(store, training);
    report.goals = await seedGoals(store, persona, training, now);
  }
  Object.assign(report, await seedBody(store, persona, now, rng));
  return report;
}

/** The session-0 intake, every checklist field answered. */
async function seedProfile(store: PersonaStore, persona: Persona, now: Date): Promise<void> {
  const daysPerWeek = persona.training?.workouts.length ?? 3;
  // Answered on the morning of the first trained week, before any session.
  const answeredAt = localAt(localMonday(now, persona.training?.weeks ?? 0), 0, 9).toISOString();
  await store.putTrainingProfile({
    userId: LOCAL_USER_ID,
    goal: 'Build strength',
    goalSetAt: answeredAt,
    daysAvailable: daysPerWeek,
    daysReliable: daysPerWeek,
    currentBaseline: 'Some gym experience',
    effortTolerance: 'moderate',
    target: 'Train consistently',
    declaredTier: 'intermediate',
    declaredAt: answeredAt,
    yearsTraining: 2,
    lastBreakMonths: 0,
    historyConsistent: true,
    everPlateaued: false,
    reportedSetsPerMuscle: 10,
    namedProgramHistory: 'Upper/lower split',
    injuries: [],
    onboardedAt: answeredAt,
    updatedAt: answeredAt,
  });
}

async function seedTraining(
  store: PersonaStore,
  persona: Persona,
  training: PersonaTraining,
  now: Date,
  rng: Rng,
): Promise<{ sessions: number; sets: number }> {
  let sessions = 0;
  let sets = 0;
  for (let week = 0; week < training.weeks; week++) {
    for (const [index, workout] of training.workouts.entries()) {
      sets += await seedSession(store, persona, { week, index, workout }, now, rng);
      sessions++;
    }
  }
  return { sessions, sets };
}

interface SessionSlot {
  readonly week: number;
  readonly index: number;
  readonly workout: PersonaWorkout;
}

/** One session and its sets; returns how many sets it wrote. */
async function seedSession(
  store: PersonaStore,
  persona: Persona,
  slot: SessionSlot,
  now: Date,
  rng: Rng,
): Promise<number> {
  const training = persona.training as PersonaTraining;
  const startedAt = localAt(
    weekMonday(training, now, slot.week),
    slot.workout.dayOffset,
    training.startHour,
  );
  const id = `${persona.id}-session-${slot.week + 1}-${slot.index + 1}`;
  const sets = sessionSets(training, slot, id, startedAt, rng);
  const kind = persona.kind === undefined ? 'training' : persona.kind;
  const [first] = slot.workout.lifts;
  await store.putSession({
    id,
    startedAt: startedAt.toISOString(),
    endedAt: sets.at(-1)?.endedAt ?? startedAt.toISOString(),
    ...(first !== undefined ? { exerciseId: first.exerciseId, exerciseName: first.name } : {}),
    ...(kind !== null ? { kind } : {}),
  });
  for (const set of sets) await store.putSet(set);
  if (weekSlot(training, slot.week) !== undefined) {
    await store.putProgramAssignment({
      id: `${id}-assignment`,
      sessionId: id,
      workoutTemplateId: templateId(persona.id, slot.week, slot.index),
      assignedAt: startedAt.toISOString(),
    });
  }
  return sets.length;
}

/** Every set of one session, lift by lift, each lift starting fresh. */
function sessionSets(
  training: PersonaTraining,
  slot: SessionSlot,
  sessionId: string,
  startedAt: Date,
  rng: Rng,
): StoredSet[] {
  const deload = weekSlot(training, slot.week)?.deload === true;
  const perLift = deload ? Math.max(1, training.setsPerLift - 1) : training.setsPerLift;
  const sets: StoredSet[] = [];
  let clockMs = startedAt.getTime();
  for (const lift of slot.workout.lifts) {
    const loadLbs = weekLoadLbs(training, lift, slot.week);
    let fatigue = 0;
    for (let n = 0; n < perLift; n++) {
      const done = performSet(lift.lifter, fatigue, { targetReps: training.targetReps }, rng);
      const set = setRow(
        { sessionId, lift, loadLbs, startMs: clockMs, order: sets.length },
        done.velocities,
      );
      if (n > 0) set.restBeforeSec = training.restSec;
      sets.push(set);
      clockMs = Date.parse(set.endedAt) + training.restSec * 1000;
      fatigue = afterRest(lift.lifter, done.fatigueAfter, training.restSec);
    }
  }
  return sets;
}

interface SetPlacement {
  readonly sessionId: string;
  readonly lift: PersonaLift;
  readonly loadLbs: number;
  readonly startMs: number;
  /** 0-based position in the session. */
  readonly order: number;
}

const REP_MS = 3_000;

function setRow(at: SetPlacement, velocities: readonly number[]): StoredSet {
  const id = `${at.sessionId}-set-${at.order + 1}`;
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
    weightLbs: at.loadLbs,
    trainingMode: 'Weight Training',
    source: 'local',
    reps: velocities.map((velocity, index) => {
      const mps = Number(velocity.toFixed(3));
      return { ...rep(id, index, mps), derived: derivedVbt(index + 1, mps, at.loadLbs) };
    }),
  };
}

/** The anchors and baselines the tools refresh after every set, refreshed once per lift. */
async function refreshBaselines(store: PersonaStore, training: PersonaTraining): Promise<void> {
  const exerciseIds = new Set(training.workouts.flatMap((w) => w.lifts.map((l) => l.exerciseId)));
  for (const exerciseId of exerciseIds) {
    const key = { userId: LOCAL_USER_ID, exerciseId };
    await store.reharvestExercise(key);
    await store.recalcBaseline(key);
  }
}

/** Weigh-ins on the first days of each history week, and a check-in on each week's Sunday. */
async function seedBody(
  store: PersonaStore,
  persona: Persona,
  now: Date,
  rng: Rng,
): Promise<{ weighIns: number; checkins: number }> {
  const { body, training } = persona;
  if (body === undefined || training === undefined) return { weighIns: 0, checkins: 0 };
  let weighIns = 0;
  let checkins = 0;
  for (let week = 0; week < training.weeks; week++) {
    const monday = weekMonday(training, now, week);
    for (let day = 0; day < body.weighInsPerWeek; day++, weighIns++) {
      const bodyweightLbs = Math.round((body.startLbs + 0.6 * gaussian(rng)) * 10) / 10;
      const measuredAt = localAt(monday, day, 7).toISOString();
      await store.putBodyMetric({ userId: LOCAL_USER_ID, measuredAt, bodyweightLbs });
    }
    if (body.weeklyCheckins) {
      await seedCheckin(store, persona.id, localDay(localAt(monday, 6, 12)), rng);
      checkins++;
    }
  }
  return { weighIns, checkins };
}

/** One weekly check-in, written as `profile.log_weekly_checkin` writes it. */
async function seedCheckin(
  store: PersonaStore,
  personaId: string,
  weekOf: string,
  rng: Rng,
): Promise<void> {
  for (const code of WEEKLY_CHECKIN_CODES) {
    await store.putSelfReport({
      id: `${personaId}-checkin-${weekOf}-${code}`,
      userId: LOCAL_USER_ID,
      kind: WEEKLY_CHECKIN_KIND,
      questionCode: code,
      valueText: pick(rng, ['medium', 'medium', 'high', 'low']),
      recordedAt: `${weekOf}T00:00:00.000Z`,
    });
  }
}
