// Unit tests for the pure tier-aware volume lints (VMCP-06.03 / B31).
//
// `lintPlan` is tested directly rather than through `plan.exercise.create`
// because the tier signal cannot currently PRODUCE `advanced` — its derived
// ceiling stops at `intermediate` (see tier-signal.ts §3.5). The advanced-tier
// ceilings are still part of the contract, so they are exercised here at the
// one seam that can express them.

import { describe, it, expect } from 'vitest';
import {
  lintMesoLengthGrewMidBlock,
  lintPlan,
  lintPriorityMuscleChangedMidBlock,
  lintSameMuscleHighVolumeConsecutiveDays,
  lintWeeklyVolume,
  lintWeekWithoutOffDay,
  type LintPlanExercise,
} from '../lint-plan.js';

const CONFIDENT = 'confident' as const;

const ROW = ['lats', 'upper_back'];
const PRESS = ['chest', 'front_delts', 'triceps'];

function exercise(over: Partial<LintPlanExercise> = {}): LintPlanExercise {
  return { exerciseId: 'cable-fly', targetSets: 3, muscleGroups: ['chest'], ...over };
}

describe('sets per exercise', () => {
  it('warns once when a beginner plans 6 sets of one exercise', () => {
    const exercises = [exercise({ exerciseId: 'bench-press', targetSets: 6 })];

    const warnings = lintPlan({ exercises, tier: 'beginner', confidence: CONFIDENT });

    const perExercise = warnings.filter((w) => w.code === 'sets_per_exercise_over_tier_ceiling');
    expect(perExercise).toHaveLength(1);
    expect(perExercise[0]).toMatchObject({ exerciseId: 'bench-press', observed: 6, ceiling: 5 });
    expect(perExercise[0].message).toContain('Technique and effort before more sets');
  });

  it('leaves a beginner at the ceiling alone', () => {
    const exercises = [exercise({ targetSets: 5 })];

    const warnings = lintPlan({ exercises, tier: 'beginner', confidence: CONFIDENT });

    expect(warnings).toEqual([]);
  });

  it('treats the intermediate 2-4 attractor as a soft ceiling of 4', () => {
    const exercises = [exercise({ targetSets: 5 })];

    const warnings = lintPlan({ exercises, tier: 'intermediate', confidence: CONFIDENT });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: 'sets_per_exercise_over_tier_ceiling',
      observed: 5,
      ceiling: 4,
    });
  });

  it('never warns per exercise at the advanced tier, which has no per-session number', () => {
    const exercises = [exercise({ targetSets: 9 })];

    const warnings = lintPlan({ exercises, tier: 'advanced', confidence: CONFIDENT });

    expect(warnings).toEqual([]);
  });
});

describe('sets per muscle per session', () => {
  it('sums two chest exercises and warns at 9 sets for a beginner', () => {
    const exercises = [
      exercise({ exerciseId: 'bench-press', targetSets: 5 }),
      exercise({ exerciseId: 'cable-fly', targetSets: 4 }),
    ];

    const warnings = lintPlan({ exercises, tier: 'beginner', confidence: CONFIDENT });

    const perMuscle = warnings.filter(
      (w) => w.code === 'sets_per_muscle_per_session_over_tier_ceiling',
    );
    expect(perMuscle).toHaveLength(1);
    expect(perMuscle[0]).toMatchObject({ muscleGroup: 'chest', observed: 9, ceiling: 8 });
  });

  it('does not warn per muscle at the advanced tier on the same 9 sets', () => {
    const exercises = [
      exercise({ exerciseId: 'bench-press', targetSets: 5 }),
      exercise({ exerciseId: 'cable-fly', targetSets: 4 }),
    ];

    const warnings = lintPlan({ exercises, tier: 'advanced', confidence: CONFIDENT });

    expect(warnings).toEqual([]);
  });

  // The corpus gives the intermediate tier a LOWER floor than the beginner one
  // and the SAME ceiling: "4-8/muscle in week 1" against the beginner's 5-8
  // (rp-s5-volume-err-low-first-week). 9 sets is over both.
  it('warns an intermediate at the same 9 sets, and calls it recovery-dependent', () => {
    const exercises = [
      exercise({ exerciseId: 'bench-press', targetSets: 5 }),
      exercise({ exerciseId: 'cable-fly', targetSets: 4 }),
    ];

    const warnings = lintPlan({ exercises, tier: 'intermediate', confidence: CONFIDENT });

    const perMuscle = warnings.find(
      (w) => w.code === 'sets_per_muscle_per_session_over_tier_ceiling',
    );
    expect(perMuscle).toMatchObject({ muscleGroup: 'chest', observed: 9, ceiling: 8 });
    expect(perMuscle?.message).toContain('recovery-dependent');
    expect(perMuscle?.message).toContain('intermediate range of 4-8');
  });

  it('leaves an intermediate at exactly 8 sets for a muscle alone', () => {
    const exercises = [
      exercise({ exerciseId: 'bench-press', targetSets: 4 }),
      exercise({ exerciseId: 'cable-fly', targetSets: 4 }),
    ];

    const warnings = lintPlan({ exercises, tier: 'intermediate', confidence: CONFIDENT });

    expect(
      warnings.filter((w) => w.code === 'sets_per_muscle_per_session_over_tier_ceiling'),
    ).toEqual([]);
  });

  it('leaves a beginner at exactly 8 sets for a muscle alone', () => {
    const exercises = [
      exercise({ exerciseId: 'bench-press', targetSets: 5 }),
      exercise({ exerciseId: 'cable-fly', targetSets: 3 }),
    ];

    const warnings = lintPlan({ exercises, tier: 'beginner', confidence: CONFIDENT });

    expect(warnings).toEqual([]);
  });

  it('names the tier it judged against in every per-muscle message', () => {
    const exercises = [exercise({ targetSets: 9 })];

    for (const tier of ['beginner', 'intermediate'] as const) {
      const warnings = lintPlan({ exercises, tier, confidence: CONFIDENT });

      const perMuscle = warnings.find(
        (w) => w.code === 'sets_per_muscle_per_session_over_tier_ceiling',
      );
      expect(perMuscle?.message).toContain(`the ${tier} range of`);
    }
  });

  it('keeps different muscle groups in separate buckets', () => {
    const exercises = [
      exercise({ exerciseId: 'bench-press', targetSets: 5, muscleGroups: ['chest'] }),
      exercise({ exerciseId: 'cable-row', targetSets: 5, muscleGroups: ['lats'] }),
    ];

    const warnings = lintPlan({ exercises, tier: 'beginner', confidence: CONFIDENT });

    expect(warnings).toEqual([]);
  });

  it('keeps different days in separate buckets', () => {
    const exercises = [
      exercise({ exerciseId: 'bench-press', targetSets: 5, dayIndex: 0 }),
      exercise({ exerciseId: 'cable-fly', targetSets: 4, dayIndex: 1 }),
    ];

    const warnings = lintPlan({ exercises, tier: 'beginner', confidence: CONFIDENT });

    expect(warnings).toEqual([]);
  });

  it('skips an exercise whose muscle group could not be resolved', () => {
    const exercises = [
      exercise({ exerciseId: 'bench-press', targetSets: 5 }),
      { exerciseId: 'mystery-machine', targetSets: 4, muscleGroups: [] },
    ];

    const warnings = lintPlan({ exercises, tier: 'beginner', confidence: CONFIDENT });

    expect(warnings).toEqual([]);
  });

  it('counts a two-target exercise in full toward each target', () => {
    const exercises = [
      exercise({ exerciseId: 'cable-row', targetSets: 5, muscleGroups: ['lats', 'upper_back'] }),
      exercise({ exerciseId: 'lat-pulldown', targetSets: 4, muscleGroups: ['lats'] }),
      exercise({ exerciseId: 'face-pull', targetSets: 4, muscleGroups: ['upper_back'] }),
    ];

    const warnings = lintPlan({ exercises, tier: 'beginner', confidence: CONFIDENT });

    expect(warnings.map((w) => [w.muscleGroup, w.observed])).toEqual([
      ['lats', 9],
      ['upper_back', 9],
    ]);
  });

  it('names a slug with spaces in the warning copy', () => {
    const exercises = [exercise({ targetSets: 9, muscleGroups: ['front_delts'] })];

    const warnings = lintPlan({ exercises, tier: 'beginner', confidence: CONFIDENT });

    const perMuscle = warnings.find(
      (w) => w.code === 'sets_per_muscle_per_session_over_tier_ceiling',
    );
    expect(perMuscle?.muscleGroup).toBe('front_delts');
    expect(perMuscle?.message).toContain('9 sets for front delts in this session');
  });
});

describe('provisional tier', () => {
  it('says the tier is provisional in every warning it emits', () => {
    const exercises = [exercise({ targetSets: 9 })];

    const warnings = lintPlan({ exercises, tier: 'beginner', confidence: 'provisional' });

    expect(warnings.length).toBeGreaterThan(0);
    for (const warning of warnings) {
      expect(warning.message).toContain('tier is provisional');
      expect(warning.message).toContain('profile.set_training_background');
    }
  });

  it('says nothing about provisionality when the tier is confident', () => {
    const exercises = [exercise({ targetSets: 9 })];

    const warnings = lintPlan({ exercises, tier: 'beginner', confidence: CONFIDENT });

    for (const warning of warnings) {
      expect(warning.message).not.toContain('provisional');
    }
  });
});

describe('weekly hard sets per muscle', () => {
  it('warns a beginner at 21 sets for a muscle across the week', () => {
    const exercises = [
      exercise({ exerciseId: 'bench-press', targetSets: 11, dayIndex: 0 }),
      exercise({ exerciseId: 'cable-fly', targetSets: 10, dayIndex: 1 }),
    ];

    const warnings = lintWeeklyVolume({ exercises, tier: 'beginner', confidence: CONFIDENT });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: 'hard_sets_per_muscle_per_week_over_tier_ceiling',
      muscleGroup: 'chest',
      observed: 21,
      ceiling: 20,
      tier: 'beginner',
    });
  });

  it('leaves a beginner at exactly 20 weekly sets for a muscle alone', () => {
    const exercises = [exercise({ targetSets: 20 })];

    const warnings = lintWeeklyVolume({ exercises, tier: 'beginner', confidence: CONFIDENT });

    expect(warnings).toEqual([]);
  });

  it('never warns at the advanced tier, which has no cited weekly figure', () => {
    const exercises = [exercise({ targetSets: 40 })];

    const warnings = lintWeeklyVolume({ exercises, tier: 'advanced', confidence: CONFIDENT });

    expect(warnings).toEqual([]);
  });

  it('never warns at the intermediate tier, which has no cited weekly figure', () => {
    const exercises = [exercise({ targetSets: 40 })];

    const warnings = lintWeeklyVolume({ exercises, tier: 'intermediate', confidence: CONFIDENT });

    expect(warnings).toEqual([]);
  });

  it('marks a provisional-tier weekly warning as provisional', () => {
    const exercises = [exercise({ targetSets: 21 })];

    const warnings = lintWeeklyVolume({ exercises, tier: 'beginner', confidence: 'provisional' });

    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('tier is provisional');
  });

  it('counts a two-target exercise in full toward each target across the week', () => {
    const exercises = [
      exercise({ exerciseId: 'cable-row', targetSets: 11, muscleGroups: ROW }),
      exercise({ exerciseId: 'face-pull', targetSets: 10, muscleGroups: ['upper_back'] }),
    ];

    const warnings = lintWeeklyVolume({ exercises, tier: 'beginner', confidence: CONFIDENT });

    expect(warnings.map((x) => [x.muscleGroup, x.observed])).toEqual([['upper_back', 21]]);
  });
});

describe('meso_length_grew_mid_block', () => {
  it('warns when weeksCount grew after a week was already built', () => {
    const warnings = lintMesoLengthGrewMidBlock({
      previousWeeksCount: 4,
      newWeeksCount: 6,
      weeksAlreadyCreated: 1,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: 'meso_length_grew_mid_block',
      observed: 6,
      ceiling: 4,
    });
  });

  it('says nothing when no week has been built yet', () => {
    const warnings = lintMesoLengthGrewMidBlock({
      previousWeeksCount: 4,
      newWeeksCount: 6,
      weeksAlreadyCreated: 0,
    });

    expect(warnings).toEqual([]);
  });

  it('says nothing when weeksCount did not increase', () => {
    const warnings = lintMesoLengthGrewMidBlock({
      previousWeeksCount: 6,
      newWeeksCount: 4,
      weeksAlreadyCreated: 2,
    });

    expect(warnings).toEqual([]);
  });
});

describe('priority_muscle_changed_mid_block', () => {
  it('warns when the top-set muscle differs between week 1 and a later week', () => {
    const warnings = lintPriorityMuscleChangedMidBlock({
      week1Exercises: [exercise({ muscleGroups: ['chest'], targetSets: 10 })],
      laterWeekExercises: [exercise({ muscleGroups: ['lats'], targetSets: 10 })],
      laterWeekOrderIndex: 2,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: 'priority_muscle_changed_mid_block',
      muscleGroup: 'lats',
    });
    expect(warnings[0].message).toContain('Week 1');
    expect(warnings[0].message).toContain('week 3');
  });

  it('says nothing when the priority muscle is unchanged', () => {
    const warnings = lintPriorityMuscleChangedMidBlock({
      week1Exercises: [exercise({ muscleGroups: ['chest'], targetSets: 10 })],
      laterWeekExercises: [exercise({ muscleGroups: ['chest'], targetSets: 6 })],
      laterWeekOrderIndex: 1,
    });

    expect(warnings).toEqual([]);
  });

  it('says nothing when either week has a tie for the top muscle', () => {
    const warnings = lintPriorityMuscleChangedMidBlock({
      week1Exercises: [
        exercise({ muscleGroups: ['chest'], targetSets: 5 }),
        exercise({ muscleGroups: ['lats'], targetSets: 5 }),
      ],
      laterWeekExercises: [exercise({ muscleGroups: ['lats'], targetSets: 10 })],
      laterWeekOrderIndex: 1,
    });

    expect(warnings).toEqual([]);
  });

  it('warns when an all-rows week 1 gives way to an all-press week', () => {
    const warnings = lintPriorityMuscleChangedMidBlock({
      week1Exercises: [exercise({ muscleGroups: ROW, targetSets: 10 })],
      laterWeekExercises: [exercise({ muscleGroups: PRESS, targetSets: 10 })],
      laterWeekOrderIndex: 1,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('lats and upper back');
    expect(warnings[0].message).toContain('chest and front delts and triceps');
  });

  it('says nothing when an all-rows week 1 meets another all-rows week', () => {
    const warnings = lintPriorityMuscleChangedMidBlock({
      week1Exercises: [exercise({ muscleGroups: ROW, targetSets: 10 })],
      laterWeekExercises: [exercise({ muscleGroups: ROW, targetSets: 6 })],
      laterWeekOrderIndex: 1,
    });

    expect(warnings).toEqual([]);
  });

  it('says nothing when the tied tops of the two weeks share one muscle', () => {
    const warnings = lintPriorityMuscleChangedMidBlock({
      week1Exercises: [exercise({ muscleGroups: ROW, targetSets: 10 })],
      laterWeekExercises: [
        exercise({ muscleGroups: ['upper_back'], targetSets: 6 }),
        exercise({ muscleGroups: ['lats'], targetSets: 3 }),
      ],
      laterWeekOrderIndex: 1,
    });

    expect(warnings).toEqual([]);
  });
});

describe('same_muscle_high_volume_consecutive_days', () => {
  it('counts a two-target exercise toward each target on consecutive days', () => {
    const warnings = lintSameMuscleHighVolumeConsecutiveDays({
      templates: [
        { dayLabel: 'Mon', exercises: [exercise({ muscleGroups: ROW, targetSets: 9 })] },
        { dayLabel: 'Tue', exercises: [exercise({ muscleGroups: ROW, targetSets: 9 })] },
      ],
      tier: 'beginner',
      confidence: CONFIDENT,
    });

    expect(warnings.map((x) => [x.muscleGroup, x.observed])).toEqual([
      ['lats', 9],
      ['upper_back', 9],
    ]);
  });

  it('warns when the same muscle is over the session ceiling on two consecutive templates', () => {
    const warnings = lintSameMuscleHighVolumeConsecutiveDays({
      templates: [
        { dayLabel: 'Mon', exercises: [exercise({ muscleGroups: ['chest'], targetSets: 9 })] },
        { dayLabel: 'Tue', exercises: [exercise({ muscleGroups: ['chest'], targetSets: 9 })] },
      ],
      tier: 'beginner',
      confidence: CONFIDENT,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: 'same_muscle_high_volume_consecutive_days',
      muscleGroup: 'chest',
      observed: 9,
      ceiling: 8,
      tier: 'beginner',
    });
    expect(warnings[0].message).toContain('Mon');
    expect(warnings[0].message).toContain('Tue');
  });

  it('says nothing when only one of the two consecutive templates is over ceiling', () => {
    const warnings = lintSameMuscleHighVolumeConsecutiveDays({
      templates: [
        { dayLabel: 'Mon', exercises: [exercise({ muscleGroups: ['chest'], targetSets: 9 })] },
        { dayLabel: 'Tue', exercises: [exercise({ muscleGroups: ['chest'], targetSets: 3 })] },
      ],
      tier: 'beginner',
      confidence: CONFIDENT,
    });

    expect(warnings).toEqual([]);
  });

  it('says nothing for non-consecutive templates separated by a day with no overlap check', () => {
    const warnings = lintSameMuscleHighVolumeConsecutiveDays({
      templates: [
        { dayLabel: 'Mon', exercises: [exercise({ muscleGroups: ['chest'], targetSets: 9 })] },
        { dayLabel: 'Tue', exercises: [exercise({ muscleGroups: ['lats'], targetSets: 9 })] },
        { dayLabel: 'Wed', exercises: [exercise({ muscleGroups: ['chest'], targetSets: 9 })] },
      ],
      tier: 'beginner',
      confidence: CONFIDENT,
    });

    expect(warnings).toEqual([]);
  });

  it('skips a pair where one template has no dayLabel', () => {
    const warnings = lintSameMuscleHighVolumeConsecutiveDays({
      templates: [
        { exercises: [exercise({ muscleGroups: ['chest'], targetSets: 9 })] },
        { dayLabel: 'Tue', exercises: [exercise({ muscleGroups: ['chest'], targetSets: 9 })] },
      ],
      tier: 'beginner',
      confidence: CONFIDENT,
    });

    expect(warnings).toEqual([]);
  });

  it('never warns at the advanced tier, which has no per-session ceiling', () => {
    const warnings = lintSameMuscleHighVolumeConsecutiveDays({
      templates: [
        { dayLabel: 'Mon', exercises: [exercise({ muscleGroups: ['chest'], targetSets: 20 })] },
        { dayLabel: 'Tue', exercises: [exercise({ muscleGroups: ['chest'], targetSets: 20 })] },
      ],
      tier: 'advanced',
      confidence: CONFIDENT,
    });

    expect(warnings).toEqual([]);
  });
});

describe('lintWeekWithoutOffDay (VW-619 rung 1)', () => {
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  it('warns when the templates fill all seven days', () => {
    const warnings = lintWeekWithoutOffDay(WEEKDAYS.map((dayLabel) => ({ dayLabel })));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: 'week_without_off_day', observed: 7, ceiling: 6 });
  });

  it('stays quiet for a six-day week, even with two sessions on one day', () => {
    const days = [...WEEKDAYS.slice(0, 6), 'mon '].map((dayLabel) => ({ dayLabel }));

    expect(lintWeekWithoutOffDay(days)).toEqual([]);
  });

  it('counts each unlabelled template as a day of its own', () => {
    expect(lintWeekWithoutOffDay(Array.from({ length: 7 }, () => ({})))).toHaveLength(1);
  });
});
