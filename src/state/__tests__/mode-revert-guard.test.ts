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
    expect(guard.consumeAbort()).toBeNull();
  });

  it('latches an abort when settings_update reports a different mode within the window', () => {
    const { guard, setNow } = makeGuard();
    guard.arm(TrainingMode.Rowing);

    // 100ms after arm — well inside the window. The device emits a settings
    // update with WeightTraining instead of the requested Rowing.
    setNow(1_000_100);
    guard.onSettingsUpdate(TrainingMode.WeightTraining);

    expect(guard.isAborted()).toBe(true);
    const abort = guard.consumeAbort();
    expect(abort).not.toBeNull();
    expect(abort!.requested).toBe(TrainingMode.Rowing);
    expect(abort!.actual).toBe(TrainingMode.WeightTraining);
    expect(abort!.timestampMs).toBe(1_000_100);
  });

  it('clears the latch on consumeAbort (single-fire safety)', () => {
    const { guard } = makeGuard();
    guard.arm(TrainingMode.Rowing);
    guard.onSettingsUpdate(TrainingMode.WeightTraining);

    guard.consumeAbort(); // first read: returns abort
    expect(guard.isAborted()).toBe(false);
    expect(guard.consumeAbort()).toBeNull();
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
    expect(guard.consumeAbort()).toBeNull();
  });

  it('uses Date.now by default when no clock is supplied', () => {
    const guard = new ModeRevertGuard();
    guard.arm(TrainingMode.Rowing);
    // Synchronous follow-up — same Date.now tick, well within the window.
    guard.onSettingsUpdate(TrainingMode.WeightTraining);
    expect(guard.isAborted()).toBe(true);
  });
});
