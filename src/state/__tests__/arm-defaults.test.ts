import { describe, expect, it } from 'vitest';

import type { StoredPlannedExercise } from '../../store/types.js';
import { resolveArmDefaults } from '../arm-defaults.js';

function plannedRow(overrides: Partial<StoredPlannedExercise> = {}): StoredPlannedExercise {
  return {
    id: 'pe-1',
    workoutTemplateId: 'tpl-1',
    exerciseId: 'ex-press',
    orderIndex: 0,
    targetSets: 3,
    ...overrides,
  };
}

describe('resolveArmDefaults (VW-718)', () => {
  it("takes a strength row's intent default as a plan_intent watch", () => {
    const defaults = resolveArmDefaults(plannedRow({ trainingIntent: 'strength' }));

    expect(defaults).toEqual({
      watch: {
        notifyOn: [
          {
            type: 'velocity_loss_exceeded',
            pct: 20,
            intent: 'strength',
            thresholdSource: 'plan_intent',
          },
        ],
      },
      source: 'plan_row',
    });
  });

  it("takes the row's own loss target over its intent", () => {
    const defaults = resolveArmDefaults(
      plannedRow({
        trainingIntent: 'strength',
        goalKind: 'velocity_loss',
        targetVelocityLossPct: 25,
      }),
    );

    expect(defaults?.watch.notifyOn).toEqual([
      { type: 'velocity_loss_exceeded', pct: 25, intent: 'strength', thresholdSource: 'explicit' },
    ]);
  });

  it('resolves nothing without a row, or from a row that names no intent or loss', () => {
    expect(resolveArmDefaults(undefined)).toBeUndefined();
    expect(resolveArmDefaults(plannedRow({ targetRepsLow: 8 }))).toBeUndefined();
  });
});
