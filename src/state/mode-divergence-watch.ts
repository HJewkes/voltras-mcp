// Mode-divergence watch — VMCP-02.09c.
//
// The device's *requested* mode (cmd=0x10 cascade echo, surfaced as
// `DeviceSnapshot.trainingMode`) and its *applied* mode (cmd=0x07 state-dump
// byte, `DeviceSnapshot.trainingModeRaw`) can diverge: the user asks for
// Isokinetic but the device keeps running Weight Training. VMCP-02.09a made
// that visible on set/state events (`requested_mode` vs `active_mode`); this
// watch makes it *actionable* by emitting a `mode_diverged` channel event when
// the two disagree for longer than a debounce window.
//
// Modeled on `ModeRevertGuard`: one instance per slot, event-driven (no
// internal timers), fed from the bridge. `onRequested` is called from
// `onSettingsUpdate` (cmd=0x10) and `onApplied` from `onStateDump` (cmd=0x07);
// each returns a `ModeDivergence` to publish, or `null`. A mode switch
// legitimately passes through a brief requested≠applied gap while the device
// settles, so only a divergence that *persists* past the window emits, and it
// emits once per episode (re-armable — clears when the modes reconverge).
//
// Deliberately free of a `@voltras/node-sdk` value-import (Idle is the literal
// `0`, not `TrainingMode.Idle`) so this module — which lands on `SlotState`
// and thus in every tool's import graph — never widens the SDK mock surface
// the tool tests stub. The byte/enum values for Idle/0 agree across both
// streams, so the literal is exact.

import { MODE_REVERT_WINDOW_MS } from './mode-revert-guard.js';

/**
 * Persistence window before a requested≠applied disagreement is treated as a
 * real divergence (rather than the transient gap a legitimate mode switch
 * passes through). Reuses `MODE_REVERT_WINDOW_MS` (2000ms) for consistency
 * with the sibling mode-revert detector.
 */
export const MODE_DIVERGENCE_WINDOW_MS = MODE_REVERT_WINDOW_MS;

/**
 * cmd=0x07 / cmd=0x10 value for Idle / transitional / mid-mode-switch. A
 * literal rather than `TrainingMode.Idle` — see module header. Either side
 * reading Idle means "no settled mode to compare", so divergence tracking is
 * suspended.
 */
const IDLE_MODE = 0;

/** A detected, debounced divergence — handed to the bridge to publish. */
export interface ModeDivergence {
  /** Requested mode (cmd=0x10 `TrainingMode` enum value). */
  requested: number;
  /** Applied mode (cmd=0x07 state-dump byte). */
  active: number;
  /** How long the modes had disagreed at emit time, in ms (≥ the window). */
  divergedForMs: number;
}

/**
 * Per-slot detector of requested-vs-applied training-mode divergence. Tracks
 * the latest known value from each stream; when both are known, both settled
 * (non-Idle), and they disagree past the window, returns a `ModeDivergence`
 * exactly once. Reconvergence (or either side going Idle) clears the episode
 * so the next persistent divergence re-arms.
 */
export class ModeDivergenceWatch {
  private requested: number | undefined = undefined;
  private active: number | undefined = undefined;
  private divergedSince: number | null = null;
  private emitted = false;

  /**
   * @param now Wall-clock provider — defaulted to `Date.now`, parameterised so
   *   unit tests drive the window without sleeping.
   * @param windowMs Persistence window; defaulted to `MODE_DIVERGENCE_WINDOW_MS`.
   *   Tests (and the bridge integration tests) can pass `0` to make any
   *   settled disagreement emit on the first observation.
   */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs: number = MODE_DIVERGENCE_WINDOW_MS,
  ) {}

  /**
   * Record the latest requested mode (cmd=0x10). `undefined` (a settings
   * update carrying no trainingMode) is ignored — it does not clear state.
   */
  onRequested(mode: number | undefined): ModeDivergence | null {
    if (mode === undefined) return null;
    this.requested = mode;
    return this.evaluate();
  }

  /**
   * Record the latest applied mode (cmd=0x07 state-dump byte). `undefined`
   * is ignored. Transitional (Idle/0) frames are already dropped by the
   * bridge before this is called, but Idle is handled defensively in
   * `evaluate` regardless.
   */
  onApplied(modeRaw: number | undefined): ModeDivergence | null {
    if (modeRaw === undefined) return null;
    this.active = modeRaw;
    return this.evaluate();
  }

  /** Drop all state. Used on disconnect / slot reset and in tests. */
  reset(): void {
    this.requested = undefined;
    this.active = undefined;
    this.clearEpisode();
  }

  private clearEpisode(): void {
    this.divergedSince = null;
    this.emitted = false;
  }

  private evaluate(): ModeDivergence | null {
    if (this.requested === undefined || this.active === undefined) return null;
    // Either side Idle ⇒ no settled mode to compare; suspend + clear so a
    // mid-switch pass-through doesn't count toward an episode.
    if (this.requested === IDLE_MODE || this.active === IDLE_MODE) {
      this.clearEpisode();
      return null;
    }
    if (this.requested === this.active) {
      // Converged (or reconverged) — clear so the next disagreement re-arms.
      this.clearEpisode();
      return null;
    }
    // Settled disagreement.
    if (this.divergedSince === null) {
      this.divergedSince = this.now();
    }
    const divergedForMs = this.now() - this.divergedSince;
    if (!this.emitted && divergedForMs >= this.windowMs) {
      this.emitted = true;
      return { requested: this.requested, active: this.active, divergedForMs };
    }
    return null;
  }
}
