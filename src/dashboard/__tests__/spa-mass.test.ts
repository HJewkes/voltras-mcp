// Unit tests for the live page's DISPLAY-only mass conversion helper (VW-63).
//
// The helper is the single place lbs → kg happens for the wall dashboard; the store,
// mapper and WA never see the converted value. Pure arithmetic — no DOM, no I/O.

import { describe, expect, it } from 'vitest';

import { KG_PER_LB, convertMass, formatMass } from '../spa/live-page/mass.js';

describe('convertMass', () => {
  it('is the identity when the display unit is lbs', () => {
    expect(convertMass(140, 'lbs')).toBe(140);
    expect(convertMass(0, 'lbs')).toBe(0);
    expect(convertMass(542.5, 'lbs')).toBe(542.5);
  });

  it('scales pounds to kilograms by the canonical factor', () => {
    expect(convertMass(1, 'kg')).toBeCloseTo(KG_PER_LB, 10);
    expect(convertMass(140, 'kg')).toBeCloseTo(63.50293, 4);
    expect(convertMass(542, 'kg')).toBeCloseTo(245.847, 3);
  });
});

describe('formatMass', () => {
  it('leaves a lbs value untouched and labels it lbs', () => {
    expect(formatMass(140, 'lbs')).toEqual({ value: 140, unit: 'lbs' });
    expect(formatMass(542, 'lbs')).toEqual({ value: 542, unit: 'lbs' });
  });

  it('rounds the kilogram value to a whole number and labels it kg', () => {
    // 140 lb → 63.50 kg → 64; 542 lb → 245.85 kg → 246.
    expect(formatMass(140, 'kg')).toEqual({ value: 64, unit: 'kg' });
    expect(formatMass(542, 'kg')).toEqual({ value: 246, unit: 'kg' });
  });

  it('rounds zero to zero in either unit', () => {
    expect(formatMass(0, 'lbs')).toEqual({ value: 0, unit: 'lbs' });
    expect(formatMass(0, 'kg')).toEqual({ value: 0, unit: 'kg' });
  });
});
