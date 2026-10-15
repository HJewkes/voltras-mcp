// `GET /api/activity` (VW-893, slice 4 of VW-849): the audit trail as a feed.
//
// A served row is BUILT, field by field, from the stored row. It never spreads
// the stored row, so the two columns the store returns and the feed must never
// carry (the input hash and the handler's result) cannot leak through a field
// nobody named here. `activity-row-allowlist.test.ts` fails on any extra key.
//
// The summary is filtered again on the way out, to `SUMMARY_FIELDS` and to
// string or number values, so a row written by an older or buggier summariser
// still serves only allowlisted fields.
//
// Paging is keyset on `(createdAt, actionId)`, newest first. The cursor is the
// last served row's pair, base64url-encoded; it is opaque to the client and
// `nextCursor` is null once a page comes back short.

import { SUMMARY_FIELDS, type CommandSummary } from '../actions/command-summary.js';
import type {
  ListActivityFilter,
  StoredUiAction,
  UiActionActor,
  UiActionStatus,
  UiActionSurface,
} from '../store/types.js';
import { UI_ACTION_STATUSES } from '../store/types.js';

/** Every key a served row has, and nothing else. */
export const ACTIVITY_ROW_FIELDS = [
  'id',
  'at',
  'completedAt',
  'actor',
  'surface',
  'tool',
  'summary',
  'reason',
  'outcome',
  'code',
  'sessionId',
  'flowId',
  'flowStep',
  'deviceId',
] as const;

/** Who acted, in the feed's words. The stored actor never reaches a client. */
export const ACTOR_LABELS = { user: 'person', coach: 'agent', tick: 'rule' } as const;

export type ActorLabel = (typeof ACTOR_LABELS)[UiActionActor];

export const ACTIVITY_DEFAULT_LIMIT = 50;
/** Any larger `?limit=` is clamped to this. The store has no cap of its own. */
export const ACTIVITY_MAX_LIMIT = 200;

export interface ActivityRow {
  id: string;
  at: string;
  completedAt: string | null;
  actor: ActorLabel;
  surface: UiActionSurface;
  tool: string;
  summary: CommandSummary | null;
  reason: string | null;
  outcome: UiActionStatus;
  code: string | null;
  sessionId: string | null;
  flowId: string | null;
  flowStep: string | null;
  deviceId: string | null;
}

export interface ActivityPage {
  rows: ActivityRow[];
  nextCursor: string | null;
}

/** The store slice the feed reads. */
export interface ActivityStore {
  listActivity(filter: ListActivityFilter): Promise<StoredUiAction[]>;
}

/** A parsed query: the store filter, less paging, plus the clamped page size. */
export interface ActivityQuery {
  filter: Omit<ListActivityFilter, 'limit'>;
  limit: number;
}

function actorFromLabel(label: string): UiActionActor | undefined {
  const match = Object.entries(ACTOR_LABELS).find(([, value]) => value === label);
  return match?.[0] as UiActionActor | undefined;
}

function isoInstant(raw: string): string | undefined {
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Absent, empty or not a positive integer reads as the default; anything larger is clamped. */
export function clampActivityLimit(raw: string | null): number {
  const parsed = raw === null || raw === '' ? Number.NaN : Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return ACTIVITY_DEFAULT_LIMIT;
  return Math.min(parsed, ACTIVITY_MAX_LIMIT);
}

export function encodeActivityCursor(row: { at: string; id: string }): string {
  return Buffer.from(JSON.stringify([row.at, row.id]), 'utf8').toString('base64url');
}

export function decodeActivityCursor(
  cursor: string,
): { createdAt: string; actionId: string } | undefined {
  try {
    const pair: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(pair) || pair.length !== 2) return undefined;
    const [createdAt, actionId] = pair as unknown[];
    if (typeof createdAt !== 'string' || typeof actionId !== 'string') return undefined;
    return { createdAt, actionId };
  } catch {
    return undefined;
  }
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseActor(raw: string | null): Parsed<UiActionActor | undefined> {
  if (raw === null) return { ok: true, value: undefined };
  const actor = actorFromLabel(raw);
  return actor === undefined
    ? { ok: false, error: `actor is one of ${Object.values(ACTOR_LABELS).join(', ')}` }
    : { ok: true, value: actor };
}

function parseStatus(raw: string | null): Parsed<UiActionStatus | undefined> {
  if (raw === null) return { ok: true, value: undefined };
  const status = UI_ACTION_STATUSES.find((value) => value === raw);
  return status === undefined
    ? { ok: false, error: `status is one of ${UI_ACTION_STATUSES.join(', ')}` }
    : { ok: true, value: status };
}

function parseInstant(name: string, raw: string | null): Parsed<string | undefined> {
  if (raw === null) return { ok: true, value: undefined };
  const instant = isoInstant(raw);
  return instant === undefined
    ? { ok: false, error: `${name} is an ISO date or date-time` }
    : { ok: true, value: instant };
}

function parseCursor(raw: string | null): Parsed<ListActivityFilter['after']> {
  if (raw === null) return { ok: true, value: undefined };
  const after = decodeActivityCursor(raw);
  return after === undefined
    ? { ok: false, error: 'cursor is not one this route issued' }
    : { ok: true, value: after };
}

/** Drop the parameters that were absent or empty, so they filter nothing. */
function defined<T extends object>(entries: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(entries).filter(
      ([, value]) => value !== undefined && value !== null && value !== '',
    ),
  ) as Partial<T>;
}

/** Read the query string into a store filter, or name the first parameter that is wrong. */
export function parseActivityQuery(params: URLSearchParams): ActivityQuery | { error: string } {
  const actor = parseActor(params.get('actor'));
  const status = parseStatus(params.get('status'));
  const since = parseInstant('since', params.get('since'));
  const until = parseInstant('until', params.get('until'));
  const after = parseCursor(params.get('cursor'));
  for (const parsed of [actor, status, since, until, after]) {
    if (!parsed.ok) return { error: parsed.error };
  }
  const filter = defined({
    sessionId: params.get('sessionId'),
    flowId: params.get('flowId'),
    actor: actor.ok ? actor.value : undefined,
    status: status.ok ? status.value : undefined,
    since: since.ok ? since.value : undefined,
    until: until.ok ? until.value : undefined,
    after: after.ok ? after.value : undefined,
  }) as ActivityQuery['filter'];
  return { filter, limit: clampActivityLimit(params.get('limit')) };
}

/** The stored summary, keeping only allowlisted keys with string or number values. */
function servedSummary(summaryJson: string | undefined): CommandSummary | null {
  if (summaryJson === undefined) return null;
  let stored: unknown;
  try {
    stored = JSON.parse(summaryJson);
  } catch {
    return null;
  }
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return null;
  const summary: Partial<Record<(typeof SUMMARY_FIELDS)[number], string | number>> = {};
  for (const field of SUMMARY_FIELDS) {
    const value = (stored as Record<string, unknown>)[field];
    if (typeof value === 'string' || typeof value === 'number') summary[field] = value;
  }
  return Object.keys(summary).length === 0 ? null : summary;
}

/** One served row, built from named fields only. */
export function toActivityRow(stored: StoredUiAction): ActivityRow {
  return {
    id: stored.actionId,
    at: stored.createdAt,
    completedAt: stored.completedAt ?? null,
    actor: ACTOR_LABELS[stored.actor],
    surface: stored.surface,
    tool: stored.actionName,
    summary: servedSummary(stored.summaryJson),
    reason: stored.reason ?? null,
    outcome: stored.resultStatus,
    code: stored.resultCode ?? null,
    sessionId: stored.sessionId ?? null,
    flowId: stored.flowId ?? null,
    flowStep: stored.flowStep ?? null,
    deviceId: stored.deviceId ?? null,
  };
}

/** One page of the feed. Reads one row past the page to know whether another follows. */
export async function readActivity(
  store: ActivityStore,
  query: ActivityQuery,
): Promise<ActivityPage> {
  const stored = await store.listActivity({ ...query.filter, limit: query.limit + 1 });
  const rows = stored.slice(0, query.limit).map(toActivityRow);
  const last = rows.at(-1);
  const nextCursor =
    stored.length > query.limit && last !== undefined ? encodeActivityCursor(last) : null;
  return { rows, nextCursor };
}
