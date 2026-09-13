import { describe, expect, it } from 'vitest';

import { chooseSideComparisonMetric } from '../side-comparison.js';

describe('chooseSideComparisonMetric', () => {
  it('prefers peak force over mean velocity when both are available', () => {
    const choice = chooseSideComparisonMetric({ peakForce: true, meanVelocity: true });
    expect(choice.metric).toBe('peak_force');
    expect(choice.reason).toContain('bilateral reliability');
    expect(choice.reliabilityBasis).toContain('Bishop et al. 2021');
  });

  it('falls back to mean velocity when peak force is unavailable', () => {
    const choice = chooseSideComparisonMetric({ peakForce: false, meanVelocity: true });
    expect(choice.metric).toBe('mean_velocity');
    expect(choice.reason).toContain('not recorded on both sides');
  });

  it('falls back to top weight when neither peak force nor velocity is available', () => {
    const choice = chooseSideComparisonMetric({ peakForce: false, meanVelocity: false });
    expect(choice.metric).toBe('top_weight');
    expect(choice.reason).toContain('top weight');
  });
});
