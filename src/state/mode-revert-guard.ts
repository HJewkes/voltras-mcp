// Mode-revert guard — Bug 22 (HIGH safety).
//
// The Voltra firmware can silently revert the training mode after a
// `device.set_mode` write. The most prominent observed case is Rowing:
// the SDK writes the strength-mode GO command at session.start, the device
// briefly accepts but autonomously reverts to WeightTraining and engages
// the cable at the configured weight. The user sees a load on a mode they
// did not ask for — a HIGH-severity safety issue.
//
// This guard sits at the bridge layer (independent of any in-SDK reassert
// logic — see B2's Rowing-specific safety guard) and watches the
// `onSettingsUpdate` stream for trainingMode drift after the user has
// requested a mode via `session.start` or `set.start`. When the actual
// mode diverges from the requested mode within the configured detection
// window, the guard latches into the `aborted` state. The next `set.start`
// invocation consults the latch via `consumeAbort()`, refuses to engage the
// motor, and emits a `set_aborted_by_mode_revert` channel event so PT Claude
// can explain the safety abort to the user.
//
// Design follows the sketch in
// `voltra-private/research/safety-state-error-frames-2026-05-07-android-deep.md`
// (A11) — the firmware exposes no error/fault frames, so the SDK / bridge
// must invent its own safety surface from positive telemetry signals.
//
// One guard instance per slot: bilateral lifts run two devices and each
// one's mode-revert detection is independent.

import type { TrainingMode } from '@voltras/node-sdk';

/**
 * Detection window for mode revert. After the user requests a mode (via
 * session.start or set.start), the guard watches subsequent settings_update
 * events for `DETECTION_WINDOW_MS` and latches an abort if the device emits
 * a different trainingMode within that window.
 *
 * 2000ms matches the A11 sketch and accommodates the BLE round-trip plus
 * the device's autonomous-revert latency (observed at ~300–800ms in the
 * 2026-05-06 captures). Wider would risk catching legitimate user-initiated
 * mode switches; narrower would miss the slower revert reports.
 */
export const MODE_REVERT_WINDOW_MS = 2000;

/** Snapshot of an abort event for the channel-event payload. */
export interface ModeRevertAbort {
  requested: TrainingMode;
  actual: TrainingMode;
  timestampMs: number;
}

/** A single requested-mode entry the guard is currently watching. */
interface RequestedEntry {
  mode: TrainingMode;
  at: number;
}

/**
 * Per-slot mode-revert detector. Wired into the slot's bridge subscription
 * (event-bridge.ts) and consulted by `set.start` before engaging the motor.
 *
 * The guard tracks at most ONE in-flight requested mode at a time. A second
 * `arm()` call (e.g., session.start followed by set.start) overwrites the
 * first entry — the guard always watches the most recently requested mode.
 *
 * Latched abort state persists until `consumeAbort()` is called. A pending
 * abort blocks every set.start until consumed, which is intentional: a
 * detected mode revert is a hard safety stop, not a soft notification, and
 * the user should be told what happened before any further load engagement.
 */
export class ModeRevertGuard {
  private requested: RequestedEntry | null = null;
  private aborted: ModeRevertAbort | null = null;

  /**
   * Wall-clock provider — defaulted to `Date.now` and parameterised so unit
   * tests can drive the window deterministically without sleep.
   */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Record a requested mode and start the detection window. Subsequent
   * `onSettingsUpdate` calls within `MODE_REVERT_WINDOW_MS` whose
   * trainingMode differs from `mode` will latch an abort.
   *
   * Calling `arm` while an abort is already latched does NOT clear the
   * abort by itself — only an in-window matched-mode echo (see
   * `onSettingsUpdate`) or `consumeAbort()` does — but DOES reset the
   * requested entry to the new mode so a fresh detection cycle starts.
   * This keeps the abort surface live until either the user's setter
   * cascade is corroborated by the device or set.start consumes it.
   */
  arm(mode: TrainingMode): void {
    this.requested = { mode, at: this.now() };
  }

  /**
   * Process a settings_update event. If we have an in-flight requested
   * mode, the window has not expired, AND the incoming trainingMode
   * differs from the requested value, latch an abort.
   *
   * VMCP-02.14: when the device echoes back the requested mode inside
   * the detection window, ANY previously latched abort is also cleared.
   * A matched-mode cascade is the user's recovery signal — the
   * underlying revert has been resolved (e.g., the user re-engaged the
   * intended mode on the unit) and subsequent `set.start` calls should
   * no longer be blocked. Without this, the latch would only clear via
   * `session_end → session_start`, forcing callers to drop the session
   * to recover.
   *
   * `trainingMode` is the value lifted from the SDK's
   * `DeviceSettings.trainingMode` field (the high-level setting after
   * cmd=0x10 cascade decode). `undefined` means the settings_update
   * carried no trainingMode at all (e.g., a damperLevel-only update) —
   * those events do not affect the guard.
   */
  onSettingsUpdate(trainingMode: TrainingMode | undefined): void {
    if (this.requested === null) return;
    if (trainingMode === undefined) return;
    const elapsed = this.now() - this.requested.at;
    if (elapsed > MODE_REVERT_WINDOW_MS) {
      // Window expired without divergence — clear the requested entry so
      // we don't keep evaluating against stale state.
      this.requested = null;
      return;
    }
    if (trainingMode === this.requested.mode) {
      // Confirmed: device echoes back the requested mode. Clear the
      // entry AND any previously latched abort — a matched-mode cascade
      // is the recovery signal that supersedes the prior revert
      // (VMCP-02.14).
      this.requested = null;
      this.aborted = null;
      return;
    }
    // Divergence inside the window — latch the abort. Keep the requested
    // entry untouched so a subsequent settings_update doesn't re-trigger
    // (the latch is the source of truth from here until consumeAbort).
    this.aborted = {
      requested: this.requested.mode,
      actual: trainingMode,
      timestampMs: this.now(),
    };
    this.requested = null;
  }

  /** True if a mode revert has been detected and not yet consumed. */
  isAborted(): boolean {
    return this.aborted !== null;
  }

  /**
   * Peek at the latched abort state without consuming it. Returns a
   * snapshot (defensive copy) of the latched abort or `null` when no
   * abort is pending. Used by `device.get_state` so callers can see
   * whether the next `set.start` will be refused without triggering the
   * consume side effect that the actual `set.start` path relies on.
   */
  peekAbort(): ModeRevertAbort | null {
    if (this.aborted === null) return null;
    return { ...this.aborted };
  }

  /**
   * Read the latched abort state and clear it. Returns `null` when no
   * abort is pending. Call from `set.start` before engaging the motor: a
   * non-null return is the signal to refuse the engage and emit a
   * `set_aborted_by_mode_revert` channel event with the returned payload.
   */
  consumeAbort(): ModeRevertAbort | null {
    const abort = this.aborted;
    this.aborted = null;
    return abort;
  }

  /** Drop both in-flight and latched state. Used in tests / on disconnect. */
  reset(): void {
    this.requested = null;
    this.aborted = null;
  }
}
