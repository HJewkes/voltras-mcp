// Transcript schema and fail-closed redaction for the agent-pane video export
// (VW-257). Everything a pane shows passes five gates in order: tool allowlist,
// schema projection of args, explicitly named result and push fields, a key
// denylist, and value checks, then one structural walk of the whole transcript.
// Any failure throws; there is no partial output. Pure: no I/O, no clock.

import { z } from 'zod';

import { findEncodedValues } from './protocol-guard.js';

export const TRANSCRIPT_SCHEMA_ID = 'voltras-agent-transcript/1';
export const COLLAPSED_VALUE = '…';

const MAX_TEXT_CHARS = 280;
const MAX_VALUE_CHARS = 60;

// ── Schemas ────────────────────────────────────────────────────────────────

const primitiveSchema = z.union([z.string(), z.number(), z.boolean()]);
const namedValueSchema = z.strictObject({ name: z.string().min(1), value: primitiveSchema });
const seqSchema = z.number().int().nonnegative();
const textSchema = z.string().max(MAX_TEXT_CHARS);

const entrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ seq: seqSchema, kind: z.literal('user'), text: textSchema }),
  z.strictObject({ seq: seqSchema, kind: z.literal('assistant'), text: textSchema }),
  z.strictObject({
    seq: seqSchema,
    kind: z.literal('tool_call'),
    callId: z.string(),
    tool: z.string(),
    args: z.array(namedValueSchema),
    argsCollapsed: z.number().int().nonnegative(),
  }),
  z.strictObject({
    seq: seqSchema,
    kind: z.literal('tool_result'),
    callId: z.string(),
    status: z.enum(['ok', 'error']),
    errorCode: z.string().optional(),
    fields: z.array(namedValueSchema),
  }),
  z.strictObject({
    seq: seqSchema,
    kind: z.literal('channel'),
    event: z.string(),
    slot: z.string().optional(),
    fields: z.array(namedValueSchema),
  }),
]);

export const agentTranscriptSchema = z.strictObject({
  schema: z.literal(TRANSCRIPT_SCHEMA_ID),
  source: z.strictObject({
    kind: z.enum(['mock', 'synthetic']),
    exporter: z.literal('export-agent-transcript'),
    serverVersion: z.string(),
    exchange: z.string(),
  }),
  entries: z.array(entrySchema),
});

const callStepSchema = z.strictObject({
  call: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
  offscreen: z.boolean().optional(),
  showArgs: z.array(z.string()).optional(),
  showResult: z.array(z.string()).optional(),
});

const awaitChannelStepSchema = z.strictObject({
  awaitChannel: z.string(),
  count: z.number().int().positive(),
  showFields: z.array(z.string()).optional(),
});

export const exchangeScriptSchema = z.strictObject({
  exchange: z.string().min(1),
  pinnedReps: z.number().int().nonnegative().optional(),
  steps: z.array(
    z.union([
      z.strictObject({ user: textSchema }),
      z.strictObject({ assistant: textSchema }),
      callStepSchema,
      awaitChannelStepSchema,
    ]),
  ),
});

export type AgentTranscript = z.infer<typeof agentTranscriptSchema>;
export type TranscriptEntry = z.infer<typeof entrySchema>;
export type NamedValue = z.infer<typeof namedValueSchema>;
export type ExchangeScript = z.infer<typeof exchangeScriptSchema>;
export type CallStep = z.infer<typeof callStepSchema>;
export type AwaitChannelStep = z.infer<typeof awaitChannelStepSchema>;

// ── Inputs recorded by the exporter ────────────────────────────────────────

export interface JsonSchemaProperty {
  readonly type?: string | readonly string[];
  readonly enum?: readonly unknown[];
}

export interface ToolInputSchema {
  readonly properties?: Readonly<Record<string, JsonSchemaProperty>>;
}

export interface ToolsList {
  readonly tools: readonly { readonly name: string; readonly inputSchema: ToolInputSchema }[];
}

export interface ChannelNotification {
  readonly content: unknown;
  readonly meta: Readonly<Record<string, unknown>>;
}

export interface CallOutcome {
  readonly isError: boolean;
  readonly errorCode?: string;
  readonly value: unknown;
}

export type RecordedStep =
  | { readonly user: string }
  | { readonly assistant: string }
  | { readonly step: CallStep; readonly outcome: CallOutcome }
  | { readonly step: AwaitChannelStep; readonly notifications: readonly ChannelNotification[] };

export interface Recording {
  readonly exchange: string;
  readonly sourceKind: 'mock' | 'synthetic';
  readonly serverVersion: string;
  readonly steps: readonly RecordedStep[];
}

// ── Errors ─────────────────────────────────────────────────────────────────

export type ScreenSafetyCode =
  | 'TOOL_REFUSED'
  | 'TOOL_UNKNOWN'
  | 'ARG_NOT_DECLARED'
  | 'ENUM_NOT_MEMBER'
  | 'FIELD_MISSING'
  | 'FIELD_NOT_PRIMITIVE'
  | 'KEY_DENIED'
  | 'VALUE_REFUSED'
  | 'SCREEN_UNSAFE';

/** Every refusal. The message names the tool or key, never the refused value. */
export class ScreenSafetyError extends Error {
  constructor(
    readonly code: ScreenSafetyCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'ScreenSafetyError';
  }
}

// ── Gate 1: tool allowlist ─────────────────────────────────────────────────

const ALLOWED_NAMESPACES = new Set([
  'device',
  'bilateral',
  'slot',
  'session',
  'set',
  'exercise',
  'metrics',
  'plan',
  'timer',
  'coaching',
]);
const REFUSED_NAMESPACES = new Set(['debug', 'mock', 'system', 'truecoach']);
const REFUSED_TOOLS = new Set(['device.send_raw']);

export function assertToolAllowed(tool: string): void {
  const namespace = tool.split('.')[0] ?? '';
  if (REFUSED_TOOLS.has(tool)) throw new ScreenSafetyError('TOOL_REFUSED', `${tool} by name`);
  if (DENIED_KEY.test(tool))
    throw new ScreenSafetyError('TOOL_REFUSED', `${tool} has a denied word`);
  if (REFUSED_NAMESPACES.has(namespace)) {
    throw new ScreenSafetyError('TOOL_REFUSED', `${tool} in a refused namespace`);
  }
  if (!ALLOWED_NAMESPACES.has(namespace)) {
    throw new ScreenSafetyError('TOOL_REFUSED', `${tool} outside the allowlist`);
  }
}

// ── Gates 4 and 5: key denylist and value checks ───────────────────────────

const DENIED_KEY = /frame|payload|bytes|raw|hex|opcode|register|command|buffer/i;
const HEX_RUN = /[0-9a-f]{6,}/gi;
const HEX_LITERAL = /0x[0-9a-f]{4,}/i;
const BASE64_RUN = /[A-Za-z0-9+/]{25,}/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ISO_DATE = /\d{4}-\d{2}-\d{2}/;
const PATH_SHAPED = /^(?:~|\.{1,2})?[\\/]|^[A-Za-z]:[\\/]|[\\/][^\\/\s]*[\\/]/;

export function assertKeyAllowed(key: string): void {
  if (DENIED_KEY.test(key)) throw new ScreenSafetyError('KEY_DENIED', `key "${key}"`);
}

/** A long run counts as hex only when digits and a-f letters mix, so plain words and numbers pass. */
function hasMixedHexRun(text: string): boolean {
  return text.match(HEX_RUN)?.some((run) => /\d/.test(run) && /[a-f]/i.test(run)) ?? false;
}

/** Why a string cannot be shown, or null. Length is checked by the caller. */
function encodedShape(text: string): string | null {
  if (UUID.test(text)) return 'a UUID';
  if (hasMixedHexRun(text) || HEX_LITERAL.test(text)) return 'a hex run';
  if (BASE64_RUN.test(text)) return 'a base64 run';
  if (findEncodedValues(text).length > 0) return 'an encoded value';
  return null;
}

function assertValueSafe(name: string, value: unknown): void {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new ScreenSafetyError('VALUE_REFUSED', `"${name}" is not a finite number`);
  }
  if (typeof value !== 'string' || value === COLLAPSED_VALUE) return;
  if (value.length > MAX_VALUE_CHARS) {
    throw new ScreenSafetyError('VALUE_REFUSED', `"${name}" is over ${MAX_VALUE_CHARS} chars`);
  }
  const shape = encodedShape(value) ?? (PATH_SHAPED.test(value) ? 'a path' : null);
  if (shape) throw new ScreenSafetyError('VALUE_REFUSED', `"${name}" holds ${shape}`);
}

/** A server-produced field may carry wall-clock time; an authored arg such as a plan date may not. */
function assertNotDated(name: string, value: unknown): void {
  if (typeof value === 'string' && ISO_DATE.test(value)) {
    throw new ScreenSafetyError('VALUE_REFUSED', `"${name}" holds a date`);
  }
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

// ── Gate 2: schema projection of args ──────────────────────────────────────

function isEnumTyped(property: JsonSchemaProperty): boolean {
  return Array.isArray(property.enum);
}

function defaultShownArgs(
  properties: Readonly<Record<string, JsonSchemaProperty>>,
  args: Readonly<Record<string, unknown>>,
): string[] {
  return Object.keys(args).filter((key) => {
    const property = Object.hasOwn(properties, key) ? properties[key] : undefined;
    return property !== undefined && (key === 'slot' || isEnumTyped(property));
  });
}

function projectArg(key: string, property: JsonSchemaProperty, value: unknown): NamedValue {
  assertKeyAllowed(key);
  if (!isPrimitive(value)) return { name: key, value: COLLAPSED_VALUE };
  if (isEnumTyped(property) && !property.enum?.includes(value)) {
    throw new ScreenSafetyError('ENUM_NOT_MEMBER', `"${key}" is not an enum member`);
  }
  assertValueSafe(key, value);
  return { name: key, value };
}

/** The args a pane shows, plus how many passed args it hides. */
export function projectArgs(
  inputSchema: ToolInputSchema,
  args: Readonly<Record<string, unknown>>,
  showArgs?: readonly string[],
): { args: NamedValue[]; argsCollapsed: number } {
  const properties = inputSchema.properties ?? {};
  const shown = (showArgs ?? defaultShownArgs(properties, args)).filter((key) =>
    Object.hasOwn(args, key),
  );
  const projected = shown.map((key) => {
    if (!Object.hasOwn(properties, key)) {
      throw new ScreenSafetyError('ARG_NOT_DECLARED', `showArgs names undeclared "${key}"`);
    }
    return projectArg(key, properties[key] as JsonSchemaProperty, args[key]);
  });
  return { args: projected, argsCollapsed: Object.keys(args).length - projected.length };
}

// ── Gate 3: named result and push fields ───────────────────────────────────

/** Named flat keys of a result object; nothing else is ever read. */
export function projectFields(value: unknown, names: readonly string[]): NamedValue[] {
  if (names.length === 0) return [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScreenSafetyError('FIELD_MISSING', 'the result is not a flat object');
  }
  const record = value as Record<string, unknown>;
  return names.map((name) => {
    assertKeyAllowed(name);
    if (!Object.hasOwn(record, name)) throw new ScreenSafetyError('FIELD_MISSING', `"${name}"`);
    const field = record[name];
    if (!isPrimitive(field)) throw new ScreenSafetyError('FIELD_NOT_PRIMITIVE', `"${name}"`);
    assertValueSafe(name, field);
    assertNotDated(name, field);
    return { name, value: field };
  });
}

/** A push shows its event type, its slot and named meta keys; never its content. */
export function projectChannel(
  notification: ChannelNotification,
  names: readonly string[],
): { event: string; slot?: string; fields: NamedValue[] } {
  const event = notification.meta.event_type;
  if (typeof event !== 'string') throw new ScreenSafetyError('FIELD_MISSING', '"event_type"');
  assertValueSafe('event_type', event);
  const slot = notification.meta.slot;
  const fields = projectFields(notification.meta, names);
  if (typeof slot !== 'string') return { event, fields };
  assertValueSafe('slot', slot);
  return { event, slot, fields };
}

// ── Final walk (runtime AC-11) ─────────────────────────────────────────────

function isByteArray(value: readonly unknown[]): boolean {
  return (
    value.length > 8 &&
    value.every(
      (item) => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255,
    )
  );
}

function walkViolations(value: unknown, path: string): string[] {
  if (typeof value === 'string') {
    const shape = encodedShape(value);
    return shape ? [`${path} holds ${shape}`] : [];
  }
  if (Array.isArray(value)) {
    const own = isByteArray(value) ? [`${path} is a byte-range array`] : [];
    return own.concat(value.flatMap((item, index) => walkViolations(item, `${path}[${index}]`)));
  }
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const own = DENIED_KEY.test(key) ? [`${path}.${key} is a denied key`] : [];
    return own.concat(walkViolations(child, `${path}.${key}`));
  });
}

function namedValueViolations(transcript: AgentTranscript): string[] {
  return transcript.entries.flatMap((entry) => {
    const named = 'args' in entry ? entry.args : 'fields' in entry ? entry.fields : [];
    return named.filter(({ name }) => DENIED_KEY.test(name)).map(({ name }) => `name "${name}"`);
  });
}

/** Schema check plus the AC-11 structural walk; throws on the first unsafe transcript. */
export function assertScreenSafe(transcript: unknown): AgentTranscript {
  const structural = walkViolations(transcript, '$');
  if (structural.length > 0) throw new ScreenSafetyError('SCREEN_UNSAFE', structural.join('; '));
  const parsed = agentTranscriptSchema.safeParse(transcript);
  if (!parsed.success) throw new ScreenSafetyError('SCREEN_UNSAFE', 'transcript shape is invalid');
  const named = namedValueViolations(parsed.data);
  if (named.length > 0) throw new ScreenSafetyError('SCREEN_UNSAFE', named.join('; '));
  return parsed.data;
}

// ── Assembly ───────────────────────────────────────────────────────────────

interface Cursor {
  seq: number;
  calls: number;
}

function toolSchema(toolsList: ToolsList, tool: string): ToolInputSchema {
  const found = toolsList.tools.find((candidate) => candidate.name === tool);
  if (!found) throw new ScreenSafetyError('TOOL_UNKNOWN', `${tool} is not in tools/list`);
  return found.inputSchema;
}

function callEntries(
  recorded: { step: CallStep; outcome: CallOutcome },
  toolsList: ToolsList,
  cursor: Cursor,
): TranscriptEntry[] {
  const { step, outcome } = recorded;
  assertToolAllowed(step.call);
  const projection = projectArgs(toolSchema(toolsList, step.call), step.args, step.showArgs);
  if (step.offscreen) return [];
  cursor.calls += 1;
  const callId = `c${cursor.calls}`;
  const call: TranscriptEntry = {
    seq: cursor.seq++,
    kind: 'tool_call',
    callId,
    tool: step.call,
    ...projection,
  };
  return [call, resultEntry(callId, outcome, step.showResult ?? [], cursor)];
}

function resultEntry(
  callId: string,
  outcome: CallOutcome,
  names: readonly string[],
  cursor: Cursor,
): TranscriptEntry {
  if (!outcome.isError) {
    const fields = projectFields(outcome.value, names);
    return { seq: cursor.seq++, kind: 'tool_result', callId, status: 'ok', fields };
  }
  const errorCode = outcome.errorCode ?? 'UNKNOWN';
  if (!/^[A-Z][A-Z_]{0,39}$/.test(errorCode)) {
    throw new ScreenSafetyError('VALUE_REFUSED', `${callId} error code is not a public code`);
  }
  return { seq: cursor.seq++, kind: 'tool_result', callId, status: 'error', errorCode, fields: [] };
}

function channelEntries(
  step: AwaitChannelStep,
  notifications: readonly ChannelNotification[],
  cursor: Cursor,
): TranscriptEntry[] {
  return notifications.map((notification) => {
    const projected = projectChannel(notification, step.showFields ?? []);
    return { seq: cursor.seq++, kind: 'channel', ...projected };
  });
}

function stepEntries(
  recorded: RecordedStep,
  toolsList: ToolsList,
  cursor: Cursor,
): TranscriptEntry[] {
  if ('user' in recorded) return [{ seq: cursor.seq++, kind: 'user', text: recorded.user }];
  if ('assistant' in recorded) {
    return [{ seq: cursor.seq++, kind: 'assistant', text: recorded.assistant }];
  }
  if ('outcome' in recorded) return callEntries(recorded, toolsList, cursor);
  return channelEntries(recorded.step, recorded.notifications, cursor);
}

/** Every gate, then the final walk. Returns only a transcript that passed all of them. */
export function buildTranscript(recording: Recording, toolsList: ToolsList): AgentTranscript {
  const cursor: Cursor = { seq: 0, calls: 0 };
  const entries = recording.steps.flatMap((step) => stepEntries(step, toolsList, cursor));
  return assertScreenSafe({
    schema: TRANSCRIPT_SCHEMA_ID,
    source: {
      kind: recording.sourceKind,
      exporter: 'export-agent-transcript',
      serverVersion: recording.serverVersion,
      exchange: recording.exchange,
    },
    entries,
  });
}

/** Stable bytes: key order is fixed by construction and nothing depends on the clock. */
export function serializeTranscript(transcript: AgentTranscript): string {
  return `${JSON.stringify(assertScreenSafe(transcript), null, 2)}\n`;
}
