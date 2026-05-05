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
 * Three trigger types:
 *   * `rep_count_reached` — fires when the Nth rep is finalized (intrinsic
 *     ECC->CONC delay applies; rep N is "done" only once rep N+1 begins).
 *   * `velocity_loss_exceeded` — fires when the just-finalized rep's peak
 *     concentric velocity drops `pct`% below the highest peak seen so far in
 *     the set. Range 1..95 — below 1% is sample noise; above 95% almost
 *     always means the lifter has stopped exercising rather than slowed.
 *   * `idle_timeout_ms` — watchdog timer that fires when no rep has
 *     finalized for `value` ms. Range 1s..10min.
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
  z.object({
    type: z.literal('idle_timeout_ms'),
    value: z.number().int().min(1000).max(600_000),
  }),
]);
export type TriggerSpec = z.infer<typeof TriggerSpec>;

/**
 * Watch config attached to a set at start time. `stopOn` triggers auto-end
 * the set via `finalizeSet(partialReason='auto_stopped')` when matched;
 * `notifyOn` triggers fire the channel event without ending the set, leaving
 * the model to decide what to do next.
 *
 * Triggers in either array dedupe by `(type, value-or-pct)` — registering
 * `rep_count_reached:8` twice fires once. The bridge tracks fired triggers
 * on the active set itself.
 */
export const WatchConfig = z.object({
  stopOn: z.array(TriggerSpec).default([]),
  notifyOn: z.array(TriggerSpec).default([]),
});
export type WatchConfig = z.infer<typeof WatchConfig>;

/**
 * Input for `set.start`. Optional `watch` config registers server-evaluated
 * triggers (rep count, velocity loss, idle timeout) for the new set; without
 * it, the set has no auto-stop or notify semantics. Set metadata itself
 * (training mode, weight, chains, eccentric) still derives from the live
 * device snapshot at handler time.
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
