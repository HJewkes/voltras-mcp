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

const ASSUMED = {
  watch: { notifyOn: [{ type: 'velocity_loss_exceeded', pct: 30, thresholdSource: 'default' }] },
  source: 'default',
};

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

  it('takes the labelled assumed stop without a row, or from a row that names no intent or loss (VW-719)', () => {
    expect(resolveArmDefaults(undefined)).toEqual(ASSUMED);
    expect(resolveArmDefaults(plannedRow({ targetRepsLow: 8 }))).toEqual(ASSUMED);
  });

  it("a row's own loss target with no intent still wins over the assumed stop", () => {
    const defaults = resolveArmDefaults(
      plannedRow({ goalKind: 'velocity_loss', targetVelocityLossPct: 35 }),
    );

    expect(defaults).toEqual({
      watch: {
        notifyOn: [{ type: 'velocity_loss_exceeded', pct: 35, thresholdSource: 'explicit' }],
      },
      source: 'plan_row',
    });
  });
});
