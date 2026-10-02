// Per-muscle weekly frequency bands and the plan lint over them (VW-623, B28).

import { describe, expect, it } from 'vitest';

import type { Tier } from '../../tools/tier-signal.js';
import {
  lintMuscleFrequency,
  plannedWeeklyFrequency,
  trainingDaysOf,
  weeklyFrequency,
  type FrequencyTemplate,
} from '../muscle-frequency.js';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** A week training `muscle` on `days` separate weekdays, one exercise a day. */
function weekTraining(muscle: string, days: number): FrequencyTemplate[] {
  return WEEKDAYS.slice(0, days).map((dayLabel) => ({
    dayLabel,
    exercises: [{ muscleGroups: [muscle] }],
  }));
}

/** A six-day week training `muscle` on `days` of them and only `filler` on the rest. */
function sixDayWeek(muscle: string, days: number, filler = 'obliques'): FrequencyTemplate[] {
  return WEEKDAYS.slice(0, Math.max(days, 6)).map((dayLabel, i) => ({
    dayLabel,
    exercises: [{ muscleGroups: [i < days ? muscle : filler] }],
  }));
}

/** The warnings for `muscle` alone, in a week with room for every band's low end. */
function lint(muscle: string, days: number, tier: Tier = 'intermediate') {
  return lintMuscleFrequency({
    templates: sixDayWeek(muscle, days),
    tier,
    confidence: 'confident',
  }).filter((w) => w.muscleGroup === muscle);
}

describe('beginner band: every muscle 2-4 days, whole body', () => {
  it.each(['quads', 'chest', 'biceps', 'abs'])('warns below the band at 1 day for %s', (muscle) => {
    expect(lint(muscle, 1, 'beginner')).toMatchObject([
      { code: 'muscle_frequency_below_band', muscleGroup: muscle, observed: 1, floor: 2 },
    ]);
  });

  it.each([2, 3, 4])('stays quiet at %i days', (days) => {
    expect(lint('quads', days, 'beginner')).toEqual([]);
  });

  it('warns above the band at 5 days', () => {
    expect(lint('biceps', 5, 'beginner')).toMatchObject([
      { code: 'muscle_frequency_above_band', observed: 5, ceiling: 4, tier: 'beginner' },
    ]);
  });
});

describe('non-beginner legs: about 2 days', () => {
  it.each(['quads', 'hamstrings', 'glutes'])('warns at 1 day and at 3 days for %s', (muscle) => {
    expect(lint(muscle, 1)).toMatchObject([{ code: 'muscle_frequency_below_band', floor: 2 }]);
    expect(lint(muscle, 3)).toMatchObject([{ code: 'muscle_frequency_above_band', ceiling: 2 }]);
  });

  it('stays quiet at 2 days', () => {
    expect(lint('hamstrings', 2)).toEqual([]);
  });
});

describe('non-beginner back, pecs and triceps: 2-3 days', () => {
  it.each(['lats', 'upper_back', 'chest', 'triceps'])('holds 2-3 days for %s', (muscle) => {
    expect(lint(muscle, 1)).toMatchObject([{ code: 'muscle_frequency_below_band', floor: 2 }]);
    expect(lint(muscle, 2)).toEqual([]);
    expect(lint(muscle, 3)).toEqual([]);
    expect(lint(muscle, 4)).toMatchObject([{ code: 'muscle_frequency_above_band', ceiling: 3 }]);
  });
});

describe('non-beginner arms, side delts and calves: 3-5 days', () => {
  it.each(['biceps', 'forearms', 'side_delts', 'calves'])('holds 3-5 days for %s', (muscle) => {
    expect(lint(muscle, 2)).toMatchObject([{ code: 'muscle_frequency_below_band', floor: 3 }]);
    expect(lint(muscle, 3)).toEqual([]);
    expect(lint(muscle, 5)).toEqual([]);
    expect(lint(muscle, 6)).toMatchObject([{ code: 'muscle_frequency_above_band', ceiling: 5 }]);
  });

  it('reads 1 day as below the band', () => {
    expect(lint('calves', 1, 'advanced')).toMatchObject([{ observed: 1, floor: 3 }]);
  });
});

describe('a week with fewer days than the band', () => {
  it('does not read a muscle as below a band the week has too few days to reach', () => {
    const oneDay = lintMuscleFrequency({
      templates: weekTraining('biceps', 1),
      tier: 'intermediate',
      confidence: 'confident',
    });
    const twoDaysChestOnOne: FrequencyTemplate[] = [
      { dayLabel: 'Mon', exercises: [{ muscleGroups: ['chest'] }] },
      { dayLabel: 'Thu', exercises: [{ muscleGroups: ['quads'] }] },
    ];

    expect(oneDay).toEqual([]);
    expect(
      lintMuscleFrequency({
        templates: twoDaysChestOnOne,
        tier: 'advanced',
        confidence: 'confident',
      }),
    ).toMatchObject([
      { code: 'muscle_frequency_below_band', muscleGroup: 'chest' },
      { code: 'muscle_frequency_below_band', muscleGroup: 'quads' },
    ]);
  });
});

describe('the lint copy and its scope', () => {
  it('leaves a muscle with no stated band alone past beginner', () => {
    expect(lint('front_delts', 6)).toEqual([]);
    expect(lint('abs', 1, 'advanced')).toEqual([]);
  });

  it('says the band is a planning prior and cites its sources, at every tier', () => {
    for (const tier of ['beginner', 'intermediate', 'advanced'] as const) {
      const [warning] = lint('chest', 6, tier);
      expect(warning?.message).toContain('planning prior');
      expect(warning?.message).toContain('rp-s6-muscle-recovery-tier-frequency');
    }
  });

  it('names the intermediate reading of an advanced band as a default', () => {
    expect(lint('chest', 1)[0]?.message).toContain('applied to an intermediate as a default');
  });

  it('adds the provisional suffix when the tier is provisional', () => {
    const [warning] = lintMuscleFrequency({
      templates: sixDayWeek('chest', 1),
      tier: 'beginner',
      confidence: 'provisional',
    });
    expect(warning?.message).toContain('tier is provisional');
  });
});

describe('counting training days', () => {
  it('counts weekdays, not templates, and skips a rest template', () => {
    const templates = [
      { dayLabel: 'Mon AM' },
      { dayLabel: 'Mon PM' },
      { dayLabel: 'Wed' },
      { dayLabel: 'Fri', name: 'Rest' },
    ];

    expect(trainingDaysOf(templates)).toBe(2);
  });

  it('counts two sessions on one weekday as one day, and a rest template as none', () => {
    const templates: FrequencyTemplate[] = [
      { dayLabel: 'Mon AM', exercises: [{ muscleGroups: ['chest'] }] },
      { dayLabel: 'Monday PM', exercises: [{ muscleGroups: ['chest'] }] },
      { dayLabel: 'Wed', name: 'Rest', exercises: [{ muscleGroups: ['chest'] }] },
      { dayLabel: 'Thu', exercises: [{ muscleGroups: ['chest', 'triceps'] }] },
    ];

    const frequency = plannedWeeklyFrequency(templates);

    expect(frequency.get('chest')).toBe(2);
    expect(frequency.get('triceps')).toBe(1);
  });

  it('counts only target credit, never a day a muscle was hit as a secondary', () => {
    const day = [
      [
        { muscle: 'chest' as const, weight: 1 as const, target: true },
        { muscle: 'triceps' as const, weight: 0.5 as const, target: false },
      ],
    ];

    const frequency = weeklyFrequency([day, day]);

    expect(frequency.get('chest')).toBe(2);
    expect(frequency.has('triceps')).toBe(false);
  });
});
