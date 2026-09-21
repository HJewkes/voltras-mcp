// Which kind of resistance a set met, as one value (VW-448, VW-538).
//
// Velocity reads as effort differently under each kind. The owner ruled on
// each: constant load supports a fitted RIR-velocity profile; chains and
// eccentric overload are readable as velocity loss within the set, but a
// constant-load profile does not transfer to them; damper shows colours only;
// isokinetic reads nothing from velocity. So a curve fitted on constant-load
// sets must be fed constant-load sets only.
//
// Read from the stored mode name and the stored settings, described by their
// product names. Nothing here reads the device.
//
// PURE.

export type ResistanceFamily =
  | 'constant'
  | 'chains'
  | 'eccentric_overload'
  | 'damper'
  | 'isokinetic';

/** Most readable first. A later family reads less from velocity than an earlier one. */
const READABILITY_ORDER: readonly ResistanceFamily[] = [
  'constant',
  'chains',
  'eccentric_overload',
  'damper',
  'isokinetic',
];

/**
 * The family each stored mode name belongs to. Band and custom-curve modes load
 * every rep along the same curve, as chains do; rowing resists in proportion
 * to speed, as the damper does; an isometric hold has no velocity to read.
 */
const MODE_FAMILIES: ReadonlyMap<string, ResistanceFamily> = new Map([
  ['Weight Training', 'constant'],
  ['Resistance Band', 'chains'],
  ['Custom Curves', 'chains'],
  ['Damper', 'damper'],
  ['Rowing', 'damper'],
  ['Isokinetic', 'isokinetic'],
  ['Isometric', 'isokinetic'],
]);

/** A set as far as its resistance is concerned — live or stored. */
export interface ResistanceBearing {
  trainingMode?: string | undefined;
  chainsLbs?: number | undefined;
  inverseChainsLbs?: number | undefined;
  eccentricPct?: number | undefined;
  damperLevel?: number | undefined;
}

/**
 * The family of resistance a set met. An absent or unrecognised mode is not
 * known to be constant load, so it reads as the least readable family rather
 * than feeding a constant-load curve on a guess.
 */
export function resistanceFamilyOf(set: ResistanceBearing): ResistanceFamily {
  const mode = MODE_FAMILIES.get(set.trainingMode ?? '') ?? 'isokinetic';
  return settingFamilies(set).reduce(lessReadable, mode);
}

function settingFamilies(set: ResistanceBearing): ResistanceFamily[] {
  const out: ResistanceFamily[] = [];
  if (isOn(set.chainsLbs) || isOn(set.inverseChainsLbs)) out.push('chains');
  if (isOn(set.eccentricPct)) out.push('eccentric_overload');
  if (isOn(set.damperLevel)) out.push('damper');
  return out;
}

// Two settings on at once read as the less readable of the two: the designer's inference, not an owner ruling.
function lessReadable(a: ResistanceFamily, b: ResistanceFamily): ResistanceFamily {
  return READABILITY_ORDER.indexOf(a) >= READABILITY_ORDER.indexOf(b) ? a : b;
}

function isOn(value: number | undefined): boolean {
  return value !== undefined && value !== 0;
}
