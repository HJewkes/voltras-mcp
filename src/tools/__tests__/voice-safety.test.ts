// VMCP-02.86 — the `VoiceSafetyContext` built over live `ServerState`.
//
// The hardware defect lived exactly here: the voice fast-path asked about a
// slot named `primary` while the only bound device sat on `right`. These cover
// the resolution contract the fast-path depends on — what `connectedSlots`
// reports, and that evaluate/unload route to the slot they are handed.

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

// Keep the ack off the real `say` binary — speakAck is best-effort and its
// TTS behavior is covered by the tts-tools suite.
const speakCalls: { text: string; interrupt?: boolean; blocking?: boolean }[] = [];
vi.mock('../tts-tools.js', () => ({
  speak: async (args: { text: string; interrupt?: boolean; blocking?: boolean }) => {
    speakCalls.push(args);
  },
}));

const { makeVoiceSafety } = await import('../voice-safety.js');

interface FakeSlot {
  slotId: string;
  client: { isConnected: boolean; unloadDevice: Mock<() => Promise<void>> };
}

function makeState(
  slots: { slotId: string; connected?: boolean; activeSetId?: string }[],
): { state: unknown; slots: Map<string, FakeSlot> } {
  const map = new Map<string, FakeSlot>();
  for (const spec of slots) {
    map.set(spec.slotId, {
      slotId: spec.slotId,
      client: {
        isConnected: spec.connected ?? true,
        connectionState: 'connected',
        guidedLoadState: { phase: 'idle', countdownRemainingMs: null },
        isRowingActive: false,
        unloadDevice: vi.fn(async () => undefined),
        exitGuidedLoad: vi.fn(async () => undefined),
      } as unknown as FakeSlot['client'],
      live: {
        snapshotSet: () =>
          spec.activeSetId === undefined
            ? undefined
            : { setId: spec.activeSetId, status: 'active' },
      },
    } as unknown as FakeSlot);
  }
  const state = {
    slots: map,
    voice: { listener: null, starting: null, __deps: null },
    setStartDeviceSnapshots: new Map(),
    lastSetEndedAtMs: new Map(),
  };
  return { state, slots: map };
}

describe('makeVoiceSafety — connectedSlots', () => {
  it('reports a bilateral rig bound to left/right, with no primary at all', () => {
    const { state } = makeState([{ slotId: 'left' }, { slotId: 'right' }]);
    expect(makeVoiceSafety(state as never).connectedSlots().sort()).toEqual(['left', 'right']);
  });

  it('reports `right` when that is the only bound slot (the hardware case)', () => {
    const { state } = makeState([{ slotId: 'right', activeSetId: 'set-9' }]);
    expect(makeVoiceSafety(state as never).connectedSlots()).toEqual(['right']);
  });

  it('excludes the bootstrap primary slot whose client never connected', () => {
    const { state } = makeState([
      { slotId: 'primary', connected: false },
      { slotId: 'right', activeSetId: 'set-9' },
    ]);
    expect(makeVoiceSafety(state as never).connectedSlots()).toEqual(['right']);
  });
});

describe('makeVoiceSafety — evaluate / unload routing', () => {
  it('evaluates the named slot, carrying its own active set id', () => {
    const { state } = makeState([{ slotId: 'right', activeSetId: 'set-9' }]);
    expect(makeVoiceSafety(state as never).evaluate('right')).toEqual({
      warranted: true,
      reason: 'active_set',
      setId: 'set-9',
    });
  });

  it('throws on a slot that is not bound — the fast-path treats that as no verdict', () => {
    const { state } = makeState([{ slotId: 'right', activeSetId: 'set-9' }]);
    expect(() => makeVoiceSafety(state as never).evaluate('primary')).toThrow(/Unknown slot/);
  });

  it('speakAck sends an interrupting, non-blocking cue', async () => {
    const { state } = makeState([{ slotId: 'right', activeSetId: 'set-9' }]);
    speakCalls.length = 0;
    makeVoiceSafety(state as never).speakAck('Stopping. Weight off.');
    await Promise.resolve();
    expect(speakCalls).toEqual([
      { text: 'Stopping. Weight off.', interrupt: true, blocking: false },
    ]);
  });

  it('unloads the cable on the slot it is handed, not the primary one', async () => {
    const { state, slots } = makeState([
      { slotId: 'left', activeSetId: 'set-L' },
      { slotId: 'right', activeSetId: 'set-R' },
    ]);
    await makeVoiceSafety(state as never).unload('right');
    expect(slots.get('right')?.client.unloadDevice).toHaveBeenCalledTimes(1);
    expect(slots.get('left')?.client.unloadDevice).not.toHaveBeenCalled();
  });
});
