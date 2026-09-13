// The cable-geometry gate (VW-272): two slots set up differently must not
// produce an asymmetry verdict.

import { describe, it, expect } from 'vitest';

import {
  compareSetupSignatures,
  medianRomMetres,
  SETUP_GEOMETRY_RATIO,
  type SetupSignature,
} from '../setup-comparability.js';
import { SETUP_SPLIT_RATIO } from '../../store/exercise-setups.js';

function left(medianRomM?: number, extra: Partial<SetupSignature> = {}): SetupSignature {
  return { side: 'left', ...(medianRomM !== undefined ? { medianRomM } : {}), ...extra };
}

function right(medianRomM?: number, extra: Partial<SetupSignature> = {}): SetupSignature {
  return { side: 'right', ...(medianRomM !== undefined ? { medianRomM } : {}), ...extra };
}

describe('compareSetupSignatures', () => {
  it('calls two slots at matching travel comparable', () => {
    const verdict = compareSetupSignatures(left(0.42), right(0.4));

    expect(verdict.comparability).toBe('comparable');
    expect(verdict.reason).toContain('0.42 m left vs 0.40 m right');
  });

  it('confounds two slots whose travel is further apart than the split ratio', () => {
    const verdict = compareSetupSignatures(left(0.3), right(0.45));

    expect(verdict.comparability).toBe('setup_confounded');
    expect(verdict.reason).toContain('1.50x apart');
    expect(verdict.reason).toContain('different joint torque');
    expect(verdict.reason).toContain('Keogh, Lake & Swinton 2013');
  });

  it('carries both signatures in the payload whichever way it answers', () => {
    const confounded = compareSetupSignatures(left(0.3, { setupId: 'a' }), right(0.45));

    expect(confounded.left).toEqual({ side: 'left', medianRomM: 0.3, setupId: 'a' });
    expect(confounded.right).toEqual({ side: 'right', medianRomM: 0.45 });
  });

  it('is symmetric: the same pair confounds whichever side travels further', () => {
    expect(compareSetupSignatures(left(0.45), right(0.3)).comparability).toBe('setup_confounded');
    expect(compareSetupSignatures(left(0.3), right(0.45)).comparability).toBe('setup_confounded');
  });

  it('passes a pair sitting exactly on the ratio — the band is the tolerance, not the split', () => {
    const verdict = compareSetupSignatures(left(0.4 * SETUP_GEOMETRY_RATIO), right(0.4));

    expect(verdict.comparability).toBe('comparable');
  });

  it('reports setup_unverified, not a mismatch, when a side records no travel', () => {
    const verdict = compareSetupSignatures(left(), right(0.4));

    expect(verdict.comparability).toBe('setup_unverified');
    expect(verdict.reason).toContain('no cable travel recorded on left');
  });

  it('names both sides when neither recorded travel', () => {
    expect(compareSetupSignatures(left(), right()).reason).toContain(
      'no cable travel recorded on left or right',
    );
  });

  it('shares its tolerance with the setup clustering rather than declaring a second one', () => {
    expect(SETUP_SPLIT_RATIO).toBe(SETUP_GEOMETRY_RATIO);
  });
});

describe('medianRomMetres', () => {
  it('takes the median of the ROMs that carry signal', () => {
    expect(medianRomMetres([0.3, 0.5, 0.4])).toBe(0.4);
  });

  it('averages the middle pair on an even count', () => {
    expect(medianRomMetres([0.3, 0.5])).toBeCloseTo(0.4, 10);
  });

  it('drops non-positive ROMs rather than dragging the signature toward zero', () => {
    expect(medianRomMetres([0, 0.4, 0.4])).toBe(0.4);
  });

  it('is undefined when nothing measurable is left', () => {
    expect(medianRomMetres([0, -1])).toBeUndefined();
    expect(medianRomMetres([])).toBeUndefined();
  });
});
