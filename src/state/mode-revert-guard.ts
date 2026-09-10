// Mode-revert guard — Bug 22 (HIGH safety).
//
// The Voltra firmware can silently revert the training mode after a
// `device.set_mode` write. The most prominent observed case is Rowing:
// the SDK engages the motor at session.start, the device briefly accepts
// but autonomously reverts to WeightTraining and engages the cable at the
// configured weight. The user sees a load on a mode they did not ask for —
// a HIGH-severity safety issue.
//
// This guard sits at the bridge layer (independent of any in-SDK reassert
// logic — see B2's Rowing-specific safety guard) and watches the
// `onSettingsUpdate` stream for trainingMode drift after the user has
// requested a mode via `session.start` or `set.start`. When the actual
// mode diverges from the requested mode within the configured detection
// window, the guard latches into the `aborted` state. Every subsequent
// `set.start` consults the latch via `peekAbort()` + `isStillReverted()`,
// refuses to engage the motor, and emits a `set_aborted_by_mode_revert`
// channel event so PT Claude can explain the safety abort to the user.
//
// Design follows the A11 sketch — the device surfaces no fault or error
// signal of its own, so the SDK / bridge must invent its own safety surface
// from positive telemetry signals.
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
 * VW-178: latched abort state clears ONLY when the revert actually recovers —
 * the device echoes the requested mode back (see `onSettingsUpdate`), `arm()`
 * asks for a mode the device is already echoing, or `reset()` drops the slot's
 * state. Nothing clears it on read. A pending abort therefore blocks EVERY
 * set.start until then, which is intentional: an UNRESOLVED mode revert is a
 * hard safety stop, not a soft notification, and retrying a refused set.start
 * (the natural agent reaction) must not be what defeats it.
 */
export class ModeRevertGuard {
  private requested: RequestedEntry | null = null;
  private aborted: ModeRevertAbort | null = null;
  private lastEcho: TrainingMode | undefined = undefined;

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
   * abort by itself — only a matched-mode echo (see `onSettingsUpdate`)
   * does — but DOES reset the requested entry to the new mode so a fresh
   * detection cycle starts. This keeps the abort surface live until the
   * user's setter cascade is corroborated by the device.
   *
   * VW-163: the one exception is arming for the mode the device is ALREADY
   * echoing. The revert the latch recorded is over — the device sits in the
   * mode being asked for — so holding the latch would block the next
   * set.start over a resolved condition.
   */
  arm(mode: TrainingMode): void {
    this.requested = { mode, at: this.now() };
    if (this.lastEcho === mode) {
      this.aborted = null;
    }
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
   * `DeviceSettings.trainingMode` field (the high-level setting the SDK
   * decodes out of the echo). `undefined` means the settings_update
   * carried no trainingMode at all (e.g., a damperLevel-only update) —
   * those events do not affect the guard.
   */
  onSettingsUpdate(trainingMode: TrainingMode | undefined): void {
    if (trainingMode === undefined) return;
    this.lastEcho = trainingMode;
    // VW-163: recovery is not bounded by the detection window. The device
    // echoing the mode the latch recorded as REQUESTED means the revert has
    // resolved, whether that echo lands 200ms or 20 minutes later. Before
    // this, a latch could only clear inside a 2s window after a fresh
    // `arm()`, so a hardware recovery that arrived late blocked every
    // subsequent set.start until the session was cycled.
    if (this.aborted !== null && this.aborted.requested === trainingMode) {
      this.aborted = null;
    }
    if (this.requested === null) return;
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
    // (the latch is the source of truth from here until it recovers).
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
   * VW-178: is the latched revert still the device's live condition — an
   * abort is latched AND the device is still echoing the mode it reverted
   * TO. This is the refusal predicate for `set.start`, replacing the old
   * read-and-clear `consumeAbort()`: a latch that nothing consumes is what
   * makes a retried `set.start` refuse again instead of engaging the motor
   * in the wrong mode.
   *
   * False once the echo moves on, so a resolved revert never blocks a set
   * (VW-163 semantics, unchanged).
   */
  isStillReverted(): boolean {
    return this.aborted !== null && this.lastEcho === this.aborted.actual;
  }

  /**
   * The device's most recently echoed training mode, or `undefined` before
   * the first settings_update carrying one. Read by `bilateral.cascade` to
   * decide whether a planned mode is already the live one (skip the echo
   * wait) and to detect the echo landing after the mode write (VW-162).
   */
  echoedMode(): TrainingMode | undefined {
    return this.lastEcho;
  }

  /** Drop in-flight, latched and echo state. Used in tests / on disconnect. */
  reset(): void {
    this.requested = null;
    this.aborted = null;
    this.lastEcho = undefined;
  }
}
