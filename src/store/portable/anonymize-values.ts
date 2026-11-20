// The value rewrites `anonymize` applies, one per column rule (VW-941).
//
// Every rewrite is a pure function of the stored value, its row and a context
// fixed by the seed, so one seed over one export always writes the same files.
// A value of a shape a rule does not expect fails the run naming the column,
// never the value: a message that quoted it would be the leak.

import { createHash, randomBytes } from 'node:crypto';

import { HISTORY_SEED_EXERCISES } from '../../exercises/history-seed-catalog.js';
import { SEED_CABLE_EXERCISES } from '../../exercises/seed-catalog.js';
import { type PortableValue } from './codec.js';

export type Row = Readonly<Record<string, PortableValue>>;

export interface AnonymizeContext {
  readonly salt: string;
  /** Whole weeks every date moves back by, so weekday and local time of day survive. */
  readonly shiftWeeks: number;
  /** 1 unless `--scale` asked for one factor in [0.9, 1.1]. */
  readonly loadFactor: number;
  /** Stand-in numbering per kind, in the order values are first met. */
  readonly numbering: Map<string, Map<string, number>>;
}

export type Rewrite = (
  value: PortableValue,
  row: Row,
  ctx: AnonymizeContext,
  where: string,
) => PortableValue;

const CATALOG_NAMES = new Map(
  [...SEED_CABLE_EXERCISES, ...HISTORY_SEED_EXERCISES].map((e) => [e.id, e.name]),
);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DAY_MS = 86_400_000;
/** Phase times past this are wall-clock milliseconds, not offsets into the rep. */
const EPOCH_MS_FLOOR = 1_000_000_000_000;
const REP_KEYS = new Set([
  'id',
  'setId',
  'index',
  'repNumber',
  'concentric',
  'eccentric',
  'derived',
]);
const PHASE_LOAD_KEYS = new Set(['peakForce', 'peakLoad', '_totalForce', '_totalLoad']);
const PHASE_TIME_KEYS = new Set(['startTime', 'endTime', '_peakVelocityTime']);
const DERIVED_LOAD_KEYS = new Set(['impulse_lb_s', 'mean_power_lb_mps']);

export function makeContext(seed: string | undefined, scale: boolean): AnonymizeContext {
  const root = seed ?? randomBytes(16).toString('hex');
  const draw = (label: string): number =>
    createHash('sha256').update(`${label}:${root}`).digest().readUInt32BE(0) / 2 ** 32;
  return {
    salt: createHash('sha256').update(`salt:${root}`).digest('hex'),
    shiftWeeks: 26 + Math.floor(draw('weeks') * 78),
    loadFactor: scale ? 0.9 + draw('scale') * 0.2 : 1,
    numbering: new Map(),
  };
}

function number(ctx: AnonymizeContext, kind: string, key: string): number {
  const seen = ctx.numbering.get(kind) ?? new Map<string, number>();
  ctx.numbering.set(kind, seen);
  if (!seen.has(key)) seen.set(key, seen.size + 1);
  return seen.get(key) as number;
}

function text(value: PortableValue, where: string): string {
  if (typeof value !== 'string') throw new Error(`anonymize: ${where} is not text`);
  return value;
}

function numeric(value: PortableValue, where: string): number {
  if (typeof value !== 'number') throw new Error(`anonymize: ${where} is not a number`);
  return value;
}

export const keep: Rewrite = (value) => value;
export const strip: Rewrite = () => null;

/** Moves a date or an instant back by whole local-calendar weeks. */
export function shiftTimestamp(value: string, weeks: number, where: string): string {
  const days = -7 * weeks;
  if (DATE_ONLY.test(value)) {
    return new Date(Date.parse(`${value}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
  }
  if (!INSTANT.test(value)) throw new Error(`anonymize: ${where} is not a date or an instant`);
  // Local fields, not milliseconds: a fixed span would move the local hour
  // whenever the shift crosses a daylight-saving change.
  const d = new Date(value);
  const local = [d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()] as const;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, ...local).toISOString();
}

export const time: Rewrite = (value, _row, ctx, where) =>
  value === null ? null : shiftTimestamp(text(value, where), ctx.shiftWeeks, where);

function shiftJson(node: unknown, ctx: AnonymizeContext, where: string): unknown {
  if (typeof node === 'string' && (DATE_ONLY.test(node) || INSTANT.test(node))) {
    return shiftTimestamp(node, ctx.shiftWeeks, where);
  }
  if (Array.isArray(node)) return node.map((n) => shiftJson(n, ctx, where));
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, shiftJson(v, ctx, where)]));
  }
  return node;
}

/** Structured JSON: kept, with any date inside it shifted like a date column. */
export const json: Rewrite = (value, _row, ctx, where) =>
  value === null ? null : JSON.stringify(shiftJson(JSON.parse(text(value, where)), ctx, where));

/** A salted-hash stand-in: stable across tables, so joins survive, and not reversible without the seed. */
export function pseudonym(prefix: string): Rewrite {
  return (value, _row, ctx, where) => {
    if (value === null) return null;
    const digest = createHash('sha256').update(`${ctx.salt}:${prefix}:${text(value, where)}`);
    return `${prefix}-${digest.digest('hex').slice(0, 12)}`;
  };
}

function exerciseStandIn(id: string, ctx: AnonymizeContext): string {
  return CATALOG_NAMES.has(id) ? id : `custom-exercise-${number(ctx, 'exercise', id)}`;
}

/** Catalog ids are public and kept; any other id becomes a numbered stand-in. */
export const exercise: Rewrite = (value, _row, ctx, where) =>
  value === null ? null : exerciseStandIn(text(value, where), ctx);

/** A name follows its row's exercise id: the catalog's own name, or `Custom exercise N`. */
export const exerciseName: Rewrite = (value, row, ctx, where) => {
  if (value === null) return null;
  const id = typeof row.exercise_id === 'string' ? row.exercise_id : `name:${text(value, where)}`;
  return CATALOG_NAMES.get(id) ?? `Custom exercise ${number(ctx, 'exercise', id)}`;
};

/** `Program 1`, `Block 2`: numbered in the order rows are met. */
export function numbered(kind: string): Rewrite {
  return (value, row, ctx) =>
    value === null ? null : `${kind} ${number(ctx, kind, String(row.id))}`;
}

/** `Workout A` to `Workout Z`, then `Workout 27` on. */
export const workoutName: Rewrite = (value, row, ctx) => {
  if (value === null) return null;
  const n = number(ctx, 'Workout', String(row.id));
  return `Workout ${n <= 26 ? String.fromCharCode(64 + n) : n}`;
};

export const load: Rewrite = (value, _row, ctx, where) =>
  value === null ? null : numeric(value, where) * ctx.loadFactor;

/** A load only on the rows whose `column` names a load-valued kind. */
export function loadWhen(column: string, kinds: readonly string[]): Rewrite {
  return (value, row, ctx, where) =>
    kinds.includes(String(row[column])) ? load(value, row, ctx, where) : value;
}

/** A lift priority names an exercise; a muscle priority names a muscle group, which is kept. */
export const priorityRef: Rewrite = (value, row, ctx, where) =>
  row.kind === 'lift' ? exercise(value, row, ctx, where) : value;

/** The baseline key is `user|exercise|setup|side`; only its exercise part needs a stand-in. */
export const baselineId: Rewrite = (value, _row, ctx, where) => {
  const parts = text(value, where).split('|');
  if (parts.length !== 4) throw new Error(`anonymize: ${where} is not a four-part baseline key`);
  parts[1] = exerciseStandIn(parts[1] as string, ctx);
  return parts.join('|');
};

function rewritePhase(
  phase: Record<string, unknown>,
  ctx: AnonymizeContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...phase, samples: [] };
  for (const [key, v] of Object.entries(phase)) {
    if (typeof v !== 'number') continue;
    if (PHASE_LOAD_KEYS.has(key)) out[key] = v * ctx.loadFactor;
    if (PHASE_TIME_KEYS.has(key) && v > EPOCH_MS_FLOOR) out[key] = v - ctx.shiftWeeks * 7 * DAY_MS;
  }
  return out;
}

function rewriteDerived(
  derived: Record<string, unknown>,
  ctx: AnonymizeContext,
): Record<string, unknown> {
  const out = { ...derived };
  for (const key of DERIVED_LOAD_KEYS) {
    if (typeof out[key] === 'number') out[key] = (out[key] as number) * ctx.loadFactor;
  }
  return out;
}

/** Phase aggregates and `derived` are kept; the sample arrays are emptied. Unknown keys fail. */
export const repPayload: Rewrite = (value, _row, ctx, where) => {
  const rep = JSON.parse(text(value, where)) as Record<string, unknown>;
  const unknown = Object.keys(rep).filter((k) => !REP_KEYS.has(k));
  if (unknown.length > 0)
    throw new Error(`anonymize: ${where} has unlisted keys ${unknown.join(', ')}`);
  const out: Record<string, unknown> = { ...rep };
  for (const phase of ['concentric', 'eccentric'] as const) {
    if (rep[phase]) out[phase] = rewritePhase(rep[phase] as Record<string, unknown>, ctx);
  }
  if (rep.derived) out.derived = rewriteDerived(rep.derived as Record<string, unknown>, ctx);
  return JSON.stringify(out);
};
