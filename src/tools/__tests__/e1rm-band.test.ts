// VW-267: the error band attached to every e1RM this server reports.
//
// What's load-bearing: `fitFor` is 'trend' on every method (that marker is the
// point of the module), the velocity-derived methods carry the pooled figures
// sized to the estimate, the rep method carries nulls rather than a figure
// measured on a different estimator, and the systematic bias is reported but
// never folded into the bounds.

import { describe, expect, it } from 'vitest';

import {
  E1RM_BIAS_PCT,
  E1RM_SEE_PCT,
  e1rmBand,
  withinE1RMBand,
  type E1RMMethod,
} from '../e1rm-band.js';

const ESTIMATE_LBS = 200;

describe('e1rmBand', () => {
  it.each<E1RMMethod>(['profile', 'reps', 'hybrid'])('marks a %s estimate trend-only', (method) => {
    // Arrange / Act.
    const band = e1rmBand(ESTIMATE_LBS, method);

    // Assert.
    expect(band.fitFor).toBe('trend');
    expect(band.method).toBe(method);
    expect(band.citation).toContain('Greig');
  });

  it('sizes the pooled standard error to a velocity-derived estimate', () => {
    // Arrange / Act.
    const band = e1rmBand(ESTIMATE_LBS, 'profile');

    // Assert: 9.8% of 200 lb is 19.6 lb either side.
    expect(band.seePct).toBe(E1RM_SEE_PCT);
    expect(band.seePctCi).toEqual([7.4, 12.2]);
    expect(band.seeLbs).toBe(19.6);
    expect(band.lowLbs).toBe(180.4);
    expect(band.highLbs).toBe(219.6);
  });

  it('reports the systematic overestimate without applying it', () => {
    // Arrange / Act.
    const band = e1rmBand(ESTIMATE_LBS, 'hybrid');

    // Assert: the bounds are symmetric about the estimate, bias excluded.
    expect(band.biasPct).toBe(E1RM_BIAS_PCT);
    expect(band.biasLbs).toBe(7.4);
    expect((band.lowLbs ?? 0) + (band.highLbs ?? 0)).toBe(2 * ESTIMATE_LBS);
  });

  it('leaves every figure null for the rep-based estimate and says why', () => {
    // Arrange / Act.
    const band = e1rmBand(ESTIMATE_LBS, 'reps');

    // Assert.
    expect(band.seePct).toBeNull();
    expect(band.seeLbs).toBeNull();
    expect(band.biasPct).toBeNull();
    expect(band.lowLbs).toBeNull();
    expect(band.highLbs).toBeNull();
    expect(band.note).toContain('Epley');
  });
});

describe('withinE1RMBand', () => {
  it('calls a change smaller than the standard error indistinguishable from noise', () => {
    // Arrange: 200 lb against 215 lb — 7.5%, inside the 9.8% band.
    // Act / Assert.
    expect(withinE1RMBand(200, 215)).toBe(true);
    expect(withinE1RMBand(215, 200)).toBe(true);
  });

  it('calls a change wider than the standard error a real difference', () => {
    // Arrange: 200 lb against 240 lb — 16.7%, outside the band.
    // Act / Assert.
    expect(withinE1RMBand(200, 240)).toBe(false);
  });
});
