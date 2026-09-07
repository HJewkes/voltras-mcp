// The local voice weight fast-path (VMCP-02.87).
//
// The adapter is mocked throughout — nothing here touches BLE. Two layers are
// covered: the pure slot/weight resolution, and the handler's publish contract
// (what the model learns when a command lands, and when it does not).

import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

class FakeVoltraSDKError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'VoltraSDKError';
    this.code = code;
  }
}

vi.mock('@voltras/node-sdk', () => ({
  TrainingMode: { Idle: 0, WeightTraining: 1 },
  TrainingModeNames: {},
  VoltraSDKError: FakeVoltraSDKError,
  VoltraClient: class {},
}));

vi.mock('../../state/event-bridge.js', () => ({
  wireBridgeForSlot: vi.fn(() => vi.fn()),
}));

const { createWeightFastPath, makeVoiceWeight, planWeight, resolveTargetSlot } =
  await import('../voice-weight.js');

type Published = { meta: Record<string, string>; content: string };

interface Harness {
  events: Published[];
  setWeight: Mock<(slot: string, lbs: number) => Promise<void>>;
  handle: (transcript: string, command: unknown) => Promise<void>;
}

function slotSpec(
  slot: string,
  overrides: Partial<{
    activeSetStartedAtMs: number | null;
    lastSetEndedAtMs: number | null;
    currentWeightLbs: number | null;
  }> = {},
) {
  return {
    slot,
    activeSetStartedAtMs: null,
    lastSetEndedAtMs: null,
    currentWeightLbs: 50,
    ...overrides,
  };
}

function buildHarness(
  slots: ReturnType<typeof slotSpec>[],
  opts: { setWeight?: Mock<(slot: string, lbs: number) => Promise<void>> } = {},
): Harness {
  const events: Published[] = [];
  const channels = { publish: (event: Published) => events.push(event) };
  const setWeight = opts.setWeight ?? vi.fn(async () => undefined);
  const live = [...slots];
  const context = { slots: () => live, setWeight };
  const handler = createWeightFastPath(channels as never, context as never);
  return {
    events,
    setWeight,
    handle: (transcript, command) =>
      handler({
        command: command as never,
        transcript,
        sttModel: 'tiny.en',
        latencyMs: 120,
        audioDurationMs: 900,
      }),
  };
}

function types(events: Published[]): string[] {
  return events.map((event) => event.meta.event_type);
}

function body(event: Published): Record<string, unknown> {
  return JSON.parse(event.content) as Record<string, unknown>;
}

describe('resolveTargetSlot', () => {
  it('uses the only connected slot', () => {
    expect(resolveTargetSlot([slotSpec('right')], undefined)).toEqual({ slot: slotSpec('right') });
  });

  it('honours an explicit side word over set recency', () => {
    const slots = [slotSpec('left', { activeSetStartedAtMs: 10 }), slotSpec('right')];
    expect(resolveTargetSlot(slots, 'right')).toEqual({ slot: slots[1] });
  });

  it('rejects a side word with no connected device', () => {
    expect(resolveTargetSlot([slotSpec('left')], 'right')).toEqual({
      reason: 'slot_not_connected',
    });
  });

  it('prefers the slot with an active set', () => {
    const slots = [
      slotSpec('left', { lastSetEndedAtMs: 900 }),
      slotSpec('right', { activeSetStartedAtMs: 5 }),
    ];
    expect(resolveTargetSlot(slots, undefined)).toEqual({ slot: slots[1] });
  });

  it('falls back to the most recently finished set', () => {
    const slots = [
      slotSpec('left', { lastSetEndedAtMs: 100 }),
      slotSpec('right', { lastSetEndedAtMs: 900 }),
    ];
    expect(resolveTargetSlot(slots, undefined)).toEqual({ slot: slots[1] });
  });

  it('is ambiguous with two idle slots and no side word', () => {
    expect(resolveTargetSlot([slotSpec('left'), slotSpec('right')], undefined)).toEqual({
      reason: 'ambiguous_slot',
    });
  });

  it('reports no connected slot', () => {
    expect(resolveTargetSlot([], undefined)).toEqual({ reason: 'no_connected_slot' });
  });
});

describe('planWeight', () => {
  const slot = slotSpec('primary', { currentWeightLbs: 60 });

  it('takes an in-range absolute target verbatim', () => {
    expect(planWeight({ kind: 'absolute', lbs: 70 }, slot, undefined)).toEqual({
      lbs: 70,
      clamped: false,
    });
  });

  it('refuses an out-of-range absolute target instead of clamping it', () => {
    expect(planWeight({ kind: 'absolute', lbs: 500 }, slot, undefined)).toEqual({
      reason: 'out_of_range',
    });
    expect(planWeight({ kind: 'absolute', lbs: 2 }, slot, undefined)).toEqual({
      reason: 'out_of_range',
    });
  });

  it('adds a delta to the current weight', () => {
    expect(planWeight({ kind: 'relative', deltaLbs: -10 }, slot, undefined)).toEqual({
      lbs: 50,
      clamped: false,
    });
  });

  it('clamps a delta that runs off the end of the range', () => {
    const heavy = slotSpec('primary', { currentWeightLbs: 195 });
    expect(planWeight({ kind: 'relative', deltaLbs: 10 }, heavy, undefined)).toEqual({
      lbs: 200,
      clamped: true,
    });
  });

  it('cannot step relative to an unknown current weight', () => {
    const unknown = slotSpec('primary', { currentWeightLbs: null });
    expect(planWeight({ kind: 'relative', deltaLbs: 5 }, unknown, undefined)).toEqual({
      reason: 'unknown_current_weight',
    });
  });

  it('reverts to the ledger entry for undo, and refuses without one', () => {
    expect(planWeight({ kind: 'undo' }, slot, 45)).toEqual({ lbs: 45, clamped: false });
    expect(planWeight({ kind: 'undo' }, slot, undefined)).toEqual({ reason: 'nothing_to_undo' });
  });
});

describe('createWeightFastPath — applying', () => {
  it('writes the weight and publishes voice_command_applied only', async () => {
    const h = buildHarness([slotSpec('primary', { currentWeightLbs: 50 })]);
    await h.handle('set it to 70', { kind: 'absolute', lbs: 70 });
    expect(h.setWeight).toHaveBeenCalledWith('primary', 70);
    expect(types(h.events)).toEqual(['voice_command_applied']);
    expect(body(h.events[0])).toMatchObject({
      slot: 'primary',
      command: 'absolute',
      weight_lbs: 70,
      previous_lbs: 50,
      applied: true,
    });
  });

  it('tells the model not to re-issue device.set_weight', async () => {
    const h = buildHarness([slotSpec('primary')]);
    await h.handle('set it to 70', { kind: 'absolute', lbs: 70 });
    expect(String(body(h.events[0]).summary)).toMatch(/do NOT call device\.set_weight/);
  });

  it('applies a relative step against the live weight', async () => {
    const h = buildHarness([slotSpec('primary', { currentWeightLbs: 65 })]);
    await h.handle('up 10', { kind: 'relative', deltaLbs: 10 });
    expect(h.setWeight).toHaveBeenCalledWith('primary', 75);
  });

  it('flags a clamped step', async () => {
    const h = buildHarness([slotSpec('primary', { currentWeightLbs: 198 })]);
    await h.handle('up 10', { kind: 'relative', deltaLbs: 10 });
    expect(h.setWeight).toHaveBeenCalledWith('primary', 200);
    expect(h.events[0].meta.clamped).toBe('true');
  });

  it('routes to the slot named in the phrase', async () => {
    const h = buildHarness([slotSpec('left'), slotSpec('right')]);
    await h.handle('left to 40', { kind: 'absolute', lbs: 40, slot: 'left' });
    expect(h.setWeight).toHaveBeenCalledWith('left', 40);
  });
});

describe('createWeightFastPath — undo', () => {
  it('reverts to the weight held before the last local command', async () => {
    const h = buildHarness([slotSpec('primary', { currentWeightLbs: 50 })]);
    await h.handle('set it to 70', { kind: 'absolute', lbs: 70 });
    await h.handle('never mind', { kind: 'undo' });
    expect(h.setWeight).toHaveBeenNthCalledWith(2, 'primary', 50);
    expect(types(h.events)).toEqual(['voice_command_applied', 'voice_command_applied']);
    expect(body(h.events[1])).toMatchObject({ command: 'undo', weight_lbs: 50 });
  });

  it('is one deep — a second undo has nothing left to revert', async () => {
    const h = buildHarness([slotSpec('primary', { currentWeightLbs: 50 })]);
    await h.handle('set it to 70', { kind: 'absolute', lbs: 70 });
    await h.handle('cancel', { kind: 'undo' });
    await h.handle('cancel', { kind: 'undo' });
    expect(h.setWeight).toHaveBeenCalledTimes(2);
    expect(types(h.events)).toEqual([
      'voice_command_applied',
      'voice_command_applied',
      'voice_command_rejected',
      'voice_input',
    ]);
    expect(h.events[2].meta.reason).toBe('nothing_to_undo');
  });

  it('rejects an undo before any local command', async () => {
    const h = buildHarness([slotSpec('primary')]);
    await h.handle('undo that', { kind: 'undo' });
    expect(h.setWeight).not.toHaveBeenCalled();
    expect(h.events[0].meta.reason).toBe('nothing_to_undo');
  });

  it('keeps undo ledgers per slot', async () => {
    const h = buildHarness([
      slotSpec('left', { currentWeightLbs: 40 }),
      slotSpec('right', { currentWeightLbs: 60 }),
    ]);
    await h.handle('left to 45', { kind: 'absolute', lbs: 45, slot: 'left' });
    await h.handle('cancel right', { kind: 'undo', slot: 'right' });
    expect(h.setWeight).toHaveBeenCalledTimes(1);
    expect(h.events[1].meta.reason).toBe('nothing_to_undo');
    expect(h.events[1].meta.slot).toBe('right');
  });
});

describe('createWeightFastPath — rejections', () => {
  it('forwards an ambiguous command to the model as voice_input', async () => {
    const h = buildHarness([slotSpec('left'), slotSpec('right')]);
    await h.handle('set it to 70', { kind: 'absolute', lbs: 70 });
    expect(h.setWeight).not.toHaveBeenCalled();
    expect(types(h.events)).toEqual(['voice_command_rejected', 'voice_input']);
    expect(h.events[0].meta.reason).toBe('ambiguous_slot');
    expect(body(h.events[1])).toMatchObject({ transcript: 'set it to 70' });
  });

  it('rejects an out-of-range target without touching the device', async () => {
    const h = buildHarness([slotSpec('primary')]);
    await h.handle('set it to 500', { kind: 'absolute', lbs: 500 });
    expect(h.setWeight).not.toHaveBeenCalled();
    expect(h.events[0].meta.reason).toBe('out_of_range');
  });

  it('rejects when no slot is connected', async () => {
    const h = buildHarness([]);
    await h.handle('set it to 70', { kind: 'absolute', lbs: 70 });
    expect(h.events[0].meta.reason).toBe('no_connected_slot');
  });

  it('reports a failed write and hands the command back to the model', async () => {
    const setWeight = vi.fn(async () => {
      throw new Error('device rejected the write');
    });
    const h = buildHarness([slotSpec('primary')], { setWeight });
    await h.handle('set it to 70', { kind: 'absolute', lbs: 70 });
    expect(types(h.events)).toEqual(['voice_command_rejected', 'voice_input']);
    expect(h.events[0].meta.reason).toBe('set_failed');
    expect(body(h.events[0]).detail).toBe('device rejected the write');
  });

  it('degrades to voice_input when no fast-path context is wired', async () => {
    const events: Published[] = [];
    const handler = createWeightFastPath(
      { publish: (e: Published) => events.push(e) } as never,
      null,
    );
    await handler({
      command: { kind: 'absolute', lbs: 70 },
      transcript: 'set it to 70',
      sttModel: 'tiny.en',
      latencyMs: 10,
      audioDurationMs: 100,
    });
    expect(types(events)).toEqual(['voice_command_rejected', 'voice_input']);
    expect(events[0].meta.reason).toBe('no_weight_context');
  });
});

// VMCP-02.86 class of bug: the fast-path must read its slots from live state,
// never assume `primary` exists.
describe('makeVoiceWeight', () => {
  function fakeState(specs: { slotId: string; connected?: boolean; weightLbs?: number }[]) {
    const slots = new Map<string, unknown>();
    for (const spec of specs) {
      slots.set(spec.slotId, {
        slotId: spec.slotId,
        client: { isConnected: spec.connected ?? true },
        live: {
          snapshotSet: () => ({ status: 'active', startedAt: '2026-09-07T10:00:00.000Z' }),
          snapshotDevice: () => ({ weightLbs: spec.weightLbs }),
        },
      });
    }
    return { slots, lastSetEndedAtMs: new Map([['right', 42]]) };
  }

  it('reports only connected slots, with live weight and set recency', () => {
    const state = fakeState([
      { slotId: 'left', connected: false, weightLbs: 30 },
      { slotId: 'right', weightLbs: 65 },
    ]);
    expect(makeVoiceWeight(state as never).slots()).toEqual([
      {
        slot: 'right',
        activeSetStartedAtMs: Date.parse('2026-09-07T10:00:00.000Z'),
        lastSetEndedAtMs: 42,
        currentWeightLbs: 65,
      },
    ]);
  });

  it('reports a null weight when the slot has never published one', () => {
    const state = fakeState([{ slotId: 'right' }]);
    expect(makeVoiceWeight(state as never).slots()[0].currentWeightLbs).toBeNull();
  });
});
