// Unit tests for `system.listen_start` / `system.listen_stop`.
//
// Pattern matches the tts-tools test fixture: build a fake placeholder map,
// install the real handler against it, then exercise the user-visible behavior
// (idempotence, error shapes, channel publishes on wake/voice events).

import { EventEmitter, PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@voltras/node-sdk', () => ({}));

const { registerVoiceTools, makeVoiceHolder } = await import('../voice-tools.js');

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ChannelEvent, ChannelPublisher } from '../../state/channel-publisher.js';
import type { AudioSource, VoiceListenerDeps, WakeSidecar } from '../../voice/voice-listener.js';
import type { ToolResult } from '../helpers.js';

type Callback = (args: unknown, extra?: unknown) => Promise<ToolResult>;

type PublishedEvent = ChannelEvent;

function makeChannelPublisher(): { publisher: ChannelPublisher; events: PublishedEvent[] } {
  const events: PublishedEvent[] = [];
  const publisher: ChannelPublisher = {
    publish: (event) => {
      events.push(event);
    },
    forSlot: () => publisher,
  };
  return { publisher, events };
}

function makeFakeAudio(): AudioSource & { stopCalled: boolean } {
  const stream = new PassThrough();
  let stopCalled = false;
  return {
    stream,
    stop: () => {
      stopCalled = true;
    },
    get stopCalled() {
      return stopCalled;
    },
  };
}

function makeFakeSidecar(): WakeSidecar & { emitJson: (obj: unknown) => void } {
  const stdin = new PassThrough();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  return {
    stdin,
    stdout: stdout as unknown as NodeJS.ReadableStream,
    stderr: stderr as unknown as NodeJS.ReadableStream,
    kill: () => undefined,
    emitJson: (obj: unknown) => {
      stdout.emit('data', JSON.stringify(obj) + '\n');
    },
  };
}

interface Harness {
  start: Callback;
  stop: Callback;
  events: PublishedEvent[];
  sidecar: WakeSidecar & { emitJson: (obj: unknown) => void };
}

interface FakeTimers {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  fireMostRecent: () => void;
}

function makeFakeTimers(): FakeTimers {
  const pending: Array<{ cb: () => void; cancelled: boolean }> = [];
  return {
    setTimeout: (cb) => {
      const entry = { cb, cancelled: false };
      pending.push(entry);
      return entry;
    },
    clearTimeout: (h) => {
      (h as { cancelled: boolean }).cancelled = true;
    },
    fireMostRecent: () => {
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        const e = pending[i];
        if (!e.cancelled) {
          e.cancelled = true;
          e.cb();
          return;
        }
      }
    },
  };
}

function buildHarness(): Harness {
  const audio = makeFakeAudio();
  const sidecar = makeFakeSidecar();
  const timers = makeFakeTimers();
  const deps: VoiceListenerDeps = {
    audioFactory: () => audio,
    sidecarFactory: () => sidecar,
    whisper: vi.fn().mockResolvedValue({ transcript: 'switch to rowing' }),
    timers,
  };
  const { publisher, events } = makeChannelPublisher();
  const holder = makeVoiceHolder(deps);

  const slots: { start?: Callback; stop?: Callback } = {};
  const placeholders = new Map<string, RegisteredTool>();
  placeholders.set('system.listen_start', {
    update: ({ callback }: { callback?: Callback }) => {
      if (callback !== undefined) slots.start = callback;
    },
  } as unknown as RegisteredTool);
  placeholders.set('system.listen_stop', {
    update: ({ callback }: { callback?: Callback }) => {
      if (callback !== undefined) slots.stop = callback;
    },
  } as unknown as RegisteredTool);

  registerVoiceTools({} as McpServer, { channels: publisher, voice: holder }, placeholders);

  if (slots.start === undefined || slots.stop === undefined) {
    throw new Error('callbacks not registered');
  }
  return {
    start: slots.start,
    stop: slots.stop,
    events,
    sidecar,
  };
}

function payload(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe('system.listen_start — schema validation', () => {
  it('rejects unknown sttModel values', async () => {
    const h = buildHarness();
    const result = await h.start({ sttModel: 'large.en' });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects extra fields', async () => {
    const h = buildHarness();
    const result = await h.start({ wakeWord: 'hey_jarvis', bogus: true });
    expect(result.isError).toBe(true);
  });
});

describe('system.listen_start — defaults + idempotence', () => {
  it('returns listening status with default wake word + STT model', async () => {
    const h = buildHarness();
    const result = await h.start({});
    expect(result.isError).toBeUndefined();
    expect(payload(result)).toMatchObject({
      status: 'listening',
      wakeWord: 'hey_jarvis',
      sttModel: 'base.en',
    });
  });

  it('honors user-supplied overrides', async () => {
    const h = buildHarness();
    const result = await h.start({ wakeWord: 'alexa', sttModel: 'small.en' });
    expect(payload(result)).toMatchObject({
      status: 'listening',
      wakeWord: 'alexa',
      sttModel: 'small.en',
    });
  });

  it('second listen_start while already listening returns the current state', async () => {
    const h = buildHarness();
    await h.start({ wakeWord: 'hey_jarvis' });
    const result = await h.start({ wakeWord: 'alexa' });
    // The second call doesn't reconfigure — we still see the first wake word
    expect(payload(result)).toMatchObject({ status: 'listening', wakeWord: 'hey_jarvis' });
  });
});

describe('system.listen_stop', () => {
  it('returns stopped status when nothing is running', async () => {
    const h = buildHarness();
    const result = await h.stop({});
    expect(payload(result)).toEqual({ status: 'stopped' });
  });

  it('rejects extra fields', async () => {
    const h = buildHarness();
    const result = await h.stop({ force: true });
    expect(result.isError).toBe(true);
  });

  it('tears down a running listener and is idempotent', async () => {
    const h = buildHarness();
    await h.start({});
    const stop1 = await h.stop({});
    const stop2 = await h.stop({});
    expect(payload(stop1)).toEqual({ status: 'stopped' });
    expect(payload(stop2)).toEqual({ status: 'stopped' });
  });
});

describe('system.listen_* — channel events', () => {
  it('publishes wake_word_detected when the sidecar fires a wake', async () => {
    const h = buildHarness();
    await h.start({});
    h.sidecar.emitJson({ event: 'wake', ts: 100, score: 0.91, model: 'hey_jarvis' });
    const wakes = h.events.filter((e) => e.meta.event_type === 'wake_word_detected');
    expect(wakes).toHaveLength(1);
    expect(wakes[0].meta.wake_word).toBe('hey_jarvis');
  });
});
