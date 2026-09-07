// VW-162 — the mode write must land, and be echoed by the device, before the
// other setters on that slot fire.
//
// Driven against `cascadeAcrossSlots` directly rather than through the
// `bilateral.cascade` tool so the echo timeout can be injected: the production
// bound is the 2s mode-revert window, which is not a wait worth spending in a
// unit test.
//
// The fake client models the firmware behaviour observed on 2026-09-07: a
// weight write issued while the mode write is still unacknowledged makes the
// device fall back to its previous mode.

import { describe, it, expect, vi } from 'vitest';

vi.mock('@voltras/node-sdk', () => ({
  TrainingMode: {
    Idle: 0,
    WeightTraining: 1,
    Isokinetic: 7,
  },
}));

const { cascadeAcrossSlots } = await import('../bilateral-cascade.js');
const { ModeRevertGuard } = await import('../mode-revert-guard.js');
const { TrainingMode } = await import('@voltras/node-sdk');

const FAST = { modeEchoTimeoutMs: 200, modeEchoPollMs: 5 };
const FULL_PLAN = {
  mode: TrainingMode.Isokinetic,
  weightLbs: 75,
  eccentricPercent: 30,
  chainsLbs: 20,
};

interface Recorder {
  calls: string[];
  echoDelayMs: number | null;
  /** Set when the modelled firmware fallback swallowed the pending mode echo. */
  fellBack: boolean;
}

/**
 * A slot whose device echoes the written mode back after `echoDelayMs`
 * (`null` = never echoes). `setWeight`/`setEccentric`/`setChains` record their
 * call order so a test can assert nothing fired before the echo.
 */
function makeTarget(
  slotId: string,
  opts: { echoDelayMs?: number | null; echoedMode?: number; revertOnWeight?: boolean } = {},
): {
  target: Parameters<typeof cascadeAcrossSlots>[0][number];
  rec: Recorder;
  guard: InstanceType<typeof ModeRevertGuard>;
} {
  const guard = new ModeRevertGuard();
  if (opts.echoedMode !== undefined) guard.onSettingsUpdate(opts.echoedMode as never);
  const rec: Recorder = {
    calls: [],
    echoDelayMs: opts.echoDelayMs === undefined ? 0 : opts.echoDelayMs,
    fellBack: false,
  };

  const echo = (mode: number): void => {
    if (rec.echoDelayMs === null) return;
    setTimeout(() => {
      if (!rec.fellBack) guard.onSettingsUpdate(mode as never);
    }, rec.echoDelayMs);
  };
  const client = {
    setMode: vi.fn(async (mode: number) => {
      rec.calls.push('setMode');
      echo(mode);
    }),
    setWeight: vi.fn(async () => {
      rec.calls.push('setWeight');
      // The firmware fallback: a weight write that beats the mode echo drops
      // the device back into Weight Training. Once the mode is acknowledged
      // the same write is harmless — which is exactly what the ordering buys.
      const acknowledged = guard.echoedMode() === TrainingMode.Isokinetic;
      if (opts.revertOnWeight === true && !acknowledged) {
        rec.fellBack = true;
        guard.onSettingsUpdate(TrainingMode.WeightTraining);
      }
    }),
    setEccentric: vi.fn(async () => {
      rec.calls.push('setEccentric');
    }),
    setChains: vi.fn(async () => {
      rec.calls.push('setChains');
    }),
  };
  return {
    target: { slotId, client, modeRevertGuard: guard } as never,
    rec,
    guard,
  };
}

describe('VW-162 — bilateral.cascade sequences the mode write', () => {
  it('resolves setMode and its echo before any other setter starts', async () => {
    const { target, rec } = makeTarget('left', { echoDelayMs: 20, echoedMode: TrainingMode.Idle });

    const [result] = await cascadeAcrossSlots([target], FULL_PLAN, false, FAST);

    expect(rec.calls[0]).toBe('setMode');
    expect(rec.calls.slice(1).sort()).toEqual(['setChains', 'setEccentric', 'setWeight']);
    expect(result.modeEcho).toBe('confirmed');
    expect(result.echoedAfterMs).toBeGreaterThanOrEqual(0);
    expect(result.applied.mode?.ok).toBe(true);
  });

  it('leaves the requested mode in place even when a weight write would revert it', async () => {
    // REGRESSION for the 2026-09-07 hardware failure. On the old
    // concurrent-within-slot code setWeight fires on the same tick as setMode,
    // its revert lands before the Isokinetic echo, and the guard ends the
    // cascade latched on WeightTraining.
    const { target, guard } = makeTarget('left', {
      echoDelayMs: 5,
      echoedMode: TrainingMode.Idle,
      revertOnWeight: true,
    });

    const [result] = await cascadeAcrossSlots([target], FULL_PLAN, false, FAST);

    // The claim that fails on the parent commit: the device is left in the
    // mode the cascade asked for, with no revert latched against it.
    expect(guard.echoedMode()).toBe(TrainingMode.Isokinetic);
    expect(guard.isAborted()).toBe(false);
    expect(result.modeEcho).toBe('confirmed');
  });

  it('skips the wait when the device already reports the requested mode', async () => {
    const { target, rec } = makeTarget('left', {
      echoDelayMs: null,
      echoedMode: TrainingMode.Isokinetic,
    });

    const [result] = await cascadeAcrossSlots([target], FULL_PLAN, false, FAST);

    // No echo would ever arrive here, so completing at all proves nothing waited.
    expect(result.modeEcho).toBe('skipped');
    expect(result.echoedAfterMs).toBeUndefined();
    expect(rec.calls).toHaveLength(4);
  });

  it('fails the slot and issues no other setter when the echo times out', async () => {
    const { target, rec } = makeTarget('left', {
      echoDelayMs: null,
      echoedMode: TrainingMode.Idle,
    });

    const [result] = await cascadeAcrossSlots([target], FULL_PLAN, false, FAST);

    expect(result.modeEcho).toBe('timeout');
    expect(result.applied.mode?.ok).toBe(false);
    expect(result.applied.mode?.error).toMatch(/device\.set_mode/);
    expect(result.applied.mode?.error).toMatch(/device\.get_state/);
    expect(result.applied.weightLbs).toBeUndefined();
    expect(rec.calls).toEqual(['setMode']);
  });

  it('a late echo still clears the guard the timed-out cascade left armed', async () => {
    const { target, guard } = makeTarget('left', {
      echoDelayMs: null,
      echoedMode: TrainingMode.Idle,
    });

    await cascadeAcrossSlots([target], FULL_PLAN, false, FAST);
    guard.onSettingsUpdate(TrainingMode.Isokinetic as never);

    expect(guard.isAborted()).toBe(false);
    expect(guard.echoedMode()).toBe(TrainingMode.Isokinetic);
  });

  it('a timed-out mode write on one slot aborts the other slot under abortOnFirstFailure', async () => {
    const a = makeTarget('left', { echoDelayMs: null, echoedMode: TrainingMode.Idle });
    const b = makeTarget('right', { echoDelayMs: 400, echoedMode: TrainingMode.Idle });

    const results = await cascadeAcrossSlots([a.target, b.target], FULL_PLAN, true, FAST);

    expect(results[0].modeEcho).toBe('timeout');
    expect(a.rec.calls).toEqual(['setMode']);
    expect(results[1].applied.weightLbs).toBeUndefined();
  });

  it('a rejected mode write still short-circuits the slot under abortOnFirstFailure', async () => {
    const { target, rec } = makeTarget('left', { echoedMode: TrainingMode.Idle });
    (target.client.setMode as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('BLE write failed'),
    );

    const [result] = await cascadeAcrossSlots([target], FULL_PLAN, true, FAST);

    expect(result.applied.mode?.ok).toBe(false);
    expect(result.applied.weightLbs).toBeUndefined();
    expect(rec.calls).toEqual([]);
  });

  it('slots still run concurrently with each other', async () => {
    const a = makeTarget('left', { echoDelayMs: 30, echoedMode: TrainingMode.Idle });
    const b = makeTarget('right', { echoDelayMs: 30, echoedMode: TrainingMode.Idle });

    const startedAt = Date.now();
    const results = await cascadeAcrossSlots([a.target, b.target], FULL_PLAN, false, FAST);

    expect(results.map((r) => r.modeEcho)).toEqual(['confirmed', 'confirmed']);
    // Two sequential 30ms waits would exceed the 200ms budget far less
    // ambiguously than this bound, but the machine-independent claim is just
    // that the two waits overlapped.
    expect(Date.now() - startedAt).toBeLessThan(120);
  });
});
