// Why a set was performed, as one value (VMCP-02.84).
//
// The store has admitted four purposes since v6 — `sets.set_purpose` CHECKs
// `('working','warmup','probe','technique')` and `is_warmup` is GENERATED from
// it — but the tool surface only ever exposed a boolean. These two helpers are
// the seam: `setPurposeOf` is the single READ of a set's intent, and
// `setPurposeFields` the single WRITE, so `setPurpose` and its derived
// `isWarmup` alias cannot drift in memory the way the DB already guarantees
// they cannot drift on disk.

import type { SetPurpose } from './types.js';

const SET_PURPOSES: readonly string[] = ['working', 'warmup', 'probe', 'technique'];

/**
 * Narrow a value read back from SQLite. `sets.set_purpose` is free text with a
 * CHECK constraint, so a row written by some future schema reads back as
 * unknown rather than as a bogus purpose.
 */
export function isSetPurpose(value: string): value is SetPurpose {
  return SET_PURPOSES.includes(value);
}

/** A set as far as its purpose is concerned — live or stored. */
export interface PurposeBearing {
  setPurpose?: SetPurpose | undefined;
  isWarmup?: boolean | undefined;
}

/**
 * Read a set's purpose. Absent `setPurpose` falls back to the deprecated
 * boolean and then to `'working'`: rows written before this field existed, and
 * fixtures still built with `isWarmup` alone, are working sets unless flagged.
 */
export function setPurposeOf(set: PurposeBearing): SetPurpose {
  if (set.setPurpose !== undefined) return set.setPurpose;
  return set.isWarmup === true ? 'warmup' : 'working';
}

/**
 * The fields to spread onto a live or stored set for a given purpose.
 *
 * `'working'` contributes NOTHING, which keeps every default set's shape — and
 * every snapshot asserted against it — exactly as it was before the enum
 * existed. `isWarmup` rides along on `'warmup'` so the existing readers
 * (channel payloads, the dashboard read-models, `failure-harvest`) keep
 * working unchanged.
 */
export function setPurposeFields(purpose: SetPurpose | undefined): {
  setPurpose?: SetPurpose;
  isWarmup?: true;
} {
  if (purpose === undefined || purpose === 'working') return {};
  if (purpose === 'warmup') return { setPurpose: 'warmup', isWarmup: true };
  return { setPurpose: purpose };
}
