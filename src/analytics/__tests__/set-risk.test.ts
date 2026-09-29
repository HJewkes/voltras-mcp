// The set-risk scorer (VW-152 S1), pinned against the plan's worked examples with test-only load edges.

import { describe, expect, it } from 'vitest';

import { scoreSetRisk, type ExerciseRiskClass, type SetRiskInputs } from '../set-risk.js';
import {
  DEFAULT_SET_RISK_THRESHOLDS,
  SET_RISK_POLICY,
  type SetRiskThresholds,
} from '../set-risk-constants.js';

const TEST_THRESHOLDS: SetRiskThresholds = {
  ...DEFAULT_SET_RISK_THRESHOLDS,
  loadModerateLbs: 40,
  loadHighLbs: 100,
};

function inputs(overrides: Partial<SetRiskInputs> = {}): SetRiskInputs {
  return {
    exerciseClass: 'isolation',
    relativeIntensity: 0.6,
    loadLbs: 25,
    setIndexInExercise: 1,
    priorSetDecayed: false,
    resistanceFamily: 'constant',
    guestLifter: false,
    ...overrides,
  };
}

describe('scoreSetRisk on the owner examples', () => {
  it('permits a first curl set at 60 percent', () => {
    const reading = scoreSetRisk(inputs(), TEST_THRESHOLDS);

    expect(reading).toEqual({
      band: 'green',
      points: 0,
      factors: { exercise: 0, intensity: 0, load: 0, fatigue: 0 },
      vetoes: [],
      permitsIntraSet: true,
    });
  });

  it('reads a chest press at 90 percent as amber and denies', () => {
    const chestPress = inputs({
      exerciseClass: 'supported_compound',
      relativeIntensity: 0.9,
      loadLbs: 80,
    });

    const reading = scoreSetRisk(chestPress, TEST_THRESHOLDS);

    expect(reading.band).toBe('amber');
    expect(reading.points).toBe(4);
    expect(reading.permitsIntraSet).toBe(false);
  });

  it('vetoes a squat at 90 percent as a heavy loaded compound', () => {
    const squat = inputs({ exerciseClass: 'loaded_compound', relativeIntensity: 0.9, loadLbs: 30 });

    const reading = scoreSetRisk(squat, TEST_THRESHOLDS);

    expect(reading.vetoes).toEqual(['heavy_loaded_compound']);
    expect(reading.band).toBe('red');
    expect(reading.permitsIntraSet).toBe(false);
  });

  it('scores a fifth row set at or above the first at equal inputs', () => {
    const row = {
      exerciseClass: 'supported_compound',
      relativeIntensity: 0.65,
      loadLbs: 60,
    } as const;

    const first = scoreSetRisk(inputs({ ...row, setIndexInExercise: 1 }), TEST_THRESHOLDS);
    const fifth = scoreSetRisk(inputs({ ...row, setIndexInExercise: 5 }), TEST_THRESHOLDS);

    expect(first).toMatchObject({ points: 2, band: 'green' });
    expect(fifth).toMatchObject({ points: 3, band: 'amber' });
    expect(fifth.points).toBeGreaterThanOrEqual(first.points);
  });
});

describe('scoreSetRisk fail-safe rule', () => {
  const nullCases: [string, Partial<SetRiskInputs>][] = [
    ['exercise class', { exerciseClass: null }],
    ['relative intensity', { relativeIntensity: null }],
    ['load', { loadLbs: null }],
    ['set index', { setIndexInExercise: null }],
    ['prior-set decay after set 1', { setIndexInExercise: 2, priorSetDecayed: null }],
    ['resistance family', { resistanceFamily: null }],
  ];

  it.each(nullCases)('denies with missing_signal when the %s is unknown', (_name, override) => {
    const reading = scoreSetRisk(inputs(override), TEST_THRESHOLDS);

    expect(reading.vetoes).toContain('missing_signal');
    expect(reading.band).toBe('red');
    expect(reading.permitsIntraSet).toBe(false);
  });

  it('treats an unknown prior-set decay on set 1 as not decayed', () => {
    const reading = scoreSetRisk(inputs({ priorSetDecayed: null }), TEST_THRESHOLDS);

    expect(reading.factors.fatigue).toBe(0);
    expect(reading.permitsIntraSet).toBe(true);
  });

  it('denies a non-constant resistance mode', () => {
    const reading = scoreSetRisk(inputs({ resistanceFamily: 'other' }), TEST_THRESHOLDS);

    expect(reading.vetoes).toEqual(['non_constant_mode']);
    expect(reading.permitsIntraSet).toBe(false);
  });

  it('denies a guest lifter', () => {
    const reading = scoreSetRisk(inputs({ guestLifter: true }), TEST_THRESHOLDS);

    expect(reading.vetoes).toEqual(['guest_lifter']);
    expect(reading.permitsIntraSet).toBe(false);
  });

  it('reads the load factor at its strictest while the owner has set no load edges', () => {
    const reading = scoreSetRisk(inputs({ loadLbs: 5 }), DEFAULT_SET_RISK_THRESHOLDS);

    expect(reading.factors.load).toBe(2);
    expect(reading.points).toBe(2);
  });
});

describe('scoreSetRisk fatigue factor', () => {
  it('adds a level for a decayed prior set and caps at two', () => {
    const early = scoreSetRisk(
      inputs({ setIndexInExercise: 2, priorSetDecayed: true }),
      TEST_THRESHOLDS,
    );
    const late = scoreSetRisk(
      inputs({ setIndexInExercise: 6, priorSetDecayed: true }),
      TEST_THRESHOLDS,
    );

    expect(early.factors.fatigue).toBe(1);
    expect(late.factors.fatigue).toBe(2);
  });
});

describe('scoreSetRisk monotonicity over a generated table', () => {
  const classes: ExerciseRiskClass[] = ['isolation', 'supported_compound', 'loaded_compound'];
  const intensities = [0.4, 0.7, 0.8, 0.85, 1.1];
  const loads = [10, 40, 70, 100, 150];
  const setIndexes = [1, 2, 3, 4, 6];
  const decays = [false, true];

  type Raise = (base: SetRiskInputs) => SetRiskInputs | null;
  const next = <T>(list: readonly T[], value: T): T | undefined => list[list.indexOf(value) + 1];
  const raises: Record<string, Raise> = {
    exerciseClass: (b) => {
      const up = next(classes, b.exerciseClass as ExerciseRiskClass);
      return up === undefined ? null : { ...b, exerciseClass: up };
    },
    relativeIntensity: (b) => {
      const up = next(intensities, b.relativeIntensity as number);
      return up === undefined ? null : { ...b, relativeIntensity: up };
    },
    loadLbs: (b) => {
      const up = next(loads, b.loadLbs as number);
      return up === undefined ? null : { ...b, loadLbs: up };
    },
    setIndexInExercise: (b) => {
      const up = next(setIndexes, b.setIndexInExercise as number);
      return up === undefined ? null : { ...b, setIndexInExercise: up };
    },
    priorSetDecayed: (b) => (b.priorSetDecayed ? null : { ...b, priorSetDecayed: true }),
  };

  const bases: SetRiskInputs[] = classes.flatMap((exerciseClass) =>
    intensities.flatMap((relativeIntensity) =>
      loads.flatMap((loadLbs) =>
        setIndexes.flatMap((setIndexInExercise) =>
          decays.map((priorSetDecayed) =>
            inputs({
              exerciseClass,
              relativeIntensity,
              loadLbs,
              setIndexInExercise,
              priorSetDecayed,
            }),
          ),
        ),
      ),
    ),
  );

  it.each(Object.entries(raises))('never lowers points when %s rises', (_name, raise) => {
    const lowered = bases.flatMap((base) => {
      const raised = raise(base);
      if (raised === null) return [];
      const before = scoreSetRisk(base, TEST_THRESHOLDS).points;
      const after = scoreSetRisk(raised, TEST_THRESHOLDS).points;
      return after < before ? [{ base, raised, before, after }] : [];
    });

    expect(bases.length).toBe(750);
    expect(lowered).toEqual([]);
  });
});

describe('set-risk constants', () => {
  it('labels every threshold as a placeholder pending the owner', () => {
    const statuses = Object.values(SET_RISK_POLICY).map((constant) => constant.status);

    expect(statuses).toHaveLength(Object.keys(DEFAULT_SET_RISK_THRESHOLDS).length);
    expect(new Set(statuses)).toEqual(new Set(['PLACEHOLDER']));
  });
});
