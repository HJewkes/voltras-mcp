// Unit tests for src/analytics/rir-velocity.ts (VW-298).
//
// What matters here is the judgement, not the arithmetic: which sets qualify,
// which minimum stops a fit, and whether a known curve comes back out of the
// regression that went in.

import { describe, expect, it } from 'vitest';

import {
  fitRirVelocityModel,
  velocityForRir,
  RIR_VELOCITY_MINIMUMS,
  type RirVelocityObservation,
} from '../rir-velocity.js';

/** A synthetic set on a known line, so the fit has a right answer to find. */
function setOnCurve(
  id: string,
  sessionId: string,
  options: {
    intercept: number;
    slope: number;
    reps: number;
    relativeIntensity?: number;
    /** Alternating +/- offset in m/s, so the points are not perfectly collinear. */
    noise?: number;
  },
): RirVelocityObservation {
  const { intercept, slope, reps, relativeIntensity = 0.8, noise = 0 } = options;
  return {
    setId: id,
    sessionId,
    performedAt: `2026-09-0${sessionId.slice(-1)}T10:00:00.000Z`,
    relativeIntensity,
    anchorSource: 'failure',
    points: Array.from({ length: reps }, (_, i) => {
      const rir = reps - 1 - i;
      return { rir, velocityMps: intercept + slope * rir + (i % 2 === 0 ? noise : -noise) };
    }),
  };
}

/** Three sessions of six-rep sets to failure on one line. */
function corpus(intercept: number, slope: number, noise = 0): RirVelocityObservation[] {
  return ['s1', 's2', 's3'].map((session, i) =>
    setOnCurve(`set-${String(i)}`, session, { intercept, slope, reps: 6, noise }),
  );
}

describe('fitRirVelocityModel', () => {
  it('reproduces a known synthetic curve within tolerance', () => {
    // Arrange: velocity 0.20 m/s at failure, rising 0.05 m/s per rep in reserve.
    const observations = corpus(0.2, 0.05, 0.01);

    // Act
    const fit = fitRirVelocityModel(observations);

    // Assert
    expect(fit.model).not.toBeNull();
    expect(fit.model?.interceptMps).toBeCloseTo(0.2, 2);
    expect(fit.model?.slopeMpsPerRir).toBeCloseTo(0.05, 2);
    expect(fit.model?.form).toBe('linear');
    expect(fit.model?.r2).toBeGreaterThan(0.95);
  });

  it('reports its error in reps in reserve, the unit the source paper uses', () => {
    // Arrange
    const fit = fitRirVelocityModel(corpus(0.2, 0.05, 0.01));

    // Assert: 0.01 m/s of scatter over a 0.05 m/s-per-rep slope is well under
    // the sub-2-rep figure Jukic 2024 reports for individual models.
    expect(fit.model?.rirErrorReps).toBeLessThan(2);
  });

  it('gives two lifters with different curves different targets for the same RIR', () => {
    // Arrange: one lifter grinds slowly, the other moves fast and decays hard.
    const slow = fitRirVelocityModel(corpus(0.15, 0.03));
    const fast = fitRirVelocityModel(corpus(0.35, 0.09));
    if (slow.model === null || fast.model === null) throw new Error('both corpora should fit');

    // Act
    const slowTarget = velocityForRir(slow.model, 2);
    const fastTarget = velocityForRir(fast.model, 2);

    // Assert
    expect(slowTarget.velocityMps).toBeCloseTo(0.21, 2);
    expect(fastTarget.velocityMps).toBeCloseTo(0.53, 2);
    expect(fastTarget.velocityMps).toBeGreaterThan(slowTarget.velocityMps);
  });

  it('excludes sets outside the 70-90% band', () => {
    // Arrange: three qualifying sets, all too light to be in the band.
    const observations = corpus(0.2, 0.05).map((o) => ({ ...o, relativeIntensity: 0.55 }));

    // Act
    const fit = fitRirVelocityModel(observations);

    // Assert
    expect(fit.model).toBeNull();
    expect(fit.qualification.observedSets).toBe(3);
    expect(fit.qualification.qualifyingSets).toBe(0);
    expect(fit.reason).toContain('70-90% band');
  });

  it('refuses a fit from too few sets and names the minimum', () => {
    // Arrange
    const fit = fitRirVelocityModel(corpus(0.2, 0.05).slice(0, 2));

    // Assert
    expect(fit.model).toBeNull();
    expect(fit.reason).toContain(String(RIR_VELOCITY_MINIMUMS.minSets));
  });

  it('refuses a fit whose sets all come from one session', () => {
    // Arrange: three qualifying sets, one bout — correlated evidence.
    const observations = corpus(0.2, 0.05).map((o) => ({ ...o, sessionId: 'one-bout' }));

    // Act
    const fit = fitRirVelocityModel(observations);

    // Assert
    expect(fit.model).toBeNull();
    expect(fit.qualification.qualifyingSessions).toBe(1);
    expect(fit.reason).toContain('sessions');
  });

  it('refuses a fit whose reps in reserve barely vary', () => {
    // Arrange: five sets of three reps each clears the set, session and point
    // floors, but spans only RIR 0-2.
    const observations = ['s1', 's2', 's3', 's4', 's5'].map((session, i) =>
      setOnCurve(`set-${String(i)}`, session, { intercept: 0.2, slope: 0.05, reps: 3 }),
    );

    // Act
    const fit = fitRirVelocityModel(observations);

    // Assert
    expect(fit.model).toBeNull();
    expect(fit.qualification.rirSpread).toBe(2);
    expect(fit.reason).toContain('reps in reserve span');
  });

  it('refuses a fit where velocity does not rise with reps in reserve', () => {
    // Arrange: an inverted curve carries no RIR signal, however tight its fit.
    const fit = fitRirVelocityModel(corpus(0.5, -0.04));

    // Assert
    expect(fit.model).toBeNull();
    expect(fit.reason).toContain('does not rise');
  });

  it('records which anchor backed each qualifying set', () => {
    // Arrange: two measured failures and one self-report.
    const observations = corpus(0.2, 0.05);
    observations[2] = { ...observations[2], anchorSource: 'self_report' };

    // Act
    const fit = fitRirVelocityModel(observations);

    // Assert
    expect(fit.model?.anchorSources).toEqual({ failure: 2, selfReport: 1 });
  });
});

describe('velocityForRir', () => {
  it('flags an answer that extrapolates past the fitted range', () => {
    // Arrange: sets to failure of six reps span RIR 0-5.
    const fit = fitRirVelocityModel(corpus(0.2, 0.05));
    if (fit.model === null) throw new Error('corpus should fit');

    // Act
    const inside = velocityForRir(fit.model, 3);
    const outside = velocityForRir(fit.model, 8);

    // Assert
    expect(inside.withinFittedRange).toBe(true);
    expect(outside.withinFittedRange).toBe(false);
    expect(outside.velocityMps).toBeGreaterThan(inside.velocityMps);
  });
});

describe('the held-out figure on a fitted curve (VW-538)', () => {
  it('reads zero when the newest set sits on the curve the older sets draw', () => {
    // Arrange: four sessions on one line, so three remain once the newest is held out.
    const observations = [
      ...corpus(0.2, 0.05),
      setOnCurve('set-3', 's4', { intercept: 0.2, slope: 0.05, reps: 6 }),
    ];

    // Act
    const fit = fitRirVelocityModel(observations);

    // Assert
    expect(fit.model?.heldOutErrorReps).toBe(0);
  });

  it('measures how far the older sets miss the newest set anchor', () => {
    // Arrange: the newest set fails 0.05 m/s faster, one rep in reserve off the line.
    const observations = [
      ...corpus(0.2, 0.05),
      setOnCurve('set-3', 's4', { intercept: 0.25, slope: 0.05, reps: 6 }),
    ];

    // Act
    const fit = fitRirVelocityModel(observations);

    // Assert
    expect(fit.model?.heldOutErrorReps).toBeCloseTo(1, 2);
  });

  it('is null when the curve without the newest set does not stand', () => {
    expect(fitRirVelocityModel(corpus(0.2, 0.05, 0.01)).model?.heldOutErrorReps).toBeNull();
  });
});
