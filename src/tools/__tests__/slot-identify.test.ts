// Tests for `slot.identify`.
//
// `slot.identify` briefly switches a slot's device into Damper mode so the
// user can visually confirm which physical Voltra is bound to which slot, then
// reverts to the prior training mode. The suite uses `vi.useFakeTimers()` to
// drive the hold duration deterministically without real wall-clock waits.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the SDK so the static import chain doesn't pull native peers.
class FakeVoltraSDKError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'VoltraSDKError';
    this.code = code;
  }
}

const FakeTrainingMode = {
  Idle: 0,
  WeightTraining: 1,
  ResistanceBand: 2,
  Rowing: 3,
  Damper: 4,
  CustomCurves: 6,
  Isokinetic: 7,
  Isometric: 8,
  // Reverse mapping (TS enum behaviour): number -> no-space member name.
  0: 'Idle',
  1: 'WeightTraining',
  2: 'ResistanceBand',
  3: 'Rowing',
  4: 'Damper',
  6: 'CustomCurves',
  7: 'Isokinetic',
  8: 'Isometric',
} as const;

// Mirrors the REAL SDK: the human-readable names, which are SPACED for the
// multi-word modes. `settingsToSnapshot` stores these on the device snapshot,
// so this is the form `slot.identify` reads back — distinct from the enum's
// no-space member keys above. VMCP-02.53 was the mismatch between the two.
const FakeTrainingModeNames: Record<number, string> = {
  0: 'Idle',
  1: 'Weight Training',
  2: 'Resistance Band',
  3: 'Rowing',
  4: 'Damper',
  6: 'Custom Curves',
  7: 'Isokinetic',
  8: 'Isometric',
};

vi.mock('@voltras/node-sdk', () => ({
  TrainingMode: FakeTrainingMode,
  TrainingModeNames: FakeTrainingModeNames,
  VoltraSDKError: FakeVoltraSDKError,
  VoltraClient: class {},
  VoltraManager: class {},
}));

const { registerSlotTools } = await import('../slot-tools.js');

import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerState } from '../../state/server-state.js';
import type { ToolResult } from '../helpers.js';

// ── Fake helpers ─────────────────────────────────────────────────────────

type Callback = (args: unknown, extra?: unknown) => Promise<ToolResult>;

function buildPlaceholders(names: readonly string[]): {
  placeholders: Map<string, RegisteredTool>;
  callbacks: Map<string, { cb: Callback }>;
} {
  const callbacks = new Map<string, { cb: Callback }>();
  const placeholders = new Map<string, RegisteredTool>();
  for (const name of names) {
    const slot = {
      cb: async () => ({ content: [{ type: 'text' as const, text: 'placeholder' }] }),
    };
    callbacks.set(name, slot);
    placeholders.set(name, {
      update: ({ callback }: { callback?: Callback }) => {
        if (callback !== undefined) slot.cb = callback;
      },
    } as unknown as RegisteredTool);
  }
  return { placeholders, callbacks };
}

function payload(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

// ── Fake client + live state ──────────────────────────────────────────────

interface FakeLive {
  snapshotDevice: ReturnType<typeof vi.fn>;
}

interface FakeClient {
  isConnected: boolean;
  setMode: ReturnType<typeof vi.fn>;
}

function makeFakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    isConnected: true,
    setMode: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeFakeLive(trainingMode?: string): FakeLive {
  return {
    snapshotDevice: vi.fn(() => ({
      // Default to the SPACED human form the real snapshot carries.
      trainingMode: trainingMode ?? 'Weight Training',
    })),
  };
}

function makeState(client: FakeClient, live: FakeLive, slotId = 'primary'): ServerState {
  const slots = new Map<string, { slotId: string; client: FakeClient; live: FakeLive }>();
  slots.set(slotId, { slotId, client, live });
  return { slots } as unknown as ServerState;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('slot.identify', () => {
  let identifyCb: Callback;
  let client: FakeClient;
  let live: FakeLive;

  function setup(trainingMode?: string, clientOverrides: Partial<FakeClient> = {}): void {
    client = makeFakeClient(clientOverrides);
    live = makeFakeLive(trainingMode);
    const state = makeState(client, live);
    const { placeholders, callbacks } = buildPlaceholders(['slot.identify']);
    registerSlotTools({} as McpServer, state, placeholders);
    identifyCb = callbacks.get('slot.identify')!.cb;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('happy path', () => {
    it('switches to Damper then back to Weight Training after the specified duration', async () => {
      setup('Weight Training');
      const promise = identifyCb({ durationMs: 2000 });

      // After setMode(Damper) resolves, the timer starts. Advance past it.
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      expect(result.isError).toBeUndefined();
      const body = payload(result) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.slot).toBe('primary');
      expect(body.previousMode).toBe('Weight Training');
      expect(body.identifiedFor).toBe(2000);
      expect(body.revertWarning).toBeUndefined();

      // Assert call order: Damper first, then Weight Training.
      expect(client.setMode).toHaveBeenCalledTimes(2);
      expect(client.setMode).toHaveBeenNthCalledWith(1, FakeTrainingMode.Damper);
      expect(client.setMode).toHaveBeenNthCalledWith(2, FakeTrainingMode.WeightTraining);
    });

    it('uses default 3000 ms when durationMs is omitted', async () => {
      setup('Weight Training');
      const promise = identifyCb({});

      await vi.advanceTimersByTimeAsync(3000);
      const result = await promise;

      expect(result.isError).toBeUndefined();
      const body = payload(result) as Record<string, unknown>;
      expect(body.identifiedFor).toBe(3000);
    });

    it('uses an explicit slot id when provided', async () => {
      client = makeFakeClient();
      live = makeFakeLive('Resistance Band');
      const state = makeState(client, live, 'left');
      // Add 'primary' slot to satisfy getSlot default behaviour — our call
      // will pass slot:'left' explicitly.
      const primaryClient = makeFakeClient();
      const primaryLive = makeFakeLive('Weight Training');
      (state.slots as Map<string, unknown>).set('primary', {
        slotId: 'primary',
        client: primaryClient,
        live: primaryLive,
      });
      const { placeholders, callbacks } = buildPlaceholders(['slot.identify']);
      registerSlotTools({} as McpServer, state, placeholders);
      identifyCb = callbacks.get('slot.identify')!.cb;

      const promise = identifyCb({ slot: 'left', durationMs: 500 });
      await vi.advanceTimersByTimeAsync(500);
      const result = await promise;

      expect(result.isError).toBeUndefined();
      const body = payload(result) as Record<string, unknown>;
      expect(body.slot).toBe('left');
      expect(body.previousMode).toBe('Resistance Band');
      expect(client.setMode).toHaveBeenNthCalledWith(1, FakeTrainingMode.Damper);
      expect(client.setMode).toHaveBeenNthCalledWith(2, FakeTrainingMode.ResistanceBand);
      // Primary slot's client must NOT have been touched.
      expect(primaryClient.setMode).not.toHaveBeenCalled();
    });
  });

  describe('ALREADY_IN_DAMPER', () => {
    it('returns ALREADY_IN_DAMPER when the slot is already in Damper mode', async () => {
      setup('Damper');
      const result = await identifyCb({ durationMs: 2000 });

      expect(result.isError).toBe(true);
      const body = payload(result) as Record<string, unknown>;
      expect(body.code).toBe('ALREADY_IN_DAMPER');
      // No setMode call should have been made.
      expect(client.setMode).not.toHaveBeenCalled();
    });
  });

  describe('SLOT_NOT_BOUND', () => {
    it('returns SLOT_NOT_BOUND when the requested slot is unknown', async () => {
      setup(); // sets up 'primary' slot only
      const result = await identifyCb({ slot: 'right', durationMs: 2000 });

      expect(result.isError).toBe(true);
      const body = payload(result) as Record<string, unknown>;
      // getSlot throws "Unknown slot: right" unconditionally for an
      // unregistered slot id (before the isConnected guard even runs), which
      // mapSdkError converts to code UNKNOWN — the existing convention for
      // un-coded Error throws. That is the only reachable path here (the
      // SLOT_NOT_BOUND-from-disconnected-slot case is covered separately
      // below), so assert the exact code + message rather than a
      // `/slot|right/i` alternation that would match almost any message in
      // this domain.
      expect(body.code).toBe('UNKNOWN');
      expect(String(body.message)).toBe('Unknown slot: right');
      expect(client.setMode).not.toHaveBeenCalled();
    });

    it('returns error when the slot exists but is not connected', async () => {
      setup('WeightTraining', { isConnected: false });
      const result = await identifyCb({});

      expect(result.isError).toBe(true);
      const body = payload(result) as Record<string, unknown>;
      expect(body.code).toBe('SLOT_NOT_BOUND');
      expect(client.setMode).not.toHaveBeenCalled();
    });
  });

  describe('revert failure', () => {
    it('returns ok-shape with revertWarning when the revert setMode call rejects', async () => {
      setup('Weight Training');
      let callCount = 0;
      client.setMode = vi.fn(async () => {
        callCount += 1;
        if (callCount === 2) {
          throw new Error('BLE write failed');
        }
      });

      const promise = identifyCb({ durationMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      // Tool must NOT return isError — the device is in Damper and the user
      // needs the ok-shape back so they can see the revertWarning.
      expect(result.isError).toBeUndefined();
      const body = payload(result) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.previousMode).toBe('Weight Training');
      expect(body.identifiedFor).toBe(1000);
      expect(typeof body.revertWarning).toBe('string');
      expect(String(body.revertWarning)).toMatch(/Damper/i);
    });
  });

  // ── VMCP-02.53 — multi-word modes must reverse-map, not strand in Damper ──
  //
  // The device snapshot stores the SPACED human name ('Weight Training'); the
  // revert must reverse-map that name back to its numeric mode. The old code
  // indexed the enum object by the spaced name (no-space keys) → undefined →
  // the device was left in Damper. These fail on pre-fix main and pass after.
  describe('VMCP-02.53 multi-word mode revert', () => {
    it.each([
      ['Weight Training', FakeTrainingMode.WeightTraining],
      ['Resistance Band', FakeTrainingMode.ResistanceBand],
      ['Custom Curves', FakeTrainingMode.CustomCurves],
    ] as const)(
      'reverts %s to its mode after identify (no strand)',
      async (modeName, modeValue) => {
        setup(modeName);
        const promise = identifyCb({ durationMs: 1000 });
        await vi.advanceTimersByTimeAsync(1000);
        const result = await promise;

        expect(result.isError).toBeUndefined();
        const body = payload(result) as Record<string, unknown>;
        expect(body.ok).toBe(true);
        expect(body.previousMode).toBe(modeName);
        // The revert happened, so there is NO "still in Damper" warning.
        expect(body.revertWarning).toBeUndefined();
        // Second setMode restores the ORIGINAL numeric mode — not left in Damper.
        expect(client.setMode).toHaveBeenCalledTimes(2);
        expect(client.setMode).toHaveBeenNthCalledWith(1, FakeTrainingMode.Damper);
        expect(client.setMode).toHaveBeenNthCalledWith(2, modeValue);
      },
    );

    it('guard: a single-word mode (Rowing) still reverts correctly', async () => {
      setup('Rowing');
      const promise = identifyCb({ durationMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(result.isError).toBeUndefined();
      const body = payload(result) as Record<string, unknown>;
      expect(body.previousMode).toBe('Rowing');
      expect(body.revertWarning).toBeUndefined();
      expect(client.setMode).toHaveBeenNthCalledWith(2, FakeTrainingMode.Rowing);
    });

    it('undefined prior mode defaults to Idle and reverts safely (not Damper)', async () => {
      const c = makeFakeClient();
      const l: FakeLive = { snapshotDevice: vi.fn(() => ({ trainingMode: undefined })) };
      const state = makeState(c, l);
      const { placeholders, callbacks } = buildPlaceholders(['slot.identify']);
      registerSlotTools({} as McpServer, state, placeholders);
      const cb = callbacks.get('slot.identify')!.cb;

      const promise = cb({ durationMs: 500 });
      await vi.advanceTimersByTimeAsync(500);
      const result = await promise;

      expect(result.isError).toBeUndefined();
      const body = payload(result) as Record<string, unknown>;
      expect(body.previousMode).toBe('Idle');
      expect(body.revertWarning).toBeUndefined();
      expect(c.setMode).toHaveBeenNthCalledWith(2, FakeTrainingMode.Idle);
    });
  });

  describe('INVALID_INPUT', () => {
    it('rejects durationMs below minimum (100 ms)', async () => {
      setup();
      const result = await identifyCb({ durationMs: 100 });
      expect(result.isError).toBe(true);
      const body = payload(result) as Record<string, unknown>;
      expect(body.code).toBe('INVALID_INPUT');
    });

    it('rejects durationMs above maximum (20000 ms)', async () => {
      setup();
      const result = await identifyCb({ durationMs: 20_000 });
      expect(result.isError).toBe(true);
      const body = payload(result) as Record<string, unknown>;
      expect(body.code).toBe('INVALID_INPUT');
    });
  });
});
