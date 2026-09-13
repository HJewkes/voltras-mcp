// The `coach_line` push event (VW-289): one spoken line, one event.
//
// The property under test is the DEDUP one. `system.speak` and the deterministic cue
// emitter are two entry points, and they both reach the same `speak()` — hooking the
// emission at either caller instead would double-count whichever path also went through
// the other, so this drives the real tool callback and counts the events it produced.

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@voltras/node-sdk', () => ({}));

const { registerSystemTools, __resetSpeakState } = await import('../../tools/tts-tools.js');
const { publishCoachLine } = await import('../event-bridge.js');

import type { ChildProcess } from 'node:child_process';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolResult } from '../../tools/helpers.js';
import type { ChannelEvent, ChannelPublisher } from '../channel-publisher.js';
import { LiveSignalHub, type LiveSignalEvent } from '../live-signal.js';

type Callback = (args: unknown, extra?: unknown) => Promise<ToolResult>;

class RecordingPublisher implements ChannelPublisher {
  readonly events: ChannelEvent[] = [];
  publish(event: ChannelEvent): void {
    this.events.push(event);
  }
  forSlot(): ChannelPublisher {
    return this;
  }
}

interface Harness {
  speak: Callback;
  channels: RecordingPublisher;
  signals: LiveSignalEvent[];
  /** Spawned `say` children, so a test can end one line before the next (VW-170). */
  children: EventEmitter[];
}

/** The real `system.speak` handler, wired to the real `publishCoachLine`. */
function buildHarness(): Harness {
  __resetSpeakState();
  const channels = new RecordingPublisher();
  const liveSignals = new LiveSignalHub();
  const signals: LiveSignalEvent[] = [];
  liveSignals.subscribe((event) => signals.push(event));

  const slot: { callback?: Callback } = {};
  const placeholders = new Map<string, RegisteredTool>();
  placeholders.set('system.speak', {
    update: ({ callback }: { callback?: Callback }) => {
      if (callback !== undefined) slot.callback = callback;
    },
  } as unknown as RegisteredTool);

  const children: EventEmitter[] = [];
  registerSystemTools(
    {} as McpServer,
    placeholders,
    {
      platform: 'darwin',
      spawn: () => {
        const child = new EventEmitter();
        children.push(child);
        return child as unknown as ChildProcess;
      },
    },
    null,
    (line) => publishCoachLine({ channels, liveSignals }, line),
  );
  if (slot.callback === undefined) throw new Error('callback was not registered');
  return { speak: slot.callback, channels, signals, children };
}

function coachLines(channels: RecordingPublisher): ChannelEvent[] {
  return channels.events.filter((e) => e.meta.event_type === 'coach_line');
}

describe('coach_line push event (VW-289)', () => {
  it('publishes exactly one event for one system.speak call', async () => {
    const h = buildHarness();

    await h.speak({ text: 'two reps to go' });

    const lines = coachLines(h.channels);
    expect(lines).toHaveLength(1);
    expect(h.channels.events).toHaveLength(1);
    const payload = JSON.parse(lines[0].content) as {
      coach_line: { text: string; source: string; occurredAt: number };
    };
    expect(payload.coach_line.text).toBe('two reps to go');
    expect(payload.coach_line.source).toBe('speak');
    expect(payload.coach_line.occurredAt).toBeGreaterThan(0);
  });

  it('echoes the same line onto the live-signal hub for the wall caption', async () => {
    const h = buildHarness();

    await h.speak({ text: 'rest is up' });

    expect(h.signals).toEqual([
      {
        type: 'coach_line',
        data: { text: 'rest is up', source: 'speak', occurredAt: expect.any(Number) },
      },
    ]);
  });

  it('publishes one event per call, not one per listener the child later fires', async () => {
    const h = buildHarness();

    await h.speak({ text: 'first' });
    // The two lines are serialised (VW-170), so the first has to finish before
    // the second is spoken at all.
    const second = h.speak({ text: 'second' });
    h.children[0].emit('exit', 0);
    await second;

    expect(coachLines(h.channels).map((e) => JSON.parse(e.content).coach_line.text)).toEqual([
      'first',
      'second',
    ]);
  });

  it('publishes nothing when the say binary cannot be spawned', async () => {
    __resetSpeakState();
    const channels = new RecordingPublisher();
    const slot: { callback?: Callback } = {};
    const placeholders = new Map<string, RegisteredTool>();
    placeholders.set('system.speak', {
      update: ({ callback }: { callback?: Callback }) => {
        if (callback !== undefined) slot.callback = callback;
      },
    } as unknown as RegisteredTool);
    registerSystemTools(
      {} as McpServer,
      placeholders,
      {
        platform: 'darwin',
        spawn: () => {
          throw new Error('ENOENT');
        },
      },
      null,
      (line) => publishCoachLine({ channels }, line),
    );

    await slot.callback?.({ text: 'unheard' });

    expect(coachLines(channels)).toHaveLength(0);
  });
});
