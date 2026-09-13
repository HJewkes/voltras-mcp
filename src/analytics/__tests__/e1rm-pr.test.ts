// `evaluateE1RMPr` (VW-314) — the shared PR verdict `metrics.compute
// strength.e1rm` and the SPA hero card's `toExerciseIsPR` both compute
// through, so the plumbing tests for each pipeline don't have to re-pin
// `isNewE1RM`'s own contract.

import { describe, expect, it } from 'vitest';
import { evaluateE1RMPr } from '../e1rm-pr.js';

describe('evaluateE1RMPr', () => {
  it('a current estimate above the prior best is a PR, echoing that best', () => {
    expect(evaluateE1RMPr(220, 200)).toEqual({ isPR: true, priorBest: 200 });
  });

  it('a current estimate at or below the prior best is not a PR', () => {
    expect(evaluateE1RMPr(200, 200)).toEqual({ isPR: false, priorBest: 200 });
    expect(evaluateE1RMPr(150, 200)).toEqual({ isPR: false, priorBest: 200 });
  });

  it('no prior session to beat → never a PR, priorBest stays null', () => {
    expect(evaluateE1RMPr(220, null)).toEqual({ isPR: false, priorBest: null });
  });

  it('no current estimate → never a PR, priorBest still reported', () => {
    expect(evaluateE1RMPr(null, 200)).toEqual({ isPR: false, priorBest: 200 });
  });
});
