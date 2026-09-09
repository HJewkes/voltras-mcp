// Read-side normalisation for `StoredSet.positionUnits` (VW-203).
//
// The sibling of `velocity-units.ts`, for the same reason and with the same
// shape. The store keeps every row in the scale it was captured at, so rows
// written before WA 2.0.0 (VMCP-05.19) hold device-native positions while rows
// written since hold metres. WITHIN one set that cancels — every ratio in
// `analytics/rom-integrity.ts` is scale-free — but ACROSS sets it does not: one
// row of each kind makes an unchanged ROM read as a ~100,000% change. The
// correction happens HERE, on read, for every consumer that compares an
// ABSOLUTE ROM between sets.
//
// The mm→m factor is NOT restated here. `state/live-signal.ts`'s `mmToM` is the
// bridge's own conversion, so a normalised historical row carries the exact
// number the same capture would be written with today, down to the rounding.

import type { Phase, WorkoutSample } from '@voltras/workout-analytics';

import { mmToM } from '../state/live-signal.js';
import { CURRENT_POSITION_UNITS } from '../state/set-capture.js';
import type { StoredRep, StoredRepVbt, StoredSet } from './types.js';

/**
 * Return `set` with every absolute position on its reps expressed in metres.
 *
 * Returns the input UNCHANGED (same object identity) unless the set is
 * explicitly marked `'device_native'`. An absent marker reads as
 * {@link CURRENT_POSITION_UNITS}, which is the store's own default: the v6→v7
 * migration stamps `'device_native'` onto every row that predates the column,
 * and `set.end` has written the current value ever since, so the only sets
 * without a marker never round-tripped through SQLite. Guessing
 * `'device_native'` there would divide a correct value by 1000.
 *
 * The device reports cable travel in millimetres — `@voltras/node-sdk` names
 * that scale on the surfaces that expose a travel quantity in its own units
 * (`PlannedRepProfile.romMm`, "Range of motion in mm"; the `mmPerSec`
 * isokinetic speed parameters over the same cable). `TelemetryFrame.position`
 * is the raw form of it.
 *
 * `startPosition` / `endPosition` are scaled alongside the samples rather than
 * rebuilt from them, because `getPhaseRangeOfMotion` reads exactly those two
 * fields and a stored rep may legitimately carry a phase summary with no sample
 * stream.
 *
 * `derived.rom_m` IS scaled, unlike the velocity normaliser's deliberate skip
 * of the same block. The derivation boundary (VMCP-02.64, #134) shipped BEFORE
 * the bridge's position conversion (VMCP-05.19, #225), so on a device-native
 * row that field holds millimetres despite its name. Every other member of the
 * block is a velocity, a force or a time.
 */
export function normalisePositionsToMetres(set: StoredSet): StoredSet {
  if (set.positionUnits !== 'device_native') return set;
  return { ...set, positionUnits: CURRENT_POSITION_UNITS, reps: set.reps.map(scaleRep) };
}

function scaleRep(rep: StoredRep): StoredRep {
  return {
    ...rep,
    concentric: scalePhase(rep.concentric),
    eccentric: scalePhase(rep.eccentric),
    ...(rep.derived !== undefined ? { derived: scaleDerived(rep.derived) } : {}),
  };
}

function scalePhase(phase: Phase): Phase {
  return {
    ...phase,
    samples: phase.samples.map((s: WorkoutSample) => ({ ...s, position: mmToM(s.position) })),
    startPosition: mmToM(phase.startPosition),
    endPosition: mmToM(phase.endPosition),
  };
}

function scaleDerived(derived: StoredRepVbt): StoredRepVbt {
  return { ...derived, rom_m: derived.rom_m === null ? null : mmToM(derived.rom_m) };
}
