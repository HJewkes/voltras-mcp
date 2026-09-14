// B23 (VMCP-06.09) arithmetic tests, moved beside `computePercentIncrement`
// from `src/tools/__tests__/plan-progression-gates.test.ts` (VW-362). These
// exercise the rounding/floor/cap arithmetic in isolation with illustrative
// percents — not a stand-in for a real cited value (see the module header).

import { describe, expect, it } from 'vitest';

import { computePercentIncrement } from '../percent-increment.js';

describe('computePercentIncrement — B23 arithmetic', () => {
  it('rounds a percent-of-load increment down to the device step', () => {
    // Arrange/Act: 200 lb top load at an illustrative 12%.
    const delta = computePercentIncrement(200, 12);

    // Assert: 200 * 0.12 = 24, already on the 1 lb device step.
    expect(delta).toBe(24);
  });

  it('floors the increment at the fixed step when the percent rounds below it', () => {
    // Arrange/Act: 20 lb top load at the same illustrative 12% -> 2.4 lb.
    const delta = computePercentIncrement(20, 12);

    // Assert: floored to the fixed +5 lb step.
    expect(delta).toBe(5);
  });

  it('caps the increment when a cap is supplied', () => {
    const delta = computePercentIncrement(500, 12, 5, 10);
    expect(delta).toBe(10);
  });
});
