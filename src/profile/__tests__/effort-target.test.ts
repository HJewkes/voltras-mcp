// The shared per-tier effort table (VW-668).

import { describe, expect, it } from 'vitest';

import { effortTargetFor } from '../effort-target.js';

describe('effortTargetFor', () => {
  it('tells a beginner not to track RIR, with a 1-2 RIR floor', () => {
    const target = effortTargetFor('beginner');
    expect(target.rirTarget).toBeNull();
    expect(target.text).toContain('Do not track RIR');
    expect(target.text).toContain('1-2 RIR');
    expect(target.sources.length).toBeGreaterThan(0);
  });

  it('starts an intermediate around 3 RIR, trending toward 0 before the deload', () => {
    const target = effortTargetFor('intermediate');
    expect(target.rirTarget).toBe(3);
    expect(target.text).toContain('3 RIR in week 1');
    expect(target.sources.length).toBeGreaterThan(0);
  });

  it('holds an advanced lifter at 2-3 RIR', () => {
    const target = effortTargetFor('advanced');
    expect(target.rirTarget).toBe(2);
    expect(target.text).toContain('2-3 RIR');
    expect(target.sources.length).toBeGreaterThan(0);
  });

  it('cites the RIR corpus entries coaching.explain already names', () => {
    expect(effortTargetFor('intermediate').sources).toEqual([
      'rp-s7-rir-self-report-accuracy-by-tier',
      'rp-s4-beginner-rir-floor-progression',
    ]);
  });
});
