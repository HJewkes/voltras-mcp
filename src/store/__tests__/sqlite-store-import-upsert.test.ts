// Tests for the TrueCoach re-import upsert path (importPlanTree /
// #applyImportExercise). VW-202: a follow-up to #290, which fixed the shared
// upsert SQL so a re-import no longer nulls a coach-set target_tempo_json.
// This file pins that fix and the pre-existing target_rpe survival it shares
// the code path with.

import { beforeEach, describe, expect, it } from 'vitest';
import { SqliteSessionStore } from '../sqlite-store.js';
import type { PlanImportTemplate, StoredTrainingProgram } from '../types.js';

function makeProgram(overrides: Partial<StoredTrainingProgram> = {}): StoredTrainingProgram {
  return {
    id: 'prog-1',
    name: 'TrueCoach import',
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeImportTemplate(overrides: Partial<PlanImportTemplate> = {}): PlanImportTemplate {
  return {
    externalId: 'tc:workout:1',
    weekId: 'week-1',
    dayLabel: 'Upper A',
    name: 'Upper A',
    orderIndex: 0,
    exercises: [
      {
        externalId: 'tc:item:1',
        exerciseId: 'bench-press',
        orderIndex: 0,
        targetSets: 3,
        targetRepsLow: 8,
        targetRepsHigh: 12,
        targetWeightLbs: 135,
      },
    ],
    ...overrides,
  };
}

describe('SqliteSessionStore — importPlanTree upsert (VW-202)', () => {
  let store: SqliteSessionStore;

  beforeEach(async () => {
    store = SqliteSessionStore.open(':memory:');
    await store.putTrainingProgram(makeProgram());
    await store.putTrainingBlock({
      id: 'block-1',
      programId: 'prog-1',
      orderIndex: 0,
      name: 'Block 1',
      weeksCount: 1,
    });
    await store.putTrainingWeek({ id: 'week-1', blockId: 'block-1', orderIndex: 0 });
  });

  it('a re-import with no local edits leaves a coach-set tempo and RPE intact', async () => {
    await store.importPlanTree([makeImportTemplate()]);
    const [imported] = await store.getPlannedExercisesForTemplate(
      (await store.getWorkoutTemplateByExternalId('tc:workout:1'))!.id,
    );
    expect(imported).toBeDefined();

    // A coach sets a tempo and RPE locally — the import format itself carries
    // neither field (see PlanImportExercise).
    const targetTempo = { ecc: 3, pauseBottom: 1, con: 1, pauseTop: 0 };
    await store.putPlannedExercise({ ...imported!, targetRpe: 8, targetTempo });

    // Re-import the same tree, unchanged.
    await store.importPlanTree([makeImportTemplate()]);

    const template = await store.getWorkoutTemplateByExternalId('tc:workout:1');
    const [reimported] = await store.getPlannedExercisesForTemplate(template!.id);
    expect(reimported?.id).toBe(imported!.id);
    expect(reimported?.targetRpe).toBe(8);
    expect(reimported?.targetTempo).toEqual(targetTempo);
  });

  it('a re-import with a changed field updates in place without wiping siblings or tempo', async () => {
    const template = makeImportTemplate({
      exercises: [
        {
          externalId: 'tc:item:1',
          exerciseId: 'bench-press',
          orderIndex: 0,
          targetSets: 3,
          targetRepsLow: 8,
          targetRepsHigh: 12,
          targetWeightLbs: 135,
        },
        {
          externalId: 'tc:item:2',
          exerciseId: 'row',
          orderIndex: 1,
          targetSets: 4,
          targetRepsLow: 6,
          targetRepsHigh: 10,
          targetWeightLbs: 90,
        },
      ],
    });
    await store.importPlanTree([template]);

    const workoutTemplate = await store.getWorkoutTemplateByExternalId('tc:workout:1');
    const first = await store.getPlannedExerciseByExternalId('tc:item:1');
    const second = await store.getPlannedExerciseByExternalId('tc:item:2');
    const targetTempo = { ecc: 3, pauseBottom: 1, con: 1, pauseTop: 0 };
    await store.putPlannedExercise({ ...first!, targetRpe: 8, targetTempo });

    // Re-import with the first exercise's weight changed; the second is untouched.
    const updated = makeImportTemplate({
      exercises: [{ ...template.exercises[0]!, targetWeightLbs: 145 }, template.exercises[1]!],
    });
    await store.importPlanTree([updated]);

    const reimportedFirst = await store.getPlannedExerciseByExternalId('tc:item:1');
    expect(reimportedFirst?.id).toBe(first!.id);
    expect(reimportedFirst?.targetWeightLbs).toBe(145);
    expect(reimportedFirst?.targetRpe).toBe(8);
    expect(reimportedFirst?.targetTempo).toEqual(targetTempo);

    const reimportedSecond = await store.getPlannedExerciseByExternalId('tc:item:2');
    expect(reimportedSecond?.id).toBe(second!.id);
    expect(reimportedSecond?.targetSets).toBe(4);

    const exercises = await store.getPlannedExercisesForTemplate(workoutTemplate!.id);
    expect(exercises).toHaveLength(2);
  });
});
