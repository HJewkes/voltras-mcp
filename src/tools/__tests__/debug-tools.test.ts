// Unit tests for `debug.recent_frames` and `debug.recent_events`.
//
// The tools read from a process-local singleton ring buffer, so the test
// resets the singleton between cases via `_resetDebugBuffersForTest`. We
// drive the buffer directly (no event-bridge in the loop) — the bridge's
// own tests verify it appends correctly; here we verify the tool boundary.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { ServerState } from '../../state/server-state.js';
import type { LiveState as LiveStateType } from '../../state/live-state.js';

vi.mock('@voltras/node-sdk', () => ({}));

const { _resetDebugBuffersForTest, getDebugBuffers } = await import('../../state/debug-buffer.js');
const { registerDebugTools, RECENT_EVENTS_DESCRIPTION } = await import('../debug-tools.js');
const { ChannelDeliveryTracker } = await import('../../state/channel-delivery.js');

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

const FIXED_ISO = '2026-07-02T12:00:00.000Z';

function fakeState(
  channels: { publish: ReturnType<typeof vi.fn> },
  channelDelivery: InstanceType<typeof ChannelDeliveryTracker> = new ChannelDeliveryTracker(
    () => FIXED_ISO,
  ),
): ServerState {
  return { channels, channelDelivery } as unknown as ServerState;
}

const ALL_DEBUG_TOOLS = [
  'debug.recent_frames',
  'debug.recent_events',
  'debug.recording_status',
  'debug.push_test_channel',
  'debug.confirm_channel',
  'debug.compare_rep_streams',
];

describe('debug.recent_frames', () => {
  beforeEach(() => {
    _resetDebugBuffersForTest();
  });

  it('returns an empty list when the buffer is fresh', async () => {
    const { placeholders, invoke } = makePlaceholders(ALL_DEBUG_TOOLS);
    registerDebugTools({} as never, fakeState({ publish: vi.fn() }), placeholders as never);
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
    const { placeholders, invoke } = makePlaceholders(ALL_DEBUG_TOOLS);
    registerDebugTools({} as never, fakeState({ publish: vi.fn() }), placeholders as never);
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
    const { placeholders, invoke } = makePlaceholders(ALL_DEBUG_TOOLS);
    registerDebugTools({} as never, fakeState({ publish: vi.fn() }), placeholders as never);
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
    const { placeholders, invoke } = makePlaceholders(ALL_DEBUG_TOOLS);
    registerDebugTools({} as never, fakeState({ publish: vi.fn() }), placeholders as never);
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
    const { placeholders, invoke } = makePlaceholders(ALL_DEBUG_TOOLS);
    registerDebugTools({} as never, fakeState({ publish: vi.fn() }), placeholders as never);
    const buffers = getDebugBuffers();
    buffers.events.push({
      capturedAt: 1,
      type: 'rep_boundary',
      payload: { sampleBufferLength: 10 },
    });
    buffers.events.push({
      capturedAt: 2,
      type: 'summary',
      payload: { repCount: 1, schemaVersion: 1 },
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
    expect(body.events.map((e) => e.type)).toEqual(['summary', 'set_boundary']);
  });

  // VMCP-02.10: by default the no-args call excludes raw_frame entries.
  // This is the intentional behavior change — prior behavior was firehose.
  it('excludes raw_frame entries by default (parsed-only)', async () => {
    const { placeholders, invoke } = makePlaceholders(ALL_DEBUG_TOOLS);
    registerDebugTools({} as never, fakeState({ publish: vi.fn() }), placeholders as never);
    const buffers = getDebugBuffers();
    buffers.events.push({
      capturedAt: 1,
      type: 'rep_boundary',
      payload: {},
    });
    buffers.events.push({
      capturedAt: 2,
      type: 'raw_frame',
      payload: { bytesHex: 'aabb', bytesLength: 2 },
    });
    buffers.events.push({
      capturedAt: 3,
      type: 'summary',
      payload: { repCount: 1 },
    });

    const r = await invoke('debug.recent_events', {});
    const body = JSON.parse(r.content[0].text) as {
      events: Array<{ type: string; capturedAt: number }>;
      returned: number;
    };
    expect(body.events.map((e) => e.type)).toEqual(['rep_boundary', 'summary']);
    expect(body.returned).toBe(2);
  });

  it('filters by `types` allowlist and ignores other parsed events', async () => {
    const { placeholders, invoke } = makePlaceholders(ALL_DEBUG_TOOLS);
    registerDebugTools({} as never, fakeState({ publish: vi.fn() }), placeholders as never);
    const buffers = getDebugBuffers();
    buffers.events.push({
      capturedAt: 1,
      type: 'rep_boundary',
      payload: {},
    });
    buffers.events.push({
      capturedAt: 2,
      type: 'settings_update',
      payload: { weightLbs: 50 },
    });
    buffers.events.push({
      capturedAt: 3,
      type: 'summary',
      payload: { repCount: 1 },
    });
    buffers.events.push({
      capturedAt: 4,
      type: 'settings_update',
      payload: { weightLbs: 60 },
    });

    const r = await invoke('debug.recent_events', { types: ['settings_update'] });
    const body = JSON.parse(r.content[0].text) as {
      events: Array<{ type: string; capturedAt: number }>;
    };
    expect(body.events.map((e) => e.capturedAt)).toEqual([2, 4]);
    expect(body.events.every((e) => e.type === 'settings_update')).toBe(true);
  });

  it('returns raw_frame entries when `includeRawFrames: true`', async () => {
    const { placeholders, invoke } = makePlaceholders(ALL_DEBUG_TOOLS);
    registerDebugTools({} as never, fakeState({ publish: vi.fn() }), placeholders as never);
    const buffers = getDebugBuffers();
    buffers.events.push({
      capturedAt: 1,
      type: 'rep_boundary',
      payload: {},
    });
    buffers.events.push({
      capturedAt: 2,
      type: 'raw_frame',
      payload: { bytesHex: 'aabb', bytesLength: 2 },
    });

    const r = await invoke('debug.recent_events', { includeRawFrames: true });
    const body = JSON.parse(r.content[0].text) as {
      events: Array<{ type: string; capturedAt: number }>;
    };
    expect(body.events.map((e) => e.type)).toEqual(['rep_boundary', 'raw_frame']);
  });

  it('combines `types` and `includeRawFrames` filters', async () => {
    const { placeholders, invoke } = makePlaceholders(ALL_DEBUG_TOOLS);
    registerDebugTools({} as never, fakeState({ publish: vi.fn() }), placeholders as never);
    const buffers = getDebugBuffers();
    buffers.events.push({
      capturedAt: 1,
      type: 'rep_boundary',
      payload: {},
    });
    buffers.events.push({
      capturedAt: 2,
      type: 'raw_frame',
      payload: { bytesHex: 'aabb', bytesLength: 2 },
    });
    buffers.events.push({
      capturedAt: 3,
      type: 'summary',
      payload: { repCount: 1 },
    });
    buffers.events.push({
      capturedAt: 4,
      type: 'raw_frame',
      payload: { bytesHex: 'ccdd', bytesLength: 2 },
    });

    // types includes raw_frame AND includeRawFrames=true → raw frames pass through.
    const r1 = await invoke('debug.recent_events', {
      types: ['raw_frame'],
      includeRawFrames: true,
    });
    const body1 = JSON.parse(r1.content[0].text) as {
      events: Array<{ type: string; capturedAt: number }>;
    };
    expect(body1.events.map((e) => e.capturedAt)).toEqual([2, 4]);

    // types includes raw_frame BUT includeRawFrames=false (default) → raw frames
    // stripped first, then type filter on the remainder yields zero matches.
    const r2 = await invoke('debug.recent_events', { types: ['raw_frame'] });
    const body2 = JSON.parse(r2.content[0].text) as {
      events: unknown[];
      returned: number;
    };
    expect(body2.events).toEqual([]);
    expect(body2.returned).toBe(0);
  });

  it('applies `n` truncation AFTER filtering so matches are not lost to raw_frame noise', async () => {
    const { placeholders, invoke } = makePlaceholders(ALL_DEBUG_TOOLS);
    registerDebugTools({} as never, fakeState({ publish: vi.fn() }), placeholders as never);
    const buffers = getDebugBuffers();
    // Older parsed event followed by a swarm of raw frames. With the
    // filter applied AFTER slicing, the parsed event would be invisible
    // unless n covers the full noise window. Applying the filter first
    // surfaces it regardless of how much raw-frame churn followed.
    buffers.events.push({
      capturedAt: 1,
      type: 'summary',
      payload: { repCount: 1 },
    });
    for (let i = 0; i < 30; i += 1) {
      buffers.events.push({
        capturedAt: 100 + i,
        type: 'raw_frame',
        payload: { bytesHex: '00', bytesLength: 1 },
      });
    }

    const r = await invoke('debug.recent_events', { n: 5 });
    const body = JSON.parse(r.content[0].text) as {
      events: Array<{ type: string }>;
      returned: number;
    };
    expect(body.returned).toBe(1);
    expect(body.events[0].type).toBe('summary');
  });
});

describe('debug.push_test_channel', () => {
  beforeEach(() => {
    _resetDebugBuffersForTest();
  });

  it('forwards content, injects the caller-supplied nonce into meta, and echoes it back', async () => {
    const publish = vi.fn();
    const { placeholders, invoke } = makePlaceholders(ALL_DEBUG_TOOLS);
    registerDebugTools({} as never, fakeState({ publish }), placeholders as never);

    const r = await invoke('debug.push_test_channel', {
      content: 'hello channels',
      meta: { source: 'voltras', event_type: 'manual_test' },
      nonce: 'probe-123',
    });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text)).toEqual({ ok: true, nonce: 'probe-123' });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      content: 'hello channels',
      meta: { source: 'voltras', event_type: 'manual_test', nonce: 'probe-123' },
    });
  });

  it('mints a nonce when the caller omits one and injects it into meta', async () => {
    const publish = vi.fn();
    const { placeholders, invoke } = makePlaceholders(ALL_DEBUG_TOOLS);
    registerDebugTools({} as never, fakeState({ publish }), placeholders as never);

    const r = await invoke('debug.push_test_channel', { content: 'plain' });
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(r.content[0].text) as { ok: boolean; nonce: string };
    expect(body.ok).toBe(true);
    expect(typeof body.nonce).toBe('string');
    expect(body.nonce.length).toBeGreaterThan(0);
    // The same minted nonce is injected into the delivered meta.
    expect(publish).toHaveBeenCalledWith({ content: 'plain', meta: { nonce: body.nonce } });
  });

  it('returns INVALID_INPUT when content is missing', async () => {
    const publish = vi.fn();
    const { placeholders, invoke } = makePlaceholders(ALL_DEBUG_TOOLS);
    registerDebugTools({} as never, fakeState({ publish }), placeholders as never);

    const r = await invoke('debug.push_test_channel', { meta: {} });
    expect(r.isError).toBe(true);
    expect((JSON.parse(r.content[0].text) as { code: string }).code).toBe('INVALID_INPUT');
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('debug.confirm_channel', () => {
  beforeEach(() => {
    _resetDebugBuffersForTest();
  });

  it('records a matching probe round-trip and reports matchedProbe:true', async () => {
    const publish = vi.fn();
    const tracker = new ChannelDeliveryTracker(() => FIXED_ISO);
    const { placeholders, invoke } = makePlaceholders(ALL_DEBUG_TOOLS);
    registerDebugTools({} as never, fakeState({ publish }, tracker), placeholders as never);

    await invoke('debug.push_test_channel', { content: 'probe', nonce: 'abc' });
    const r = await invoke('debug.confirm_channel', { nonce: 'abc' });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text)).toEqual({
      ok: true,
      matchedProbe: true,
      confirmations: 1,
      lastConfirmedAt: FIXED_ISO,
    });
    expect(tracker.snapshot().lastConfirmedAt).toBe(FIXED_ISO);
  });

  it('reports matchedProbe:false when the nonce does not match the outstanding probe', async () => {
    const publish = vi.fn();
    const { placeholders, invoke } = makePlaceholders(ALL_DEBUG_TOOLS);
    registerDebugTools({} as never, fakeState({ publish }), placeholders as never);

    await invoke('debug.push_test_channel', { content: 'probe', nonce: 'expected' });
    const r = await invoke('debug.confirm_channel', { nonce: 'stale' });
    const body = JSON.parse(r.content[0].text) as { matchedProbe: boolean; confirmations: number };
    expect(body.matchedProbe).toBe(false);
    expect(body.confirmations).toBe(1);
  });

  it('reports matchedProbe:false when confirming before any probe fired', async () => {
    const publish = vi.fn();
    const { placeholders, invoke } = makePlaceholders(ALL_DEBUG_TOOLS);
    registerDebugTools({} as never, fakeState({ publish }), placeholders as never);

    const r = await invoke('debug.confirm_channel', { nonce: 'orphan' });
    const body = JSON.parse(r.content[0].text) as {
      matchedProbe: boolean;
      lastConfirmedAt: string;
    };
    expect(body.matchedProbe).toBe(false);
    expect(body.lastConfirmedAt).toBe(FIXED_ISO);
  });

  it('returns INVALID_INPUT when nonce is missing', async () => {
    const publish = vi.fn();
    const { placeholders, invoke } = makePlaceholders(ALL_DEBUG_TOOLS);
    registerDebugTools({} as never, fakeState({ publish }), placeholders as never);

    const r = await invoke('debug.confirm_channel', {});
    expect(r.isError).toBe(true);
    expect((JSON.parse(r.content[0].text) as { code: string }).code).toBe('INVALID_INPUT');
  });
});

// VMCP-02.33: the `debug.recent_events` `types` filter matches diagnostic
// ring-buffer `type` names, which are a distinct namespace from the
// claude/channel `event_type` names. The description's filter EXAMPLES had
// drifted to channel-only names (`rep_finalized`, `setting_coerced`) that match
// nothing in the buffer. Guard that every name in a `types: [...]` example is a
// real DebugEvent.type.
describe('RECENT_EVENTS_DESCRIPTION filter examples (VMCP-02.33)', () => {
  // The authoritative DebugEvent.type union (debug-buffer.ts) — mirrored here
  // because TS types aren't available at runtime.
  const VALID_DEBUG_TYPES = new Set([
    'rep_boundary',
    'set_boundary',
    'summary',
    'pre_summary',
    'settings_update',
    'connection_state_change',
    'guided_load_state',
    'state_dump',
    'send_raw',
    'raw_frame',
    'firmware_rep',
  ]);

  it('only references real DebugEvent.type names inside `types: [...]` examples', () => {
    const exampleArrays = [...RECENT_EVENTS_DESCRIPTION.matchAll(/types:\s*\[([^\]]*)\]/g)];
    expect(exampleArrays.length).toBeGreaterThan(0);
    const namesInExamples = exampleArrays.flatMap((m) =>
      [...m[1].matchAll(/"([^"]+)"/g)].map((q) => q[1]),
    );
    expect(namesInExamples.length).toBeGreaterThan(0);
    for (const name of namesInExamples) {
      expect(VALID_DEBUG_TYPES.has(name), `"${name}" is not a DebugEvent.type`).toBe(true);
    }
  });

  it('does not advertise filtering by channel-only event_type names', () => {
    // These are claude/channel event_type names, never debug ring-buffer types.
    // They may appear in the clarifying prose, but not as a `types: [...]` filter.
    const exampleArrays = [...RECENT_EVENTS_DESCRIPTION.matchAll(/types:\s*\[([^\]]*)\]/g)];
    const filterNames = exampleArrays.flatMap((m) =>
      [...m[1].matchAll(/"([^"]+)"/g)].map((q) => q[1]),
    );
    for (const channelOnly of ['rep_finalized', 'setting_coerced']) {
      expect(filterNames).not.toContain(channelOnly);
    }
  });
});

describe('debug.compare_rep_streams', () => {
  // The tool reads `state.slots.get(slot).live.snapshotSet()` so the test
  // wires a state with a real `LiveState` instance, populates it with a
  // mixed set of analytics reps + firmware-anchored reps, then asserts the
  // tool surfaces the count diff. The shape mirrors VMCP-02.29 Phase 1:
  // measurement parity gathering, no consumer surface change.
  beforeEach(() => {
    _resetDebugBuffersForTest();
  });

  async function buildState(): Promise<{
    live: LiveStateType;
    invoke: ReturnType<typeof makePlaceholders>['invoke'];
  }> {
    const { LiveState } = await import('../../state/live-state.js');
    const live = new LiveState();
    const slots = new Map([['primary', { live }]]);
    const state = { channels: { publish: vi.fn() }, slots } as unknown as ServerState;
    const { placeholders, invoke } = makePlaceholders(ALL_DEBUG_TOOLS);
    registerDebugTools({} as never, state, placeholders as never);
    return { live, invoke };
  }

  async function readBody(invoke: ReturnType<typeof makePlaceholders>['invoke']): Promise<{
    slot: string;
    active: boolean;
    set_id?: string;
    analytics_count?: number;
    firmware_count?: number;
    divergence?: number;
    reason?: string;
  }> {
    const r = await invoke('debug.compare_rep_streams', {});
    return JSON.parse(r.content[0].text);
  }

  it('returns active:false / no_active_set when the slot has no armed set', async () => {
    const { invoke } = await buildState();
    const body = await readBody(invoke);
    expect(body).toEqual({ slot: 'primary', active: false, reason: 'no_active_set' });
  });

  it('returns active:false / unknown_slot for an unrecognised slot id', async () => {
    const { invoke } = await buildState();
    const r = await invoke('debug.compare_rep_streams', { slot: 'left' });
    const body = JSON.parse(r.content[0].text);
    expect(body).toEqual({ slot: 'left', active: false, reason: 'unknown_slot' });
  });

  it('surfaces the analytics vs firmware count diff on the active set', async () => {
    const { live, invoke } = await buildState();
    live.startSession({
      sessionId: 'sess-1',
      startedAt: '2025-01-01T00:00:00.000Z',
      setIds: [],
      status: 'active',
    });
    live.startSet({
      setId: 'set-99',
      sessionId: 'sess-1',
      startedAt: '2025-01-01T00:00:00.000Z',
      reps: [],
      status: 'active',
    });
    // 3 analytics reps (the canonical pipeline), 2 firmware reps.
    for (let i = 0; i < 3; i += 1) {
      // Minimal Rep shape suitable for length comparison only.
      live.appendRep({ concentric: {}, eccentric: {}, repNumber: i + 1 } as never);
    }
    for (let i = 0; i < 2; i += 1) {
      live.appendFirmwareRep({
        ts: 1000 + i,
        repNumber: i + 1,
        setCounter: 1,
        frameCounter: 10 * (i + 1),
        targetWeightTenths: 600,
      });
    }

    const body = await readBody(invoke);
    expect(body).toEqual({
      slot: 'primary',
      active: true,
      set_id: 'set-99',
      analytics_count: 3,
      firmware_count: 2,
      divergence: 1,
    });
  });

  it('reports firmware_count:0 when only the analytics stream has fired', async () => {
    const { live, invoke } = await buildState();
    live.startSession({
      sessionId: 'sess-1',
      startedAt: '2025-01-01T00:00:00.000Z',
      setIds: [],
      status: 'active',
    });
    live.startSet({
      setId: 'set-1',
      sessionId: 'sess-1',
      startedAt: '2025-01-01T00:00:00.000Z',
      reps: [],
      status: 'active',
    });
    live.appendRep({ concentric: {}, eccentric: {}, repNumber: 1 } as never);

    const body = await readBody(invoke);
    expect(body.active).toBe(true);
    expect(body.analytics_count).toBe(1);
    expect(body.firmware_count).toBe(0);
    expect(body.divergence).toBe(1);
  });
});
