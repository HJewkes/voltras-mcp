// Unit tests for the per-slot mode-revert guard (Bug 22 — HIGH safety).
//
// The guard sits behind the bridge's `onSettingsUpdate` listener and
// records mode-revert events the device emits inside the detection window
// after the user requested a mode at session.start / set.start. Tests use
// a controllable wall-clock so we can drive the window deterministically
// without sleep.

import { describe, it, expect } from 'vitest';

vi.mock('@voltras/node-sdk', () => ({
  TrainingMode: {
    Idle: 0,
    WeightTraining: 1,
    ResistanceBand: 2,
    Rowing: 3,
    Damper: 4,
    CustomCurves: 6,
    Isokinetic: 7,
    Isometric: 8,
  },
}));

import { vi } from 'vitest';

const { ModeRevertGuard, MODE_REVERT_WINDOW_MS } = await import('../mode-revert-guard.js');
const { TrainingMode } = await import('@voltras/node-sdk');

function makeGuard(): {
  guard: InstanceType<typeof ModeRevertGuard>;
  setNow: (ms: number) => void;
} {
  let now = 1_000_000;
  const guard = new ModeRevertGuard(() => now);
  return {
    guard,
    setNow: (ms) => {
      now = ms;
    },
  };
}

describe('ModeRevertGuard', () => {
  it('starts with no abort and no requested mode', () => {
    const { guard } = makeGuard();
    expect(guard.isAborted()).toBe(false);
    expect(guard.peekAbort()).toBeNull();
  });

  it('latches an abort when settings_update reports a different mode within the window', () => {
    const { guard, setNow } = makeGuard();
    guard.arm(TrainingMode.Rowing);

    // 100ms after arm — well inside the window. The device emits a settings
    // update with WeightTraining instead of the requested Rowing.
    setNow(1_000_100);
    guard.onSettingsUpdate(TrainingMode.WeightTraining);

    expect(guard.isAborted()).toBe(true);
    const abort = guard.peekAbort();
    expect(abort).not.toBeNull();
    expect(abort!.requested).toBe(TrainingMode.Rowing);
    expect(abort!.actual).toBe(TrainingMode.WeightTraining);
    expect(abort!.timestampMs).toBe(1_000_100);
  });

  it('VW-178: reading the latch never clears it', () => {
    const { guard } = makeGuard();
    guard.arm(TrainingMode.Rowing);
    guard.onSettingsUpdate(TrainingMode.WeightTraining);

    guard.peekAbort();
    guard.isStillReverted();
    expect(guard.isAborted()).toBe(true);
    expect(guard.peekAbort()).not.toBeNull();
    expect(guard.isStillReverted()).toBe(true);
  });

  it('VW-178: isStillReverted goes false once the device echoes some other mode', () => {
    const { guard } = makeGuard();
    guard.arm(TrainingMode.Rowing);
    guard.onSettingsUpdate(TrainingMode.WeightTraining);
    expect(guard.isStillReverted()).toBe(true);

    // Device moves on to a third mode — the recorded revert is over even
    // though the latch itself has not been cleared by a matching echo.
    guard.onSettingsUpdate(TrainingMode.Isokinetic);
    expect(guard.isStillReverted()).toBe(false);
    expect(guard.isAborted()).toBe(true);
  });

  it('VW-178: a matching echo clears the latch and isStillReverted', () => {
    const { guard } = makeGuard();
    guard.arm(TrainingMode.Rowing);
    guard.onSettingsUpdate(TrainingMode.WeightTraining);

    guard.onSettingsUpdate(TrainingMode.Rowing);
    expect(guard.isAborted()).toBe(false);
    expect(guard.isStillReverted()).toBe(false);
  });

  it('VW-178: arming for the mode the device already echoes clears the latch', () => {
    const { guard } = makeGuard();
    guard.arm(TrainingMode.Rowing);
    guard.onSettingsUpdate(TrainingMode.WeightTraining);

    guard.arm(TrainingMode.WeightTraining);
    expect(guard.isAborted()).toBe(false);
  });

  it('VW-178: isStillReverted is false with no latch at all', () => {
    const { guard } = makeGuard();
    guard.onSettingsUpdate(TrainingMode.WeightTraining);
    expect(guard.isStillReverted()).toBe(false);
  });

  it('echoedMode reports the last observed trainingMode', () => {
    const { guard } = makeGuard();
    expect(guard.echoedMode()).toBeUndefined();
    guard.onSettingsUpdate(TrainingMode.Isokinetic);
    expect(guard.echoedMode()).toBe(TrainingMode.Isokinetic);
    guard.reset();
    expect(guard.echoedMode()).toBeUndefined();
  });

  it('does NOT latch when the reported mode matches the requested mode', () => {
    const { guard } = makeGuard();
    guard.arm(TrainingMode.Rowing);
    guard.onSettingsUpdate(TrainingMode.Rowing);

    expect(guard.isAborted()).toBe(false);
  });

  it('does NOT latch when the settings_update arrives outside the detection window', () => {
    const { guard, setNow } = makeGuard();
    guard.arm(TrainingMode.Rowing);

    // Advance past the window.
    setNow(1_000_000 + MODE_REVERT_WINDOW_MS + 1);
    guard.onSettingsUpdate(TrainingMode.WeightTraining);

    expect(guard.isAborted()).toBe(false);
  });

  it('ignores settings_update events with no trainingMode field', () => {
    const { guard } = makeGuard();
    guard.arm(TrainingMode.Rowing);
    guard.onSettingsUpdate(undefined);

    expect(guard.isAborted()).toBe(false);
    // Subsequent legitimate divergence still latches.
    guard.onSettingsUpdate(TrainingMode.WeightTraining);
    expect(guard.isAborted()).toBe(true);
  });

  it('ignores settings_update events when no mode has been requested', () => {
    const { guard } = makeGuard();
    guard.onSettingsUpdate(TrainingMode.WeightTraining);
    expect(guard.isAborted()).toBe(false);
  });

  it('arm() while aborted does NOT clear the latched abort', () => {
    const { guard } = makeGuard();
    guard.arm(TrainingMode.Rowing);
    guard.onSettingsUpdate(TrainingMode.WeightTraining);
    expect(guard.isAborted()).toBe(true);

    // A user re-arming (e.g., another session.start) before the abort is
    // consumed — the latch must persist so set.start sees it.
    guard.arm(TrainingMode.Rowing);
    expect(guard.isAborted()).toBe(true);
  });

  it('arm() resets the requested entry so a new detection cycle starts', () => {
    const { guard, setNow } = makeGuard();
    guard.arm(TrainingMode.Rowing);

    // 1500ms later — still inside the original window if we were watching
    // Rowing, but we re-arm with WeightTraining first.
    setNow(1_001_500);
    guard.arm(TrainingMode.WeightTraining);

    // A WeightTraining settings_update should now confirm and clear.
    setNow(1_001_600);
    guard.onSettingsUpdate(TrainingMode.WeightTraining);
    expect(guard.isAborted()).toBe(false);
  });

  it('a confirming settings_update clears the requested entry (no false-positive on later updates)', () => {
    const { guard, setNow } = makeGuard();
    guard.arm(TrainingMode.Rowing);

    // Confirm the request.
    setNow(1_000_100);
    guard.onSettingsUpdate(TrainingMode.Rowing);

    // Later, a DIFFERENT settings_update arrives — must NOT latch as a
    // mode revert because the user-requested mode was already confirmed
    // and the window is closed.
    setNow(1_000_200);
    guard.onSettingsUpdate(TrainingMode.WeightTraining);
    expect(guard.isAborted()).toBe(false);
  });

  it('reset() clears both in-flight and latched state', () => {
    const { guard } = makeGuard();
    guard.arm(TrainingMode.Rowing);
    guard.onSettingsUpdate(TrainingMode.WeightTraining);
    expect(guard.isAborted()).toBe(true);

    guard.reset();
    expect(guard.isAborted()).toBe(false);
    expect(guard.peekAbort()).toBeNull();
  });

  it('uses Date.now by default when no clock is supplied', () => {
    const guard = new ModeRevertGuard();
    guard.arm(TrainingMode.Rowing);
    // Synchronous follow-up — same Date.now tick, well within the window.
    guard.onSettingsUpdate(TrainingMode.WeightTraining);
    expect(guard.isAborted()).toBe(true);
  });

  // ── VMCP-02.14: latch auto-clear on matched-mode cascade ────────────────
  describe('VMCP-02.14 — auto-clear on matched-mode cascade', () => {
    it('clears a previously latched abort when a subsequent arm() + matched-mode echo lands', () => {
      const { guard, setNow } = makeGuard();
      // Initial revert: requested Rowing, device reverted to WT.
      guard.arm(TrainingMode.Rowing);
      setNow(1_000_100);
      guard.onSettingsUpdate(TrainingMode.WeightTraining);
      expect(guard.isAborted()).toBe(true);

      // User re-issues the cascade requesting Rowing. The device now
      // echoes Rowing back inside the window — the latch should clear
      // automatically (the recovery signal from VMCP-02.14).
      setNow(1_001_000);
      guard.arm(TrainingMode.Rowing);
      setNow(1_001_100);
      guard.onSettingsUpdate(TrainingMode.Rowing);
      expect(guard.isAborted()).toBe(false);
      expect(guard.peekAbort()).toBeNull();
    });

    it('a non-matching echo does NOT auto-clear; it re-latches with the new revert', () => {
      const { guard, setNow } = makeGuard();
      guard.arm(TrainingMode.Rowing);
      setNow(1_000_100);
      guard.onSettingsUpdate(TrainingMode.WeightTraining);
      expect(guard.isAborted()).toBe(true);

      // User re-arms for Isokinetic, device reverts again — the latch
      // must STAY latched (re-armed with the new requested/actual pair).
      setNow(1_001_000);
      guard.arm(TrainingMode.Isokinetic);
      setNow(1_001_100);
      guard.onSettingsUpdate(TrainingMode.WeightTraining);
      expect(guard.isAborted()).toBe(true);
      const abort = guard.peekAbort();
      expect(abort!.requested).toBe(TrainingMode.Isokinetic);
      expect(abort!.actual).toBe(TrainingMode.WeightTraining);
    });

    it('peekAbort returns a copy without clearing the latch', () => {
      const { guard, setNow } = makeGuard();
      guard.arm(TrainingMode.Rowing);
      setNow(1_000_100);
      guard.onSettingsUpdate(TrainingMode.WeightTraining);

      const peeked = guard.peekAbort();
      expect(peeked).not.toBeNull();
      expect(peeked!.requested).toBe(TrainingMode.Rowing);
      expect(peeked!.actual).toBe(TrainingMode.WeightTraining);
      // Still latched after peek.
      expect(guard.isAborted()).toBe(true);
      // Mutating the returned object must not affect internal state.
      peeked!.actual = TrainingMode.Idle;
      expect(guard.peekAbort()!.actual).toBe(TrainingMode.WeightTraining);
    });

    it('peekAbort returns null when no abort is latched', () => {
      const { guard } = makeGuard();
      expect(guard.peekAbort()).toBeNull();
    });
  });

  // ── VW-163: recovery is not bounded by the detection window ─────────────
  describe('VW-163 — late recovery clears the latch', () => {
    it('clears the latch on a matching echo that arrives long after the window closed', () => {
      const { guard, setNow } = makeGuard();
      guard.arm(TrainingMode.Isokinetic);
      setNow(1_000_100);
      guard.onSettingsUpdate(TrainingMode.WeightTraining);
      expect(guard.isAborted()).toBe(true);

      // Ten minutes later the device finally echoes Isokinetic. Before
      // VW-163 this left the latch armed and every set.start refused.
      setNow(1_600_000);
      guard.onSettingsUpdate(TrainingMode.Isokinetic);
      expect(guard.isAborted()).toBe(false);
    });

    it('clears the latch when arming for the mode the device is already echoing', () => {
      const { guard, setNow } = makeGuard();
      guard.arm(TrainingMode.Isokinetic);
      setNow(1_000_100);
      guard.onSettingsUpdate(TrainingMode.WeightTraining);
      expect(guard.isAborted()).toBe(true);

      // The user asks for the mode the device already sits in — nothing is
      // reverting any more.
      setNow(1_500_000);
      guard.arm(TrainingMode.WeightTraining);
      expect(guard.isAborted()).toBe(false);
    });

    it('holds the latch while the device keeps echoing the reverted-to mode', () => {
      const { guard, setNow } = makeGuard();
      guard.arm(TrainingMode.Isokinetic);
      setNow(1_000_100);
      guard.onSettingsUpdate(TrainingMode.WeightTraining);

      setNow(1_400_000);
      guard.onSettingsUpdate(TrainingMode.WeightTraining);
      expect(guard.isAborted()).toBe(true);
    });
  });
});
