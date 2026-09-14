// Fixtures for the priority-to-metrics rule (VW-347, plan H0 / §2b). One block
// per branch of the rule, plus a coverage block that walks every muscle string
// the seed catalog actually uses, so a catalog entry whose muscle group nothing
// can track shows up here rather than as an empty goal page.

import { describe, expect, it } from 'vitest';

import { SEED_CABLE_EXERCISES } from '../../exercises/seed-catalog.js';
import {
  MIN_CORROBORATING_LIFTS,
  NOT_MEASURABLE_REFS,
  PRIORITY_MUSCLE_SYNONYMS,
  resolveMuscleRef,
  selectGoalMetrics,
  type CatalogExercise,
  type GoalCorroborationGap,
  type GoalDoseMetric,
  type GoalGainMetric,
  type GoalMetricSelection,
  type GoalNotMeasurable,
} from '../goal-metrics.js';

const CATALOG: readonly CatalogExercise[] = SEED_CABLE_EXERCISES;

function gainsOf(selections: GoalMetricSelection[]): GoalGainMetric[] {
  return selections.filter((s): s is GoalGainMetric => s.kind === 'gain');
}

function doseOf(selections: GoalMetricSelection[]): GoalDoseMetric | undefined {
  return selections.find((s): s is GoalDoseMetric => s.kind === 'weekly_sets');
}

function gapOf(selections: GoalMetricSelection[]): GoalCorroborationGap | undefined {
  return selections.find((s): s is GoalCorroborationGap => s.kind === 'corroboration');
}

function unmeasurableOf(selections: GoalMetricSelection[]): GoalNotMeasurable | undefined {
  return selections.find((s): s is GoalNotMeasurable => s.kind === 'not_measurable');
}

function trackedIds(ref: string): string[] {
  return gainsOf(selectGoalMetrics({ kind: 'muscle', ref, level: 'specialize' }, CATALOG)).map(
    (gain) => gain.exerciseId ?? '',
  );
}

describe('a lift priority', () => {
  const selections = selectGoalMetrics(
    { kind: 'lift', ref: 'cable-chest-press', level: 'specialize' },
    CATALOG,
  );

  it('tracks the top load at matched reps and reads the e1RM trend as context', () => {
    expect(selections).toEqual([
      {
        kind: 'gain',
        metric: 'top_load_at_reps',
        exerciseId: 'cable-chest-press',
        anchorReps: null,
        role: 'primary',
      },
      {
        kind: 'gain',
        metric: 'e1rm_trend',
        exerciseId: 'cable-chest-press',
        anchorReps: null,
        role: 'context',
      },
    ]);
  });

  it('anchors the reps to the low edge of the exercise rep range when it has one', () => {
    const ranged: CatalogExercise[] = [
      { id: 'ranged-press', muscleGroups: ['chest'], defaultRepRange: { low: 6, high: 10 } },
    ];
    const [top] = gainsOf(
      selectGoalMetrics({ kind: 'lift', ref: 'ranged-press', level: 'specialize' }, ranged),
    );
    expect(top.anchorReps).toBe(6);
  });

  it('still yields both legs for an exercise the passed catalog does not hold', () => {
    const metrics = gainsOf(
      selectGoalMetrics({ kind: 'lift', ref: 'not-in-catalog', level: 'specialize' }, CATALOG),
    );
    expect(metrics.map((gain) => gain.metric)).toEqual(['top_load_at_reps', 'e1rm_trend']);
    expect(metrics[0].anchorReps).toBeNull();
  });
});

describe('a muscle priority', () => {
  it('tracks every lift whose primary mover maps onto the target, in catalog order', () => {
    expect(trackedIds('chest')).toEqual([
      'cable-chest-press',
      'cable-incline-chest-press',
      'cable-chest-fly',
      'cable-low-to-high-fly',
      'cable-high-to-low-fly',
    ]);
  });

  it('reports the dose as weekly sets, flagged informational (B47)', () => {
    const dose = doseOf(
      selectGoalMetrics({ kind: 'muscle', ref: 'chest', level: 'specialize' }, CATALOG),
    );
    expect(dose).toEqual({
      kind: 'weekly_sets',
      informational: true,
      exerciseId: null,
      muscles: ['chest'],
    });
  });

  it('claims no corroborated verdict once two or more lifts qualify', () => {
    expect(
      gapOf(selectGoalMetrics({ kind: 'muscle', ref: 'chest', level: 'specialize' }, CATALOG)),
    ).toBeUndefined();
  });

  it('fans a shoulders ref out to all three deltoid heads', () => {
    const dose = doseOf(
      selectGoalMetrics({ kind: 'muscle', ref: 'shoulders', level: 'specialize' }, CATALOG),
    );
    expect(dose?.muscles).toEqual(['front_delts', 'side_delts', 'rear_delts']);
    expect(trackedIds('shoulders')).toContain('cable-lateral-raise');
  });
});

describe('the synonym table', () => {
  it('resolves "arms" to the biceps AND triceps lifts', () => {
    expect(PRIORITY_MUSCLE_SYNONYMS.arms).toEqual(['biceps', 'triceps']);
    expect(trackedIds('arms')).toEqual([
      'cable-tricep-pushdown',
      'cable-overhead-tricep-extension',
      'cable-bicep-curl',
      'cable-hammer-curl',
      'cable-rope-curl',
      'cable-bayesian-curl',
    ]);
  });

  it('resolves "legs" to quads, hamstrings and glutes', () => {
    expect(PRIORITY_MUSCLE_SYNONYMS.legs).toEqual(['quads', 'hamstrings', 'glutes']);
    const ids = trackedIds('legs');
    expect(ids).toContain('cable-squat');
    expect(ids).toContain('cable-romanian-deadlift');
    expect(ids).toContain('cable-glute-kickback');
  });

  it('does not let a proxy row corroborate: "legs" skips the adduction lift', () => {
    // `adductors` maps to the quads slug only because the taxonomy has no
    // adductor slug. Counting it would claim a quad grew from an adductor lift
    // (review of PR #408). The dose still covers the quads slug.
    expect(trackedIds('legs')).not.toContain('cable-hip-adduction');
    expect(trackedIds('quads')).not.toContain('cable-hip-adduction');
    expect(
      doseOf(selectGoalMetrics({ kind: 'muscle', ref: 'legs', level: 'specialize' }, CATALOG))
        ?.muscles,
    ).toContain('quads');
  });

  it('still tracks a proxy-mapped lift when the human declares that muscle itself', () => {
    // The exact catalog string is the one path across a proxy row. The squat
    // sits on the same slug and is deliberately not here: the argument that
    // keeps adduction out of "legs" keeps quads out of "adductors".
    expect(trackedIds('adductors')).toEqual(['cable-hip-adduction']);
  });

  it('passes a catalog string through untouched, normalising case and spacing', () => {
    expect(resolveMuscleRef('chest')).toEqual(['chest']);
    expect(resolveMuscleRef('  ARMS ')).toEqual(['biceps', 'triceps']);
  });
});

describe('a muscle with too few qualifying lifts', () => {
  const soloCatalog: CatalogExercise[] = [
    { id: 'solo-curl', muscleGroups: ['biceps'] },
    { id: 'solo-press', muscleGroups: ['chest'] },
  ];
  const selections = selectGoalMetrics(
    { kind: 'muscle', ref: 'biceps', level: 'specialize' },
    soloCatalog,
  );

  it('is still tracked by the one lift there is', () => {
    expect(gainsOf(selections).map((gain) => gain.exerciseId)).toEqual(['solo-curl']);
  });

  it('leaves corroborated null and says why', () => {
    const gap = gapOf(selections);
    expect(gap?.corroborated).toBeNull();
    expect(gap?.qualifyingLifts).toBe(1);
    expect(gap?.reason).toContain(`needs ${MIN_CORROBORATING_LIFTS}`);
  });

  it('reports zero qualifying lifts for a muscle nothing trains as a primary', () => {
    const gap = gapOf(
      selectGoalMetrics({ kind: 'muscle', ref: 'forearms', level: 'specialize' }, CATALOG),
    );
    expect(gap?.qualifyingLifts).toBe(0);
    expect(gap?.reason).toContain('No catalog lift');
  });
});

describe('a deprioritized priority', () => {
  it('keeps the dose for a muscle and claims no gain', () => {
    const selections = selectGoalMetrics(
      { kind: 'muscle', ref: 'chest', level: 'deprioritize' },
      CATALOG,
    );
    expect(gainsOf(selections)).toEqual([]);
    expect(selections).toHaveLength(1);
    expect(doseOf(selections)?.informational).toBe(true);
  });

  it('keeps the dose for a lift and claims no gain', () => {
    const selections = selectGoalMetrics(
      { kind: 'lift', ref: 'cable-chest-press', level: 'deprioritize' },
      CATALOG,
    );
    expect(selections).toEqual([
      {
        kind: 'weekly_sets',
        informational: true,
        exerciseId: 'cable-chest-press',
        muscles: ['chest'],
      },
    ]);
  });

  it('still tracks a maintain-level muscle, since maintain is the default level', () => {
    const selections = selectGoalMetrics(
      { kind: 'muscle', ref: 'chest', level: 'maintain' },
      CATALOG,
    );
    expect(gainsOf(selections)).toHaveLength(5);
  });
});

describe('whole-body refs', () => {
  it.each([
    ['sessions', 'sessions_28d'],
    ['bodyweight', 'bodyweight'],
    ['strength', 'composite_strength'],
  ])('tracks %s as %s, with no exercise attached', (ref, metric) => {
    expect(selectGoalMetrics({ kind: 'muscle', ref, level: 'specialize' }, CATALOG)).toEqual([
      { kind: 'gain', metric, exerciseId: null, anchorReps: null, role: 'primary' },
    ]);
  });
});

describe('refs nothing can measure today', () => {
  it.each(['size', 'body_composition', 'velocity'])('returns a reason for %s', (ref) => {
    const selections = selectGoalMetrics({ kind: 'muscle', ref, level: 'specialize' }, CATALOG);
    const unmeasurable = unmeasurableOf(selections);
    expect(selections).toHaveLength(1);
    expect(unmeasurable?.notMeasurable).toBe(true);
    expect(unmeasurable?.reason).toBe(NOT_MEASURABLE_REFS[ref]);
  });

  it('names bodyweight as the thing body composition can be declared as instead', () => {
    expect(NOT_MEASURABLE_REFS.body_composition).toContain('bodyweight');
  });

  it('accepts the ref as a human would spell it', () => {
    const spoken = selectGoalMetrics(
      { kind: 'muscle', ref: 'Body Composition', level: 'specialize' },
      CATALOG,
    );
    expect(unmeasurableOf(spoken)?.ref).toBe('body_composition');
  });
});

describe('purity', () => {
  it('returns the same selection for the same input and leaves the catalog alone', () => {
    const before = JSON.stringify(SEED_CABLE_EXERCISES);
    const first = selectGoalMetrics({ kind: 'muscle', ref: 'arms', level: 'specialize' }, CATALOG);
    const second = selectGoalMetrics({ kind: 'muscle', ref: 'arms', level: 'specialize' }, CATALOG);
    expect(first).toEqual(second);
    expect(JSON.stringify(SEED_CABLE_EXERCISES)).toBe(before);
  });
});

// Every muscle string the seed catalog uses, primary or secondary. A string
// that reaches no lift must be listed below with the reason, so the gap is a
// decision on record rather than an empty goal page.
const CATALOG_MUSCLE_STRINGS = [
  ...new Set(
    SEED_CABLE_EXERCISES.flatMap((exercise) => [
      ...exercise.muscleGroups,
      ...(exercise.secondaryMuscleGroups ?? []),
    ]),
  ),
].sort();

const UNREACHABLE_MUSCLE_STRINGS: Record<string, string> = {
  forearms:
    'Secondary only: every curl and row lists forearms as an assister and no seed entry names it as the primary mover, so no lift can carry a forearms target.',
  traps:
    'A proxy row (upper_back) with no seed entry naming traps as the primary mover. The rows and pulldowns that land on upper_back train the region, not the traps, so none of them may corroborate a traps target.',
  abductors:
    'A proxy row (glutes) with no seed entry naming abductors as the primary mover — the hip abduction lift itself is catalogued as glutes. The glute lifts train the region, not the abductors.',
};

describe('catalog coverage', () => {
  it.each(CATALOG_MUSCLE_STRINGS)('resolves %s to a lift, or lists it as unreachable', (ref) => {
    const gains = gainsOf(selectGoalMetrics({ kind: 'muscle', ref, level: 'specialize' }, CATALOG));
    if (UNREACHABLE_MUSCLE_STRINGS[ref] !== undefined) {
      expect(gains).toEqual([]);
      return;
    }
    expect(gains.length).toBeGreaterThanOrEqual(1);
  });

  it('lists nothing as unreachable that a lift actually reaches', () => {
    for (const ref of Object.keys(UNREACHABLE_MUSCLE_STRINGS)) {
      expect(CATALOG_MUSCLE_STRINGS).toContain(ref);
      expect(trackedIds(ref)).toEqual([]);
    }
  });
});
