// Unit tests for `debug.recent_frames` and `debug.recent_events`.
//
// The tools read from a process-local singleton ring buffer, so the test
// resets the singleton between cases via `_resetDebugBuffersForTest`. We
// drive the buffer directly (no event-bridge in the loop) — the bridge's
// own tests verify it appends correctly; here we verify the tool boundary.

import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('@voltras/node-sdk', () => ({}));

const { _resetDebugBuffersForTest, getDebugBuffers } = await import('../../state/debug-buffer.js');
const { registerDebugTools } = await import('../debug-tools.js');

interface FakeRegisteredTool {
  callback?: (args: unknown, extra?: unknown) => Promise<unknown>;
  update(updates: { callback: (args: unknown, extra?: unknown) => Promise<unknown> }): void;
}

function makePlaceholders(names: string[]): {
  placeholders: Map<string, FakeRegisteredTool>;
  invoke: (
    name: string,
    args: unknown,
  ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
} {
  const placeholders = new Map<string, FakeRegisteredTool>();
  for (const name of names) {
    const tool: FakeRegisteredTool = {
      update(updates) {
        tool.callback = updates.callback;
      },
    };
    placeholders.set(name, tool);
  }
  return {
    placeholders,
    invoke: async (name, args) => {
      const cb = placeholders.get(name)?.callback;
      if (!cb) throw new Error(`no callback for ${name}`);
      return cb(args) as Promise<{ content: { text: string }[]; isError?: boolean }>;
    },
  };
}

describe('debug.recent_frames', () => {
  beforeEach(() => {
    _resetDebugBuffersForTest();
  });

  it('returns an empty list when the buffer is fresh', async () => {
    const { placeholders, invoke } = makePlaceholders([
      'debug.recent_frames',
      'debug.recent_events',
    ]);
    registerDebugTools({} as never, placeholders as never);
    const result = await invoke('debug.recent_frames', { n: 10 });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text) as {
      frames: unknown[];
      size: number;
      capacity: number;
      returned: number;
    };
    expect(body.frames).toEqual([]);
    expect(body.size).toBe(0);
    expect(body.returned).toBe(0);
    expect(body.capacity).toBeGreaterThan(0);
  });

  it('returns the most recent N frames in chronological order', async () => {
    const { placeholders, invoke } = makePlaceholders([
      'debug.recent_frames',
      'debug.recent_events',
    ]);
    registerDebugTools({} as never, placeholders as never);
    const buffers = getDebugBuffers();
    for (let i = 0; i < 5; i += 1) {
      buffers.frames.push({
        sequence: i,
        timestamp: 1000 + i,
        phase: 1,
        position: 0.1 * i,
        velocity: 0.5,
        force: 50,
      });
    }

    const r = await invoke('debug.recent_frames', { n: 3 });
    const body = JSON.parse(r.content[0].text) as {
      frames: Array<{ sequence: number }>;
    };
    expect(body.frames.map((f) => f.sequence)).toEqual([2, 3, 4]);
  });

  it('caps n at the current buffer size when n exceeds size', async () => {
    const { placeholders, invoke } = makePlaceholders([
      'debug.recent_frames',
      'debug.recent_events',
    ]);
    registerDebugTools({} as never, placeholders as never);
    const buffers = getDebugBuffers();
    buffers.frames.push({
      sequence: 0,
      timestamp: 1000,
      phase: 1,
      position: 0,
      velocity: 0,
      force: 0,
    });
    const r = await invoke('debug.recent_frames', { n: 100 });
    const body = JSON.parse(r.content[0].text) as { frames: unknown[]; returned: number };
    expect(body.frames.length).toBe(1);
    expect(body.returned).toBe(1);
  });

  it('uses the schema default n when input omits it', async () => {
    const { placeholders, invoke } = makePlaceholders([
      'debug.recent_frames',
      'debug.recent_events',
    ]);
    registerDebugTools({} as never, placeholders as never);
    const buffers = getDebugBuffers();
    for (let i = 0; i < 70; i += 1) {
      buffers.frames.push({
        sequence: i,
        timestamp: 1000 + i,
        phase: 1,
        position: 0,
        velocity: 0,
        force: 0,
      });
    }
    const r = await invoke('debug.recent_frames', {});
    const body = JSON.parse(r.content[0].text) as { frames: unknown[]; returned: number };
    expect(body.returned).toBe(50);
    expect(body.frames.length).toBe(50);
  });
});

describe('debug.recent_events', () => {
  beforeEach(() => {
    _resetDebugBuffersForTest();
  });

  it('returns the most recent N events with their payloads', async () => {
    const { placeholders, invoke } = makePlaceholders([
      'debug.recent_frames',
      'debug.recent_events',
    ]);
    registerDebugTools({} as never, placeholders as never);
    const buffers = getDebugBuffers();
    buffers.events.push({
      capturedAt: 1,
      type: 'rep_boundary',
      payload: { sampleBufferLength: 10 },
    });
    buffers.events.push({
      capturedAt: 2,
      type: 'cycle_complete',
      payload: { repNumber: 1, sampleCount: 50 },
    });
    buffers.events.push({
      capturedAt: 3,
      type: 'set_boundary',
      payload: { hadActiveSet: true, sampleBufferLength: 5 },
    });

    const r = await invoke('debug.recent_events', { n: 2 });
    const body = JSON.parse(r.content[0].text) as {
      events: Array<{ type: string; capturedAt: number }>;
    };
    expect(body.events.map((e) => e.type)).toEqual(['cycle_complete', 'set_boundary']);
  });
});
