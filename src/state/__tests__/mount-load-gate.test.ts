// Pure-function tests for the mount-load gate (VW-274).

import { describe, expect, it } from 'vitest';

import { checkMountLoad, ISOMETRIC_MAX_PEAK_LBS_PER_UNIT } from '../mount-load-gate.js';

describe('checkMountLoad', () => {
  it('warns, never refuses, when no rating is configured', () => {
    const result = checkMountLoad(
      undefined,
      ISOMETRIC_MAX_PEAK_LBS_PER_UNIT,
      'isometric max force',
    );
    expect(result.refused).toBe(false);
    expect(result.refusalMessage).toBeUndefined();
    expect(result.warning).toContain('UNKNOWN');
  });

  it('passes silently when the peak is within a configured rating', () => {
    const result = checkMountLoad(500, ISOMETRIC_MAX_PEAK_LBS_PER_UNIT, 'isometric max force');
    expect(result.refused).toBe(false);
    expect(result.refusalMessage).toBeUndefined();
    expect(result.warning).toBeUndefined();
  });

  it('refuses, naming the mode-driven peak, when it exceeds a configured rating', () => {
    const result = checkMountLoad(350, ISOMETRIC_MAX_PEAK_LBS_PER_UNIT, 'isometric max force');
    expect(result.refused).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.refusalMessage).toContain('isometric max force');
    expect(result.refusalMessage).toContain('400');
    expect(result.refusalMessage).toContain('350');
  });

  it('does not refuse at exactly the rating — the rating is the ceiling, not the floor of refusal', () => {
    const result = checkMountLoad(400, ISOMETRIC_MAX_PEAK_LBS_PER_UNIT, 'isometric max force');
    expect(result.refused).toBe(false);
  });
});
