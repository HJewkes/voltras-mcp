// A persona's program tree: one program, its blocks laid end to end from the
// first history week, a template per workout per week, and a dated schedule per
// block. A block may run past the history, so the plan shows weeks still to come.
//
// A `truecoach` plan is written in the shape `truecoach.import_week` leaves
// (`integrations/truecoach/map.ts`, `tools/truecoach-tools.ts`): weeks named by
// ISO week, every template and planned row keyed by an invented external id, the
// coach's instruction verbatim in the notes, and the schedule changed by `import`.

import { isoWeekLabel } from '../../integrations/truecoach/map.js';
import type { StoredPlannedExercise, StoredWorkoutTemplate } from '../../store/types.js';
import type { PersonaStore } from './write.js';
import { localAt, localDay, weekLoadLbs, weekMonday, weekSlot, workoutStart } from './calendar.js';
import { carriesLoad, setsFor } from './sets.js';
import type { PersonaBlock, PersonaLift, PersonaTraining } from './types.js';

export function templateId(personaId: string, week: number, workoutIndex: number): string {
  return `${personaId}-week-${week + 1}-workout-${workoutIndex + 1}`;
}

const IMPORT_BLOCK_NOTES =
  "Imported from TrueCoach. Coach text is kept verbatim in each row's notes.";

export async function seedPlan(
  store: PersonaStore,
  personaId: string,
  training: PersonaTraining,
  now: Date,
): Promise<void> {
  if (training.blocks.length === 0) return;
  const plan: PlanContext = {
    personaId,
    training,
    now,
    imported: training.planSource === 'truecoach',
    programId: `${personaId}-program`,
    createdAt: localAt(weekMonday(training, now, 0), 0, 8).toISOString(),
  };
  const name = plan.imported ? 'Coached program' : 'Upper / Lower';
  await store.putTrainingProgram({ id: plan.programId, name, createdAt: plan.createdAt });
  let firstWeek = 0;
  for (const [orderIndex, block] of training.blocks.entries()) {
    await seedBlock(store, plan, { block, orderIndex, firstWeek });
    firstWeek += block.weeks;
  }
}

interface PlanContext {
  readonly personaId: string;
  readonly training: PersonaTraining;
  readonly now: Date;
  readonly imported: boolean;
  readonly programId: string;
  readonly createdAt: string;
}

async function seedBlock(
  store: PersonaStore,
  plan: PlanContext,
  { block, orderIndex, firstWeek }: { block: PersonaBlock; orderIndex: number; firstWeek: number },
): Promise<void> {
  const blockId = `${plan.personaId}-block-${orderIndex + 1}`;
  await store.putTrainingBlock({
    id: blockId,
    programId: plan.programId,
    orderIndex,
    name: block.name,
    weeksCount: block.weeks,
    ...(plan.imported ? { notes: IMPORT_BLOCK_NOTES } : {}),
  });
  for (let week = firstWeek; week < firstWeek + block.weeks; week++) {
    await seedWeek(store, plan, { blockId, week, orderIndex: week - firstWeek });
  }
  await store.appendBlockSchedule({
    blockId,
    startsOn: localDay(weekMonday(plan.training, plan.now, firstWeek)),
    weeksCount: block.weeks,
    skips: [],
    kind: 'planned',
    changedBy: plan.imported ? 'import' : 'user',
    declaredAt: plan.createdAt,
  });
}

async function seedWeek(
  store: PersonaStore,
  plan: PlanContext,
  at: { blockId: string; week: number; orderIndex: number },
): Promise<void> {
  const { personaId, training, now } = plan;
  const deload = weekSlot(training, at.week)?.deload === true;
  const weekId = `${personaId}-week-${at.week + 1}`;
  const monday = localDay(weekMonday(training, now, at.week));
  const localName = deload ? 'Deload' : `Week ${at.orderIndex + 1}`;
  await store.putTrainingWeek({
    id: weekId,
    blockId: at.blockId,
    orderIndex: at.orderIndex,
    name: plan.imported ? isoWeekLabel(monday) : localName,
    isDeload: deload,
  });
  for (const [workoutIndex, workout] of training.workouts.entries()) {
    const id = templateId(personaId, at.week, workoutIndex);
    const template: StoredWorkoutTemplate = {
      id,
      weekId,
      name: workout.name,
      orderIndex: workoutIndex,
    };
    if (plan.imported) {
      const due = localDay(workoutStart(training, workout, now, at.week));
      Object.assign(template, importedTemplate(at.week, workoutIndex, due));
    }
    await store.putWorkoutTemplate(template);
    for (const [orderIndex, lift] of workout.lifts.entries()) {
      const slot = { templateId: id, week: at.week, orderIndex, lift, deload };
      await store.putPlannedExercise(plannedRow(training, slot));
    }
  }
}

interface PlannedSlot {
  readonly templateId: string;
  readonly week: number;
  readonly orderIndex: number;
  readonly lift: PersonaLift;
  readonly deload: boolean;
}

function plannedRow(training: PersonaTraining, slot: PlannedSlot): StoredPlannedExercise {
  const targetSets = setsFor(training, slot.lift, slot.deload);
  const targetWeightLbs = weekLoadLbs(training, slot.lift, slot.week);
  const row: StoredPlannedExercise = {
    id: `${slot.templateId}-exercise-${slot.orderIndex + 1}`,
    workoutTemplateId: slot.templateId,
    exerciseId: slot.lift.exerciseId,
    orderIndex: slot.orderIndex,
    targetSets,
    targetRepsLow: training.targetReps,
    targetRepsHigh: training.targetReps,
    ...(carriesLoad(slot.lift) ? { targetWeightLbs } : {}),
    restSec: training.restSec,
  };
  if (training.planSource !== 'truecoach') return row;
  const load = carriesLoad(slot.lift) ? ` @ ${targetWeightLbs} lb` : '';
  return {
    ...row,
    // An invented item number, unique per row, in the import's key shape.
    externalId: `tc:item:${row.id}`,
    notes: `${targetSets}x${training.targetReps}${load}, rest ${training.restSec}s`,
    goalKind: 'rep_range',
    // The coach wrote a rest, so the import keeps it fixed.
    restLearning: false,
  };
}

function importedTemplate(week: number, workoutIndex: number, due: string) {
  return {
    externalId: `tc:workout:${week + 1}-${workoutIndex + 1}`,
    dayLabel: due,
    notes: 'Warmup: 5 min row, then two light sets of the first lift',
  };
}
