// Unit tests for the single limb-label seam (VMCP-04.12).
//
// These lock TODAY's behaviour — labels derived from the slot id — so the coming
// snapshot `side` field can be swapped in behind `limbSide` without silently
// changing what the wall renders.

import { describe, expect, it } from 'vitest';

import { findLimbEntry, limbLabel, limbSide, limbSlotBadge } from '../spa/limb.js';

const left = { slotId: 'left', device: { deviceId: 'V-001' } };
const right = { slotId: 'right', device: { deviceId: 'V-002' } };
const primary = { slotId: 'primary', device: { deviceId: 'V-003' } };
const anonymous = { slotId: 'primary', device: {} };

describe('limbSide', () => {
  it('resolves the left/right slots to sides', () => {
    expect(limbSide(left)).toBe('left');
    expect(limbSide(right)).toBe('right');
  });

  it('treats a single-device slot as no side', () => {
    expect(limbSide(primary)).toBeNull();
  });
});

describe('limbLabel', () => {
  it('labels a bound limb by its side', () => {
    expect(limbLabel(left)).toBe('Left');
    expect(limbLabel(right)).toBe('Right');
  });

  it('falls back to the BLE device id when the slot is not a limb', () => {
    expect(limbLabel(primary)).toBe('V-003');
  });

  it('falls back to a bare Voltra when no device id is known', () => {
    expect(limbLabel(anonymous)).toBe('Voltra');
  });
});

describe('limbSlotBadge', () => {
  it('maps sides to titan slot badges, non-limbs to none', () => {
    expect(limbSlotBadge(left)).toBe('L');
    expect(limbSlotBadge(right)).toBe('R');
    expect(limbSlotBadge(primary)).toBeNull();
  });
});

describe('findLimbEntry', () => {
  it('finds the entry bound to a side', () => {
    expect(findLimbEntry([primary, right, left], 'right')).toBe(right);
  });

  it('returns undefined for an unbound limb', () => {
    expect(findLimbEntry([primary], 'left')).toBeUndefined();
  });
});
