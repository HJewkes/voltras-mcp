// Input schemas for `set.*` tools.
//
// All set operations target the currently active set (or the live device for
// `set.start`). None of these tools accept explicit set metadata — set
// metadata (training mode, weight, chains, eccentric) is auto-populated from
// `state.live.snapshotDevice()` at handler time. Adding fields here would
// duplicate live device state and create drift between the snapshot and the
// stored set.

import { z } from 'zod';

/**
 * Input for `set.start`. Empty by design: the handler reads the live device
 * snapshot to populate set metadata. Do not add fields here without first
 * removing the corresponding live-device source.
 */
export const SetStartInput = z.object({});

/** Input for `set.end` — operates on the active set in `state.live.set`. */
export const SetEndInput = z.object({});

/**
 * Input for `set.live_metrics` — returns rolling metrics for the active set
 * (rep count, last rep velocity, etc.). Operates on `state.live.set`.
 */
export const SetLiveMetricsInput = z.object({});

/**
 * Input for `set.get` — fetches a completed set from the store, including
 * every persisted rep with full per-phase telemetry. Returns `SET_NOT_FOUND`
 * when the id has no row in the store.
 */
export const SetGetInput = z.object({
  setId: z.string().min(1),
});
