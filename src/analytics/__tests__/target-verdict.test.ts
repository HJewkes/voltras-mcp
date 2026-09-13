// Unit tests for the shared missed-target rule (VW-262): `report.session_results`'
// "missed: X of Y" line and the wall's per-set verdict both derive from this module,
// so these tests cover the rule itself rather than either caller.

import { describe, expect, it } from 'vitest';
import { countMissed, targetVerdict } from '../target-verdict.js';

describe('targetVerdict', () => {
  it('is a hit at or above the rep floor', () => {
    expect(targetVerdict(8, 8)).toBe('hit');
    expect(targetVerdict(12, 8)).toBe('hit');
  });

  it('is a miss below the rep floor', () => {
    expect(targetVerdict(6, 8)).toBe('miss');
  });

  it('is no-target when no rep floor was set', () => {
    expect(targetVerdict(6, undefined)).toBe('no-target');
  });
});

describe('countMissed', () => {
  it('counts entries below the floor', () => {
    expect(countMissed([12, 9, 6], 8)).toBe(1);
  });

  it('returns undefined (not 0) when no floor was set', () => {
    expect(countMissed([12, 9, 6], undefined)).toBeUndefined();
  });

  it('returns 0 when every entry cleared the floor', () => {
    expect(countMissed([12, 9], 8)).toBe(0);
  });
});
