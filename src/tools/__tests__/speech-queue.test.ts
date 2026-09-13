// The single speech queue (VW-170).
//
// `say` does not queue: two overlapping spawns play over each other. Both
// speech producers — the `system.speak` tool and the deterministic cue emitter
// — go through `speak()`, so these tests drive BOTH through their real
// registered paths (no injected speak spy) against one fake `say` and assert
// that the resulting playback intervals never overlap.
//
// The fake child exits on a real timer, so an un-serialised implementation
// genuinely overlaps here rather than being hidden by synchronous test timing.

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@voltras/node-sdk', () => ({}));

const { registerSystemTools, __resetSpeakState } = await import('../tts-tools.js');
const { CueEmitter } = await import('../../voice/cue-emitter.js');

import type { ChildProcess } from 'node:child_process';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CueSelector } from '../../voice/cue-templates.js';
import type { ChannelEvent } from '../../state/channel-publisher.js';
import type { SpeakDeps } from '../tts-tools.js';
import type { ToolResult } from '../helpers.js';

type Callback = (args: unknown, extra?: unknown) => Promise<ToolResult>;

/** How long one fake utterance "plays" before its child exits. */
const PLAYBACK_MS = 5;

class FakeChild extends EventEmitter {
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

interface Utterance {
  text: string;
  start: number;
  end: number | null;
  killed: boolean;
}

interface Harness {
  /** The real `system.speak` callback, as registered on the placeholder. */
  speakTool: Callback;
  /** A real cue emitter over the same fake `say`, with cues fully on. */
  emitter: InstanceType<typeof CueEmitter>;
  utterances: Utterance[];
  /** Resolve once `count` utterances have started and all have finished. */
  drain: (count: number) => Promise<void>;
}

function buildHarness(): Harness {
  const utterances: Utterance[] = [];

  const spawn: SpeakDeps['spawn'] = (_command, args) => {
    const child = new FakeChild();
    const record: Utterance = {
      text: String(args[args.length - 1]),
      start: performance.now(),
      end: null,
      killed: false,
    };
    utterances.push(record);
    setTimeout(() => {
      record.end = performance.now();
      record.killed = child.killed;
      child.emit('exit', child.killed ? null : 0);
    }, PLAYBACK_MS);
    return child as unknown as ChildProcess;
  };

  const deps: SpeakDeps = { platform: 'darwin', spawn };

  const slot: { callback?: Callback } = {};
  const placeholders = new Map<string, RegisteredTool>();
  placeholders.set('system.speak', {
    update: ({ callback }: { callback?: Callback }) => {
      if (callback !== undefined) slot.callback = callback;
    },
  } as unknown as RegisteredTool);
  registerSystemTools({} as McpServer, placeholders, deps);
  if (slot.callback === undefined) throw new Error('system.speak was not registered');

  return {
    speakTool: slot.callback,
    emitter: new CueEmitter({
      speakDeps: deps,
      selector: new CueSelector({ rng: () => 0 }),
      settings: { enabled: true, midSetEnabled: true },
    }),
    utterances,
    drain: async (count) => {
      const deadline = performance.now() + 2000;
      while (performance.now() < deadline) {
        const settled = utterances.length >= count && utterances.every((u) => u.end !== null);
        if (settled) return;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      throw new Error(`drain timed out with ${utterances.length}/${count} utterances`);
    },
  };
}

function event(
  eventType: string,
  meta: Record<string, string>,
  content: unknown = {},
): ChannelEvent {
  return { meta: { event_type: eventType, ...meta }, content: JSON.stringify(content) };
}

/** Two non-urgent cue categories, so neither cue takes the interrupt path. */
const setStarted = (): ChannelEvent =>
  event(
    'set_started',
    { set_id: 's1', weight_lbs: '100' },
    { summary: 'Set started: 100 lbs WeightTraining (set 3 of session)' },
  );
const setEnded = (): ChannelEvent =>
  event('set_ended', { set_id: 's1', rep_count: '8', duration_ms: '45000' });

function payload(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe('speech queue — cues and system.speak share one speaker', () => {
  afterEach(() => {
    __resetSpeakState();
  });

  it('plays concurrent cue and system.speak lines strictly one at a time', async () => {
    const harness = buildHarness();

    // Interleave the two producers without awaiting between them: this is the
    // shape that overlapped before the queue existed.
    const first = harness.speakTool({ text: 'manual one' });
    harness.emitter.onEvent(setStarted());
    const second = harness.speakTool({ text: 'manual two' });
    harness.emitter.onEvent(setEnded());

    await Promise.all([first, second]);
    await harness.drain(4);

    expect(harness.utterances).toHaveLength(4);
    for (let i = 1; i < harness.utterances.length; i += 1) {
      const previous = harness.utterances[i - 1]!;
      const current = harness.utterances[i]!;
      expect(current.start).toBeGreaterThanOrEqual(previous.end!);
    }
  });

  it('plays them in the order they were asked for', async () => {
    const harness = buildHarness();

    const first = harness.speakTool({ text: 'manual one' });
    harness.emitter.onEvent(setStarted());
    const second = harness.speakTool({ text: 'manual two' });
    harness.emitter.onEvent(setEnded());

    await Promise.all([first, second]);
    await harness.drain(4);

    const texts = harness.utterances.map((u) => u.text);
    expect(texts[0]).toBe('manual one');
    expect(texts[2]).toBe('manual two');
    // The two cue lines are rendered by the emitter; what matters here is that
    // they landed in the slots between the manual ones, not what they say.
    expect(texts[1]).not.toBe('');
    expect(texts[3]).toContain('8');
  });

  it('never lets a cue start while a manual line is still playing', async () => {
    const harness = buildHarness();

    const manual = harness.speakTool({ text: 'manual only' });
    harness.emitter.onEvent(setStarted());

    // The cue was asked for while the manual line was mid-playback, so only
    // the manual line has been spawned at this point.
    await manual;
    expect(harness.utterances).toHaveLength(1);

    await harness.drain(2);
    expect(harness.utterances[1]!.start).toBeGreaterThanOrEqual(harness.utterances[0]!.end!);
  });
});

describe('speech queue — the interrupt flush stays immediate', () => {
  afterEach(() => {
    __resetSpeakState();
  });

  it('speaks a stop-phrase ack at once and drops the lines still queued', async () => {
    const harness = buildHarness();

    await harness.speakTool({ text: 'long line' });
    const queuedCue = harness.speakTool({ text: 'queued one' });
    harness.emitter.onEvent(setStarted());

    const ack = await harness.speakTool({ text: 'stopping', interrupt: true });

    // Spawned without waiting for the playing line to finish, and it killed it.
    expect(harness.utterances).toHaveLength(2);
    expect(harness.utterances[1]!.text).toBe('stopping');
    expect(payload(ack)).toEqual({ ok: true });

    const dropped = await queuedCue;
    expect(payload(dropped)).toEqual({ ok: true, spoken: false });

    await harness.drain(2);
    expect(harness.utterances.map((u) => u.text)).toEqual(['long line', 'stopping']);
  });

  it('keeps serialising lines asked for after a flush', async () => {
    const harness = buildHarness();

    await harness.speakTool({ text: 'first' });
    await harness.speakTool({ text: 'stopping', interrupt: true });
    const after = harness.speakTool({ text: 'after the flush' });

    // The ack is still playing, so the next line waits rather than layering.
    expect(harness.utterances).toHaveLength(2);
    await after;
    await harness.drain(3);

    expect(harness.utterances.map((u) => u.text)).toEqual(['first', 'stopping', 'after the flush']);
    expect(harness.utterances[2]!.start).toBeGreaterThanOrEqual(harness.utterances[1]!.end!);
  });
});
