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
import type { VoiceSafetyContext } from '../voice-tools.js';

type Callback = (args: unknown, extra?: unknown) => Promise<ToolResult>;

const FRAME_BYTES = 512 * 2;

interface Harness {
  start: Callback;
  stop: Callback;
  events: ChannelEvent[];
  audio: PassThrough;
  probs: number[];
  whisperTranscripts: string[];
  /** One entry per mic open, recording whether that source was ever stopped. */
  micOpens: { stopped: boolean }[];
}

function buildHarness(
  safety: VoiceSafetyContext | null = null,
  depsOverride: Partial<VoiceListenerDeps> = {},
): Harness {
  const audio = new PassThrough();
  const probs: number[] = [];
  const vad: Vad = { process: async () => probs.shift() ?? 0, reset: vi.fn() };
  const whisperTranscripts: string[] = [];
  const micOpens: { stopped: boolean }[] = [];
  const deps: VoiceListenerDeps = {
    audioFactory: (): AudioSource => {
      const open = { stopped: false };
      micOpens.push(open);
      return {
        stream: audio,
        stop: () => {
          open.stopped = true;
        },
      };
    },
    vadFactory: () => vad,
    whisper: async () => ({ transcript: whisperTranscripts.shift() ?? '' }),
    now: () => 1000,
    // Fake mic never delivers until a test emits; keep start() off the real bound.
    micReadyTimeoutMs: 0,
    ...depsOverride,
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
  registerVoiceTools({} as McpServer, { channels: publisher, voice: holder }, placeholders, safety);
  if (slots.start === undefined || slots.stop === undefined) {
    throw new Error('callbacks not registered');
  }
  return {
    start: slots.start,
    stop: slots.stop,
    events,
    audio,
    probs,
    whisperTranscripts,
    micOpens,
  };
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

  it('with no safety context, a safety phrase falls back to voice_input', async () => {
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

interface FakeSafety {
  ctx: VoiceSafetyContext;
  unloadCalls: string[];
  acks: string[];
}

function fakeSafety(over?: Partial<VoiceSafetyContext>): FakeSafety {
  const unloadCalls: string[] = [];
  const acks: string[] = [];
  const ctx: VoiceSafetyContext = {
    connectedSlots: over?.connectedSlots ?? (() => ['primary']),
    evaluate: over?.evaluate ?? (() => ({ warranted: true, reason: 'active_set', setId: 'set-1' })),
    unload:
      over?.unload ??
      (async (slotId: string) => {
        unloadCalls.push(slotId);
      }),
    speakAck: over?.speakAck ?? ((text: string) => acks.push(text)),
  };
  return { ctx, unloadCalls, acks };
}

/**
 * Safety context over a set of bound slots, mirroring the real one built by
 * `makeVoiceSafety`: `evaluate` on an unbound slot THROWS, exactly as
 * `getSlot` does. That is the behavior VMCP-02.86 tripped over.
 */
function slotAwareSafety(
  bound: Record<string, { warranted: boolean; reason: string; setId: string | null }>,
): FakeSafety {
  return fakeSafety({
    connectedSlots: () => Object.keys(bound),
    evaluate: (slotId: string) => {
      const verdict = bound[slotId];
      if (verdict === undefined) throw new Error(`Unknown slot: ${slotId}`);
      return verdict;
    },
  });
}

async function driveSafetyPhrase(h: Harness): Promise<void> {
  await h.start({});
  h.whisperTranscripts.push('cut the weight');
  feedSegment(h);
  await settle();
}

describe('Tier-A safety fast-path (VMCP-02.78)', () => {
  it('warranted → unloads, acks, publishes deterministic_stop_triggered, no voice_input', async () => {
    const safety = fakeSafety();
    const h = buildHarness(safety.ctx);
    await driveSafetyPhrase(h);

    expect(safety.unloadCalls).toEqual(['primary']);
    expect(safety.acks).toHaveLength(1);
    const stops = h.events.filter((e) => e.meta.event_type === 'deterministic_stop_triggered');
    expect(stops).toHaveLength(1);
    expect(stops[0].meta).toMatchObject({
      matched_phrase: 'cut the weight',
      predicate_reason: 'active_set',
      slot: 'primary',
      set_id: 'set-1',
      unloaded: 'true',
    });
    expect(h.events.some((e) => e.meta.event_type === 'voice_input')).toBe(false);
  });

  it('not warranted → no unload, falls back to voice_input', async () => {
    const safety = fakeSafety({
      evaluate: () => ({ warranted: false, reason: 'none', setId: null }),
    });
    const h = buildHarness(safety.ctx);
    await driveSafetyPhrase(h);

    expect(safety.unloadCalls).toEqual([]);
    expect(h.events.filter((e) => e.meta.event_type === 'voice_input')).toHaveLength(1);
    expect(h.events.some((e) => e.meta.event_type === 'deterministic_stop_triggered')).toBe(false);
  });

  it('unload failure → voice_input + SAFETY_UNLOAD_FAILED, no stop event', async () => {
    const safety = fakeSafety({
      unload: () => Promise.reject(new Error('BLE write failed')),
    });
    const h = buildHarness(safety.ctx);
    await driveSafetyPhrase(h);

    expect(h.events.filter((e) => e.meta.event_type === 'voice_input')).toHaveLength(1);
    const failed = h.events.filter((e) => e.meta.error_code === 'SAFETY_UNLOAD_FAILED');
    expect(failed).toHaveLength(1);
    expect(safety.acks).toEqual([]);
    expect(h.events.some((e) => e.meta.event_type === 'deterministic_stop_triggered')).toBe(false);
  });

  it('evaluate throwing (unknown slot) → conversational voice_input fallback', async () => {
    const safety = fakeSafety({
      evaluate: () => {
        throw new Error('unknown slot');
      },
    });
    const h = buildHarness(safety.ctx);
    await driveSafetyPhrase(h);

    expect(safety.unloadCalls).toEqual([]);
    expect(h.events.filter((e) => e.meta.event_type === 'voice_input')).toHaveLength(1);
  });
});

// VMCP-02.86, the hardware defect: the fast-path targeted a hardcoded
// `primary` slot, so a rig bound to left/right unloaded nothing AND looked
// exactly like ordinary speech on the wire. Reproduced twice on VTR-212006.
describe('Tier-A safety fast-path — slot resolution (VMCP-02.86)', () => {
  function stops(h: Harness): ChannelEvent[] {
    return h.events.filter((e) => e.meta.event_type === 'deterministic_stop_triggered');
  }
  function unavailable(h: Harness): ChannelEvent[] {
    return h.events.filter((e) => e.meta.event_type === 'deterministic_stop_unavailable');
  }

  it('device on `right` only, mid-set → unloads right and publishes the stop', async () => {
    const safety = slotAwareSafety({
      right: { warranted: true, reason: 'active_set', setId: 'set-9' },
    });
    const h = buildHarness(safety.ctx);
    await driveSafetyPhrase(h);

    expect(safety.unloadCalls).toEqual(['right']);
    expect(safety.acks).toHaveLength(1);
    expect(stops(h)).toHaveLength(1);
    expect(stops(h)[0].meta).toMatchObject({
      slot: 'right',
      set_id: 'set-9',
      predicate_reason: 'active_set',
      trigger: 'warranted',
      unloaded: 'true',
    });
    expect(h.events.some((e) => e.meta.event_type === 'voice_input')).toBe(false);
  });

  it('bilateral: one warranted side cuts BOTH cables', async () => {
    const safety = slotAwareSafety({
      left: { warranted: true, reason: 'active_set', setId: 'set-L' },
      right: { warranted: false, reason: 'none', setId: null },
    });
    const h = buildHarness(safety.ctx);
    await driveSafetyPhrase(h);

    expect(safety.unloadCalls.sort()).toEqual(['left', 'right']);
    expect(safety.acks).toHaveLength(1);
    const bySlot = Object.fromEntries(stops(h).map((e) => [e.meta.slot, e.meta]));
    expect(bySlot.left).toMatchObject({ trigger: 'warranted', predicate_reason: 'active_set' });
    expect(bySlot.right).toMatchObject({ trigger: 'bilateral_sweep' });
  });

  it('one side failing to unload still reports the side that was cut', async () => {
    const unloadCalls: string[] = [];
    const safety = fakeSafety({
      connectedSlots: () => ['left', 'right'],
      evaluate: () => ({ warranted: true, reason: 'active_set', setId: 'set-1' }),
      unload: async (slotId: string) => {
        unloadCalls.push(slotId);
        if (slotId === 'right') throw new Error('BLE write failed');
      },
    });
    const h = buildHarness(safety.ctx);
    await driveSafetyPhrase(h);

    expect(unloadCalls.sort()).toEqual(['left', 'right']);
    expect(stops(h).map((e) => e.meta.slot)).toEqual(['left']);
    const failed = h.events.filter((e) => e.meta.error_code === 'SAFETY_UNLOAD_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0].meta.slot).toBe('right');
  });

  it('nothing warranted → loud deterministic_stop_unavailable, not a bare voice_input', async () => {
    const safety = slotAwareSafety({
      right: { warranted: false, reason: 'none', setId: null },
    });
    const h = buildHarness(safety.ctx);
    await driveSafetyPhrase(h);

    expect(safety.unloadCalls).toEqual([]);
    expect(unavailable(h)).toHaveLength(1);
    expect(unavailable(h)[0].meta).toMatchObject({
      matched_phrase: 'cut the weight',
      reason: 'not_warranted',
      slot: 'right',
      unloaded: 'false',
    });
    expect(JSON.parse(unavailable(h)[0].content)).toMatchObject({
      transcript: 'cut the weight',
      evaluated_slots: [{ slot: 'right', reason: 'none' }],
    });
    expect(h.events.filter((e) => e.meta.event_type === 'voice_input')).toHaveLength(1);
  });

  it('no device connected → unavailable with reason no_connected_slot', async () => {
    const safety = slotAwareSafety({});
    const h = buildHarness(safety.ctx);
    await driveSafetyPhrase(h);

    expect(unavailable(h)[0].meta.reason).toBe('no_connected_slot');
    expect(unavailable(h)[0].meta.slot).toBeUndefined();
  });

  it('no safety context wired → unavailable with reason no_safety_context', async () => {
    const h = buildHarness();
    await driveSafetyPhrase(h);

    expect(unavailable(h)).toHaveLength(1);
    expect(unavailable(h)[0].meta.reason).toBe('no_safety_context');
  });

  it('every connected slot unwarranted-by-throw → reason evaluate_failed', async () => {
    const safety = fakeSafety({
      connectedSlots: () => ['right'],
      evaluate: () => {
        throw new Error('Unknown slot: right');
      },
    });
    const h = buildHarness(safety.ctx);
    await driveSafetyPhrase(h);

    expect(unavailable(h)[0].meta.reason).toBe('evaluate_failed');
  });
});

// The hardware defect, end to end (VMCP-02.83): whisper's real output carries
// timestamp markup, which spent the safety word budget and silently downgraded
// a reflexive "wait stop the weight" to ambient speech — no unload. These drive
// the whole tool path with the exact strings captured on the bench.
describe('Tier-A safety fast-path — whisper timestamp markup', () => {
  const TIMESTAMP = '[00:00:00.000 --> 00:00:00.840]';

  async function drive(h: Harness, transcript: string): Promise<void> {
    await h.start({});
    h.whisperTranscripts.push(transcript);
    feedSegment(h);
    await settle();
  }

  it('unloads on a timestamped reflexive utterance', async () => {
    const safety = fakeSafety();
    const h = buildHarness(safety.ctx);
    await drive(h, `${TIMESTAMP}   wait stop the weight`);
    expect(safety.unloadCalls).toEqual(['primary']);
  });

  it('unloads on a timestamped bare stop', async () => {
    const safety = fakeSafety();
    const h = buildHarness(safety.ctx);
    await drive(h, `${TIMESTAMP}   Stop.`);
    expect(safety.unloadCalls).toEqual(['primary']);
  });

  it('reaches the same verdict with and without the markup', async () => {
    for (const bare of ['Stop.', 'wait stop the weight']) {
      const withMarkup = fakeSafety();
      const without = fakeSafety();
      await drive(buildHarness(withMarkup.ctx), `${TIMESTAMP}   ${bare}`);
      await drive(buildHarness(without.ctx), bare);
      expect(withMarkup.unloadCalls).toEqual(without.unloadCalls);
    }
  });

  it('keeps the negation gate closed through the markup', async () => {
    const safety = fakeSafety();
    const h = buildHarness(safety.ctx);
    await drive(h, `${TIMESTAMP}   don't stop`);
    expect(safety.unloadCalls).toEqual([]);
    expect(h.events.some((e) => e.meta.event_type === 'deterministic_stop_triggered')).toBe(false);
  });

  it('keeps the conversational gate closed through the markup', async () => {
    const safety = fakeSafety();
    const h = buildHarness(safety.ctx);
    await drive(h, `${TIMESTAMP}   we can stop after this set`);
    expect(safety.unloadCalls).toEqual([]);
  });

  it('keeps the idle gate closed through the markup (nothing loaded)', async () => {
    const safety = fakeSafety({
      evaluate: () => ({ warranted: false, reason: 'no_active_set', setId: null }),
    });
    const h = buildHarness(safety.ctx);
    await drive(h, `${TIMESTAMP}   wait stop the weight`);
    expect(safety.unloadCalls).toEqual([]);
  });

  it('publishes a markup-free transcript', async () => {
    const h = buildHarness();
    await drive(h, `${TIMESTAMP}   Stop.`);
    const inputs = h.events.filter((e) => e.meta.event_type === 'voice_input');
    expect(inputs).toHaveLength(1);
    expect(JSON.parse(inputs[0].content).transcript).not.toContain('-->');
  });
});

// Arming the mic is when we want to pay the STT cold-start cost, so the warm-up
// must stay strictly off the critical path: one that fails or never returns must
// not stop `system.listen_start` from arming.
describe('system.listen_start — STT pre-warm', () => {
  const stalls = (): Promise<void> => new Promise<void>(() => {});
  const fails = async (): Promise<void> => {
    throw new Error('whisper not installed');
  };

  it('arms when the pre-warm never settles', async () => {
    const h = buildHarness(null, { prewarm: stalls });
    expect(payload(await h.start({}))).toMatchObject({ status: 'listening' });
  });

  it('arms when the pre-warm rejects', async () => {
    const h = buildHarness(null, { prewarm: fails });
    expect(payload(await h.start({}))).toMatchObject({ status: 'listening' });
  });

  it('still unloads on a safety phrase after a failed pre-warm', async () => {
    const safety = fakeSafety();
    const h = buildHarness(safety.ctx, { prewarm: fails });
    await driveSafetyPhrase(h);
    expect(safety.unloadCalls).toEqual(['primary']);
  });
});

// VMCP-05.17: `listening` must mean "can hear you". A mic that never opens
// still has to arm — bounded and logged — rather than hang listen_start.
describe('system.listen_start — mic readiness', () => {
  it('arms when the mic never delivers audio within the bound', async () => {
    const h = buildHarness(null, { micReadyTimeoutMs: 20 });
    expect(payload(await h.start({}))).toMatchObject({ status: 'listening' });
  });

  // Armed-but-deaf is otherwise only visible in a server log the caller never
  // reads — it has to be in-band on the safety path.
  it('reports micReady so an armed-but-deaf mic is visible to the caller', async () => {
    const deaf = buildHarness(null, { micReadyTimeoutMs: 20 });
    expect(payload(await deaf.start({}))).toMatchObject({
      status: 'listening',
      micReady: false,
    });

    const live = buildHarness(null, { micReadyTimeoutMs: 10_000 });
    const starting = live.start({});
    await settle();
    live.audio.emit('data', Buffer.alloc(1024));
    expect(payload(await starting)).toMatchObject({ status: 'listening', micReady: true });
  });

  it('arms once the mic goes live and still unloads on a safety phrase', async () => {
    const safety = fakeSafety();
    const h = buildHarness(safety.ctx, { micReadyTimeoutMs: 10_000 });
    const starting = h.start({});
    await new Promise((r) => setImmediate(r));
    h.audio.emit('data', Buffer.alloc(1024));
    expect(payload(await starting)).toMatchObject({ status: 'listening' });
    await driveSafetyPhrase(h);
    expect(safety.unloadCalls).toEqual(['primary']);
  });

  // Gating start() on the mic widened the arming window from ~25 ms to
  // ~530 ms, so the tool now has a real concurrency surface: `listener` is
  // only installed once start() resolves. Without an in-flight guard a second
  // listen_start walks the null branch and opens a SECOND sox recorder, and
  // the loser of the race is leaked — still wired, still routing safety
  // phrases, never stopped.
  it('does not open a second mic when listen_start is called while still arming', async () => {
    const h = buildHarness(null, { micReadyTimeoutMs: 10_000 });
    const first = h.start({});
    await settle();
    const second = h.start({});
    await settle();
    h.audio.emit('data', Buffer.alloc(1024));
    expect(payload(await first)).toMatchObject({ status: 'listening' });
    expect(payload(await second)).toMatchObject({ status: 'listening' });
    expect(h.micOpens).toHaveLength(1);
  });

  // Safety-relevant: listen_stop must not report `stopped` while a mic that
  // is still arming goes on to arm behind it.
  it('stops the mic when listen_stop races a still-arming listen_start', async () => {
    const h = buildHarness(null, { micReadyTimeoutMs: 50 });
    const starting = h.start({});
    await settle();
    expect(payload(await h.stop({}))).toMatchObject({ status: 'stopped' });
    // The racing arm must not hand back a mic the stop already turned off.
    expect(payload(await starting)).toMatchObject({ status: 'stopped' });
    await settle();
    expect(h.micOpens).toHaveLength(1);
    expect(h.micOpens[0].stopped).toBe(true);
  });
});

// The bench saw latency_ms: 0 / audio_duration_ms: 0 on every event because the
// safety fallback published hardcoded zeros — and because the markup defect
// routed EVERY bench utterance down that one path, the zeros showed up on every
// event we saw, making the instrumentation look globally broken when only the
// safety branch was. The deaf-window safety measurement depends on these.
describe('voice_input timing instrumentation', () => {
  function advancingClock(): () => number {
    let t = 1000;
    return () => (t += 50);
  }

  it('reports measured latency on the safety fallback path', async () => {
    const safety = fakeSafety({
      evaluate: () => ({ warranted: false, reason: 'no_active_set', setId: null }),
    });
    const h = buildHarness(safety.ctx, { now: advancingClock() });
    await h.start({});
    h.whisperTranscripts.push('stop');
    feedSegment(h);
    await settle();

    const content = JSON.parse(
      h.events.filter((e) => e.meta.event_type === 'voice_input')[0].content,
    ) as { latency_ms: number; audio_duration_ms: number };
    expect(content.latency_ms).toBeGreaterThan(0);
    expect(content.audio_duration_ms).toBeGreaterThan(0);
  });

  it('reports measured latency on the wake path', async () => {
    const h = buildHarness(null, { now: advancingClock() });
    await h.start({});
    h.whisperTranscripts.push('hey coach start a set');
    feedSegment(h);
    await settle();

    const event = h.events.filter((e) => e.meta.event_type === 'voice_input')[0];
    const content = JSON.parse(event.content) as {
      latency_ms: number;
      audio_duration_ms: number;
    };
    expect(content.latency_ms).toBeGreaterThan(0);
    expect(content.audio_duration_ms).toBeGreaterThan(0);
    expect(event.meta.latency_ms).not.toBe('0');
  });
});
