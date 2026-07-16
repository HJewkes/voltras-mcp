// Unit tests for `system.listen_start` / `system.listen_stop`.
//
// Injects a fully-fake deps bundle (fake audio + fake VAD + fake whisper) via
// the VoiceListenerHolder, installs the real tool handlers, and exercises the
// user-visible behavior: schema validation, defaults/idempotence, teardown, and
// the channel publishes that a routed transcript produces.

import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@voltras/node-sdk', () => ({}));

const { registerVoiceTools, makeVoiceHolder } = await import('../voice-tools.js');

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ChannelEvent, ChannelPublisher } from '../../state/channel-publisher.js';
import type { AudioSource, Vad, VoiceListenerDeps } from '../../voice/voice-listener.js';
import type { ToolResult } from '../helpers.js';

type Callback = (args: unknown, extra?: unknown) => Promise<ToolResult>;

const FRAME_BYTES = 512 * 2;

interface Harness {
  start: Callback;
  stop: Callback;
  events: ChannelEvent[];
  audio: PassThrough;
  probs: number[];
  whisperTranscripts: string[];
}

function buildHarness(): Harness {
  const audio = new PassThrough();
  const probs: number[] = [];
  const vad: Vad = { process: async () => probs.shift() ?? 0, reset: vi.fn() };
  const whisperTranscripts: string[] = [];
  const deps: VoiceListenerDeps = {
    audioFactory: (): AudioSource => ({ stream: audio, stop: vi.fn() }),
    vadFactory: () => vad,
    whisper: async () => ({ transcript: whisperTranscripts.shift() ?? '' }),
    now: () => 1000,
  };
  const events: ChannelEvent[] = [];
  const publisher: ChannelPublisher = {
    publish: (e) => events.push(e),
    forSlot: () => publisher,
  };
  const holder = makeVoiceHolder(deps);

  const slots: { start?: Callback; stop?: Callback } = {};
  const placeholders = new Map<string, RegisteredTool>();
  for (const name of ['system.listen_start', 'system.listen_stop']) {
    placeholders.set(name, {
      update: ({ callback }: { callback?: Callback }) => {
        if (callback !== undefined)
          slots[name === 'system.listen_start' ? 'start' : 'stop'] = callback;
      },
    } as unknown as RegisteredTool);
  }
  registerVoiceTools({} as McpServer, { channels: publisher, voice: holder }, placeholders);
  if (slots.start === undefined || slots.stop === undefined) {
    throw new Error('callbacks not registered');
  }
  return { start: slots.start, stop: slots.stop, events, audio, probs, whisperTranscripts };
}

function payload(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function feedSegment(h: Harness, speech = 8, silence = 16): void {
  for (let i = 0; i < speech; i += 1) h.probs.push(0.9);
  for (let i = 0; i < silence; i += 1) h.probs.push(0);
  h.audio.emit('data', Buffer.alloc((speech + silence) * FRAME_BYTES));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }
}

describe('system.listen_start — schema validation', () => {
  it('rejects unknown sttModel values', async () => {
    const h = buildHarness();
    const result = await h.start({ sttModel: 'large.en' });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects removed wake-word fields (strict schema)', async () => {
    const h = buildHarness();
    const result = await h.start({ wakeWord: 'hey_jarvis' });
    expect(result.isError).toBe(true);
  });
});

describe('system.listen_start — defaults + idempotence', () => {
  it('returns listening status with default wake phrase + tiny.en', async () => {
    const h = buildHarness();
    const result = await h.start({});
    expect(result.isError).toBeUndefined();
    expect(payload(result)).toMatchObject({
      status: 'listening',
      wakePhrases: ['hey coach'],
      sttModel: 'tiny.en',
    });
  });

  it('honors user-supplied overrides', async () => {
    const h = buildHarness();
    const result = await h.start({ wakePhrases: ['trainer'], sttModel: 'small.en' });
    expect(payload(result)).toMatchObject({
      status: 'listening',
      wakePhrases: ['trainer'],
      sttModel: 'small.en',
    });
  });

  it('second listen_start while already listening returns the current state', async () => {
    const h = buildHarness();
    await h.start({ wakePhrases: ['first'] });
    const result = await h.start({ wakePhrases: ['second'] });
    expect(payload(result)).toMatchObject({ status: 'listening', wakePhrases: ['first'] });
  });
});

describe('system.listen_stop', () => {
  it('returns stopped status when nothing is running', async () => {
    const h = buildHarness();
    expect(payload(await h.stop({}))).toEqual({ status: 'stopped' });
  });

  it('rejects extra fields', async () => {
    const h = buildHarness();
    expect((await h.stop({ force: true })).isError).toBe(true);
  });

  it('tears down a running listener and is idempotent', async () => {
    const h = buildHarness();
    await h.start({});
    expect(payload(await h.stop({}))).toEqual({ status: 'stopped' });
    expect(payload(await h.stop({}))).toEqual({ status: 'stopped' });
  });
});

describe('system.listen_* — channel events', () => {
  it('publishes voice_input for a wake-phrase utterance', async () => {
    const h = buildHarness();
    await h.start({});
    h.whisperTranscripts.push('hey coach start a set');
    feedSegment(h);
    await settle();
    const inputs = h.events.filter((e) => e.meta.event_type === 'voice_input');
    expect(inputs).toHaveLength(1);
    expect(JSON.parse(inputs[0].content).transcript).toBe('start a set');
  });

  it('surfaces a safety phrase as voice_input too (the .78 unload hook lands later)', async () => {
    const h = buildHarness();
    await h.start({});
    h.whisperTranscripts.push('cut the weight');
    feedSegment(h);
    await settle();
    const inputs = h.events.filter((e) => e.meta.event_type === 'voice_input');
    expect(inputs).toHaveLength(1);
    expect(JSON.parse(inputs[0].content).transcript).toBe('cut the weight');
  });
});
