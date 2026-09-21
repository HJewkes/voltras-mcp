// How one stored value becomes one JSON value and back again (VW-534).
//
// SQLite has five storage classes and JSON has three that matter here, so the
// two cases JSON cannot carry on its own are tagged instead of coerced:
// an integer past 2^53 would lose its last digits as a JSON number, and a blob
// has no JSON spelling at all. NULL stays null and never becomes '', because
// this store reads the two as different answers in a dozen places.
//
// Integers within 2^53 and reals both write as plain JSON numbers. They are not
// told apart on the way back in, and do not need to be: every numeric column in
// this schema is declared INTEGER or REAL, so the column's affinity restores the
// class on insert. `verify` is what proves it, per table, over real rows.

import { type SQLInputValue } from 'node:sqlite';

export type PortableValue =
  | number
  | string
  | null
  | { int: string }
  | { real: string }
  | { b64: string };

export type StoredValue = SQLInputValue;

/** True when a stored integer is past what a JSON number carries exactly. */
function needsStringForm(v: bigint): boolean {
  return v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER);
}

export function encodeValue(value: unknown, where: string): PortableValue {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint')
    return needsStringForm(value) ? { int: value.toString() } : Number(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : { real: String(value) };
  if (value instanceof Uint8Array) return { b64: Buffer.from(value).toString('base64') };
  throw new Error(`${where}: cannot export a value of type ${typeof value}`);
}

export function decodeValue(value: PortableValue, where: string): StoredValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'object') {
    if ('int' in value) return BigInt(value.int);
    if ('real' in value) return Number(value.real);
    if ('b64' in value) return new Uint8Array(Buffer.from(value.b64, 'base64'));
  }
  throw new Error(`${where}: unrecognised encoded value`);
}

/** True when the encoded form is the tagged big-integer one. */
export function isStringEncodedInteger(value: PortableValue): boolean {
  return typeof value === 'object' && value !== null && 'int' in value;
}
