// Input schemas for `set.*` tools.
//
// All set operations target the currently active set (or the live device for
// `set.start`). None of these tools accept explicit set metadata — set
// metadata (training mode, weight, chains, eccentric) is auto-populated from
// `state.live.snapshotDevice()` at handler time. Adding fields here would
// duplicate live device state and create drift between the snapshot and the
// stored set.

import { z } from 'zod';

import { SlotIdSchema } from './common.js';

/**
 * Trigger DSL — server-evaluated conditions a coach can register at
 * `set.start` time. Each spec is a discriminated union by `type` so Zod
 * errors stay clean and the bridge's evaluator can narrow on the tag without
 * extra checks.
 *
 * As of the F14/F15 rewrite, triggers are **advisory cues only**. They
 * publish a channel event (`set_target_reached`, `velocity_loss_exceeded`)
 * when the condition matches; the bridge never writes `Workout.STOP` from a
 * rep-evaluation path. The model voice-coaches the user, the user finishes
 * naturally, the device's `aa 85 5f` disengage signal becomes the canonical
 * set close. Force-stopping mid-rep on a rep-count match ripped the cable
 * mid-eccentric on hardware (2026-05-11 capture); the user explicitly chose
 * to drop the force-stop semantics rather than refine the bandaid.
 *
 * Two trigger types:
 *   * `rep_count_reached` — fires when the Nth rep is finalized (intrinsic
 *     ECC->CONC delay applies; rep N is "done" only once rep N+1 begins).
 *   * `velocity_loss_exceeded` — fires when the just-finalized rep's peak
 *     concentric velocity drops `pct`% below the highest peak seen so far in
 *     the set. Range 1..95 — below 1% is sample noise; above 95% almost
 *     always means the lifter has stopped exercising rather than slowed.
 *
 * The legacy `idle_timeout_ms` trigger has been lifted to a dedicated field
 * (`WatchConfig.inactivityTimeoutMs`) since it's the only force-close path
 * and there's only ever one per set.
 */
export const TriggerSpec = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('rep_count_reached'),
    value: z.number().int().min(1).max(100),
  }),
  z.object({
    type: z.literal('velocity_loss_exceeded'),
    pct: z.number().min(1).max(95),
  }),
]);
export type TriggerSpec = z.infer<typeof TriggerSpec>;

/**
 * Watch config attached to a set at start time. Triggers in `notifyOn` are
 * **advisory cues only** — when they match, the bridge publishes a channel
 * event so the model can voice-coach the user, but it does **not** finalize
 * the set. The user finishes their cycle naturally; the device's per-set
 * disengage signal (`aa 85 5f` in WT/RB/Damper) becomes the canonical close.
 *
 * `inactivityTimeoutMs` is the only force-close path retained from the old
 * trigger DSL. When no SDK activity (`onInProgress` / `onSetSummary` /
 * rep boundary) lands for this many milliseconds, the bridge's per-set
 * watchdog finalizes the set as `partial` / `inactivity_timeout`. This is
 * a safety net for truly abandoned sets — the user has walked away and the
 * server must free the slot.
 *
 * Triggers in `notifyOn` dedupe by `(type, value-or-pct)` — registering
 * `rep_count_reached:8` twice fires once. The bridge tracks fired triggers
 * on the active set itself.
 *
 * Migration note: pre-rewrite callers passing `stopOn` get a silent no-op
 * (Zod strips unknown keys by default), which matches the new "advisory"
 * semantics. They will continue to receive `set_target_reached` cues
 * because the trigger fires on whichever array carries it; coaches that
 * relied on the auto-stop behavior must now react to the cue themselves
 * or rely on the natural device-signal close.
 */
export const WatchConfig = z.object({
  notifyOn: z.array(TriggerSpec).default([]),
  /**
   * Inactivity safety net, in milliseconds (1s..10min). When no SDK
   * activity has touched the active set for this long, the bridge's
   * watchdog finalizes the set with `partialReason='inactivity_timeout'`
   * and disengages the motor. Optional; absent ⇒ no inactivity force-close
   * (the bridge's default 90s safety net still applies via
   * `SET_INACTIVITY_TIMEOUT_MS`).
   */
  inactivityTimeoutMs: z.number().int().min(1000).max(600_000).optional(),
});
export type WatchConfig = z.infer<typeof WatchConfig>;

/**
 * Input for `set.start`. Optional `watch` config registers server-evaluated
 * advisory triggers for the new set plus an optional inactivity timeout;
 * without it, the set has no notify semantics. Set metadata itself (training
 * mode, weight, chains, eccentric) still derives from the live device
 * snapshot at handler time.
 */
export const SetStartInput = z.object({
  watch: WatchConfig.optional(),
  slot: SlotIdSchema,
});

/** Input for `set.end` — operates on the active set in the slot's `live.set`. */
export const SetEndInput = z.object({
  slot: SlotIdSchema,
});

/**
 * Input for `set.live_metrics` — returns rolling metrics for the active set
 * (rep count, last rep velocity, etc.). Operates on the slot's `live.set`.
 */
export const SetLiveMetricsInput = z.object({
  slot: SlotIdSchema,
});

/**
 * Input for `set.get` — fetches a completed set from the store, including
 * every persisted rep with full per-phase telemetry. Returns `SET_NOT_FOUND`
 * when the id has no row in the store. NOTE: read-only over the store, not
 * slot-bound — sets are looked up by `setId`.
 */
export const SetGetInput = z.object({
  setId: z.string().min(1),
});
