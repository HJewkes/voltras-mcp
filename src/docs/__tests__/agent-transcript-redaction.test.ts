import { describe, expect, it } from 'vitest';

import {
  COLLAPSED_VALUE,
  ScreenSafetyError,
  agentTranscriptSchema,
  assertScreenSafe,
  buildTranscript,
  exchangeScriptSchema,
  projectArgs,
  projectChannel,
  projectFields,
  serializeTranscript,
  type Recording,
  type RecordedStep,
  type ToolsList,
} from '../agent-transcript.js';

// Synthetic tools/list: made-up schemas shaped like the public namespaces.
const TOOLS_LIST: ToolsList = {
  tools: [
    { name: 'device.scan', inputSchema: { properties: { timeoutMs: { type: 'number' } } } },
    {
      name: 'device.connect',
      inputSchema: {
        properties: {
          deviceId: { type: 'string' },
          slot: { type: 'string', enum: ['primary', 'left', 'right'] },
        },
      },
    },
    {
      name: 'device.set_mode',
      inputSchema: {
        properties: {
          mode: { type: 'string', enum: ['weight', 'band', 'damper'] },
          slot: { type: 'string', enum: ['primary', 'left', 'right'] },
          options: { type: 'object' },
        },
      },
    },
    { name: 'device.send_raw', inputSchema: { properties: { data: { type: 'string' } } } },
    { name: 'debug.recent_events', inputSchema: { properties: { limit: { type: 'number' } } } },
    { name: 'set.start', inputSchema: { properties: { targetReps: { type: 'number' } } } },
    { name: 'session.start', inputSchema: { properties: { exerciseName: { type: 'string' } } } },
  ],
};

const HEX_LOOKING = 'ab'.repeat(8);
const MADE_UP_UUID = `${'a'.repeat(8)}-${'b'.repeat(4)}-4${'c'.repeat(3)}-8${'d'.repeat(3)}-${'e'.repeat(12)}`;
const BASE64_LOOKING = `${'QmFzZTY0'.repeat(4)}==`;
const BYTE_RANGE_ARRAY = Array.from({ length: 12 }, (_, index) => index * 20);
const SHORT_HEX_LITERALS = [`id0x${'1'.repeat(4)}`, `v_0x${'1'.repeat(5)}`];

function recording(steps: readonly RecordedStep[]): Recording {
  return {
    exchange: 'synthetic-connect-and-set',
    sourceKind: 'synthetic',
    serverVersion: '0.0.0',
    steps,
  };
}

function callStep(
  call: string,
  args: Record<string, unknown>,
  value: unknown = {},
  extra: { showArgs?: string[]; showResult?: string[]; offscreen?: boolean } = {},
): RecordedStep {
  return { step: { call, args, ...extra }, outcome: { isError: false, value } };
}

function refusalCode(act: () => unknown): string | undefined {
  try {
    act();
  } catch (error) {
    if (error instanceof ScreenSafetyError) return error.code;
    throw error;
  }
  return undefined;
}

const CLEAN_STEPS: readonly RecordedStep[] = [
  { user: 'Connect to the Voltra and start a set.' },
  callStep(
    'device.scan',
    { timeoutMs: 1000 },
    { devices: [{ id: 'mock-1' }] },
    { offscreen: true },
  ),
  { assistant: 'Connecting now.' },
  callStep(
    'device.connect',
    { deviceId: 'mock-1', slot: 'primary' },
    { connected: true, internal: { nested: 1 } },
    { showArgs: ['slot'], showResult: ['connected'] },
  ),
  callStep('set.start', {}, { started: true }),
  {
    step: { awaitChannel: 'rep_finalized', count: 1, showFields: ['rep_count'] },
    notifications: [
      {
        content: '{"rep":1}',
        meta: { event_type: 'rep_finalized', slot: 'primary', rep_count: '1' },
      },
    ],
  },
  { assistant: 'Rep one is in.' },
];

describe('gate 1: tool allowlist', () => {
  it('refuses a device.send_raw call by name', () => {
    const steps = [callStep('device.send_raw', { data: 'x' })];

    const code = refusalCode(() => buildTranscript(recording(steps), TOOLS_LIST));

    expect(code).toBe('TOOL_REFUSED');
  });

  it('refuses a debug call even when it is offscreen', () => {
    const steps = [callStep('debug.recent_events', { limit: 5 }, {}, { offscreen: true })];

    const code = refusalCode(() => buildTranscript(recording(steps), TOOLS_LIST));

    expect(code).toBe('TOOL_REFUSED');
  });

  it.each(['device..send_raw', 'device.send_RAW', 'device.sendRaw'])(
    'refuses %s, a spelling of a refused tool, before any tools/list lookup',
    (tool) => {
      const code = refusalCode(() => buildTranscript(recording([callStep(tool, {})]), TOOLS_LIST));

      expect(code).toBe('TOOL_REFUSED');
    },
  );

  it.each(['mock.configure', 'system.speak', 'truecoach.import_week', 'profile.get_body_metrics'])(
    'refuses %s outside the allowlist',
    (tool) => {
      const code = refusalCode(() => buildTranscript(recording([callStep(tool, {})]), TOOLS_LIST));

      expect(code).toBe('TOOL_REFUSED');
    },
  );
});

describe('gate 2: schema projection of args', () => {
  it('drops an undeclared arg, counts it, and never serializes it', () => {
    const steps = [callStep('device.connect', { slot: 'left', bytesHex: HEX_LOOKING })];

    const transcript = buildTranscript(recording(steps), TOOLS_LIST);
    const serialized = serializeTranscript(transcript);

    expect(transcript.entries[0]).toMatchObject({
      args: [{ name: 'slot', value: 'left' }],
      argsCollapsed: 1,
    });
    expect(serialized).not.toContain('bytesHex');
    expect(serialized).not.toContain(HEX_LOOKING);
  });

  it('refuses an enum arg carrying a value outside the enum', () => {
    const properties = TOOLS_LIST.tools[2]?.inputSchema ?? {};

    const code = refusalCode(() => projectArgs(properties, { mode: 'overdrive' }));

    expect(code).toBe('ENUM_NOT_MEMBER');
  });

  it('collapses an object arg the step asks to show', () => {
    const properties = TOOLS_LIST.tools[2]?.inputSchema ?? {};

    const result = projectArgs(properties, { mode: 'band', options: { depth: 3 } }, [
      'mode',
      'options',
    ]);

    expect(result.args).toEqual([
      { name: 'mode', value: 'band' },
      { name: 'options', value: COLLAPSED_VALUE },
    ]);
  });

  it('refuses showArgs naming a key the schema does not declare', () => {
    const properties = TOOLS_LIST.tools[1]?.inputSchema ?? {};

    const code = refusalCode(() => projectArgs(properties, { extra: 'x' }, ['extra']));

    expect(code).toBe('ARG_NOT_DECLARED');
  });

  // No fast-check in this repo: a deterministic table of extra keys over every fixture tool.
  const EXTRA_KEYS = ['bytesHex', 'frame', 'x', 'nested', '__proto__x', 'Payload', 'aaaaaa', 'z9'];
  const EXTRA_VALUES: unknown[] = [
    HEX_LOOKING,
    MADE_UP_UUID,
    BYTE_RANGE_ARRAY,
    { raw: 1 },
    7,
    true,
  ];

  it.each(TOOLS_LIST.tools.map((tool) => [tool.name, tool.inputSchema] as const))(
    'never lets an arbitrary extra key survive on %s',
    (_name, inputSchema) => {
      for (const [index, key] of EXTRA_KEYS.entries()) {
        const args = { [key]: EXTRA_VALUES[index % EXTRA_VALUES.length] };

        const result = projectArgs(inputSchema, args);

        expect(result).toEqual({ args: [], argsCollapsed: 1 });
      }
    },
  );
});

describe('gate 3: named result and push fields', () => {
  it('renders nothing from a result unless the field is named', () => {
    const fields = projectFields({ connected: true, secret: HEX_LOOKING }, []);

    expect(fields).toEqual([]);
  });

  it.each([
    ['a hex-looking string', HEX_LOOKING, 'VALUE_REFUSED'],
    ['a UUID', MADE_UP_UUID, 'VALUE_REFUSED'],
    ['a base64-looking string', BASE64_LOOKING, 'VALUE_REFUSED'],
    ['a 12-element byte-range array', BYTE_RANGE_ARRAY, 'FIELD_NOT_PRIMITIVE'],
    ['a string over 60 chars', 'long '.repeat(13), 'VALUE_REFUSED'],
    ...SHORT_HEX_LITERALS.map((literal) => [
      `the short hex literal ${literal}`,
      literal,
      'VALUE_REFUSED',
    ]),
  ])('refuses a named result field holding %s', (_label, value, expected) => {
    const steps = [callStep('set.start', {}, { status: value }, { showResult: ['status'] })];

    const code = refusalCode(() => buildTranscript(recording(steps), TOOLS_LIST));

    expect(code).toBe(expected);
  });

  it('keeps only event_type and slot from a push whose content carries a nested payload', () => {
    const notification = {
      content: JSON.stringify({ payload: { data: BYTE_RANGE_ARRAY }, id: MADE_UP_UUID }),
      meta: { event_type: 'rep_finalized', slot: 'right', session_id: MADE_UP_UUID },
    };

    const projected = projectChannel(notification, []);

    expect(projected).toEqual({ event: 'rep_finalized', slot: 'right', fields: [] });
  });

  it('never renders the content body even when a field name matches a content key', () => {
    const notification = {
      content: { rep_count: HEX_LOOKING },
      meta: { event_type: 'rep_finalized', slot: 'primary' },
    };

    const code = refusalCode(() => projectChannel(notification, ['rep_count']));

    expect(code).toBe('FIELD_MISSING');
  });
});

describe('gate 4: key denylist', () => {
  it.each([
    'frameCount',
    'PAYLOAD',
    'rawValue',
    'hex',
    'opcode',
    'registerName',
    'commandId',
    'bufferSize',
  ])('refuses a named field called %s whatever the value', (name) => {
    const code = refusalCode(() => projectFields({ [name]: 1 }, [name]));

    expect(code).toBe('KEY_DENIED');
  });

  it('refuses a declared arg whose name is denied', () => {
    const schema = { properties: { rawMode: { type: 'string', enum: ['on', 'off'] } } };

    const code = refusalCode(() => projectArgs(schema, { rawMode: 'on' }));

    expect(code).toBe('KEY_DENIED');
  });
});

describe('gate 5 and the final AC-11 walk', () => {
  it('passes a clean exchange that round-trips through the transcript schema', () => {
    const transcript = buildTranscript(recording(CLEAN_STEPS), TOOLS_LIST);
    const serialized = serializeTranscript(transcript);
    const reparsed = agentTranscriptSchema.parse(JSON.parse(serialized));

    expect(() => assertScreenSafe(reparsed)).not.toThrow();
    expect(reparsed).toEqual(transcript);
    expect(transcript.entries.map((entry) => [entry.seq, entry.kind])).toEqual([
      [0, 'user'],
      [1, 'assistant'],
      [2, 'tool_call'],
      [3, 'tool_result'],
      [4, 'tool_call'],
      [5, 'tool_result'],
      [6, 'channel'],
      [7, 'assistant'],
    ]);
  });

  it('serializes the same recording byte-identically with no ids or timestamps', () => {
    const first = serializeTranscript(buildTranscript(recording(CLEAN_STEPS), TOOLS_LIST));
    const second = serializeTranscript(buildTranscript(recording(CLEAN_STEPS), TOOLS_LIST));

    expect(second).toBe(first);
    expect(first).not.toMatch(/mock-1|timestamp|"id"/);
  });

  it.each([
    [
      'a byte-range array',
      { kind: 'user', seq: 0, text: 'ok', extra: BYTE_RANGE_ARRAY },
      'byte-range',
    ],
    ['a banned key', { kind: 'user', seq: 0, text: 'ok', frame: 1 }, 'denied key'],
    [
      'a denied field name',
      { seq: 0, kind: 'channel', event: 'x', fields: [{ name: 'raw', value: 1 }] },
      'name "raw"',
    ],
    ['a hex run in text', { seq: 0, kind: 'assistant', text: `see ${HEX_LOOKING}` }, 'hex run'],
    ['a base64 run in text', { seq: 0, kind: 'user', text: BASE64_LOOKING }, 'base64 run'],
    ...SHORT_HEX_LITERALS.flatMap((literal) => [
      [`${literal} in user text`, { seq: 0, kind: 'user', text: `try ${literal}` }, 'hex run'],
      [`${literal} in assistant text`, { seq: 0, kind: 'assistant', text: literal }, 'hex run'],
    ]),
  ])('refuses a hand-built transcript carrying %s', (_label, entry, reason) => {
    const transcript = {
      schema: 'voltras-agent-transcript/1',
      source: {
        kind: 'synthetic',
        exporter: 'export-agent-transcript',
        serverVersion: '0.0.0',
        exchange: 'x',
      },
      entries: [entry],
    };

    const act = () => assertScreenSafe(transcript);

    expect(act).toThrow(ScreenSafetyError);
    expect(act).toThrow(reason);
  });

  it('accepts a synthetic exchange script', () => {
    const script = {
      exchange: 'synthetic-connect-and-set',
      pinnedReps: 3,
      steps: [
        { user: 'Connect and start a set.' },
        { call: 'device.scan', args: {}, offscreen: true },
        {
          call: 'device.connect',
          args: { slot: 'primary' },
          showArgs: ['slot'],
          showResult: ['connected'],
        },
        { awaitChannel: 'rep_finalized', count: 1, showFields: ['rep_count'] },
      ],
    };

    expect(exchangeScriptSchema.safeParse(script).success).toBe(true);
  });
});
