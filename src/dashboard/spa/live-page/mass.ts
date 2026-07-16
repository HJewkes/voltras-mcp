/**
 * DISPLAY-only mass unit conversion for the live page (VW-63).
 *
 * Every weight / force / load in the store, mapper, and WA is LBS and STAYS lbs — the
 * fitness-native-units contract. This module converts a lbs value to the viewer's chosen
 * DISPLAY unit at RENDER time only; nothing here is ever written back to the model, so the
 * toggle can never launder a kg number into a value the store or WA reads.
 *
 * Velocity (m/s), ROM (m), tempo (s), rep counts and velocity-loss % are unit-INVARIANT
 * here and are deliberately NOT routed through this module.
 */

/** The viewer's chosen display unit. Store values are always lbs regardless of this. */
export type MassUnit = 'lbs' | 'kg';

/** Kilograms per pound — the ONE conversion constant. Never inline this literal. */
export const KG_PER_LB = 0.45359237;

/** Convert a lbs value to `unit` (identity when lbs). Unrounded — callers round for display. */
export function convertMass(valueLbs: number, unit: MassUnit): number {
  return unit === 'kg' ? valueLbs * KG_PER_LB : valueLbs;
}

/**
 * A mass readout in the display unit: the rounded display number + its unit label. Feed
 * `value` + `unit` into a titan component that takes a numeric weight/load and a unit label
 * (SetsRepsLoad, SessionRail / ExerciseCard summary, SetRow), or stringify `value` for a
 * free-text Metric. `unit` doubles as the label ('lbs' | 'kg').
 */
export function formatMass(valueLbs: number, unit: MassUnit): { value: number; unit: MassUnit } {
  return { value: Math.round(convertMass(valueLbs, unit)), unit };
}
