// Per-set capture provenance: the values observable at set close that used to
// be dropped on the floor.
//
// Everything here answers one question — "under what conditions was this set
// recorded?" — and every one of these values is UNRECOVERABLE once the close
// has happened. A settings context that was not captured cannot be
// reconstructed from the reps; a sample rate that was not measured cannot be
// inferred once the corpus mixes two of them. That asymmetry is why these are
// computed at the choke point and stored, rather than derived on read.
//
// Deliberately NOT here: anything we CONCLUDE. Velocity loss, fatigue, RIR and
// the rest are computed on read, because a stored value derived from a formula
// that later changes becomes a silent lie.

import { createHash } from 'node:crypto';
import type { Rep } from '@voltras/workout-analytics';
import type { DeviceSnapshot } from './live-state.js';
import type { StoredSet } from '../store/types.js';

/**
 * Version prefix on `settings_hash`.
 *
 * LOAD-BEARING, not decoration. The hash exists so like-vs-like comparison can
 * ask "same configuration?" — and if a tenth settings dimension is added later,
 * hashes computed before the change would compare equal to hashes computed
 * after it despite covering different fields. The prefix makes that mismatch
 * visible instead of silent. Bump it whenever the hashed field set changes.
 *
 * v1 → v2: `inverseChainsLbs` joined the hashed set. Every v1 hash was
 * computed at a time when inverse chains were not read at all, so a v1 hash
 * cannot distinguish "no inverse chains" from "inverse chains, unobserved" —
 * and without the bump those v1 hashes would compare equal to v2 hashes that
 * do carry the observation, asserting a shared configuration nobody checked.
 */
const SETTINGS_HASH_VERSION = 'v2';

/**
 * The settings context read off a device snapshot at close.
 *
 * These are OBSERVATIONS of readable device configuration — distinct from
 * `setup_id`, which is inferred physical configuration (bench height, cable
 * attachment). Conflating the two breaks like-vs-like matching, because two
 * sets can share a device configuration while being physically set up
 * differently, and vice versa.
 */
export interface SettingsContext {
  chainsLbs?: number;
  damperLevel?: number;
  eccentricPct?: number;
  /**
   * Inverse-chains setting in lbs. A MAGNITUDE, NOT A FLAG — the device takes
   * `setInverseChains(lbs)` over 0-100 — and mechanically the OPPOSITE of
   * `chainsLbs`: inverse chains shed resistance through the concentric and add
   * it through the eccentric. Two sets that differ only in which of the two is
   * set are not like-for-like, which is exactly what the hash must catch.
   */
  inverseChainsLbs?: number;
  assistMode?: string;
}

/**
 * Read the settings context off a device snapshot.
 *
 * `chainSettingLbs` rather than `chainTargetForceTenths`: the former is the
 * user's setting from the cmd=0x10 cascade echo (post-cap, confirmed reliable
 * on-device), the latter is a state-dump field equal to `min(chains, weight)`,
 * which silently reads as the weight whenever chains exceed it.
 *
 * `inverseChainSettingLbs` comes from the same cascade and is read for the
 * same reason. It is captured SEPARATELY from `chainsLbs` rather than folded
 * into one signed number, because the device carries both settings at once and
 * a single field could not represent that.
 *
 * `eccentricPercentTenths` is tenths of a percent, so it is scaled here — the
 * one place that conversion happens for the persisted row.
 */
export function readSettingsContext(device: DeviceSnapshot): SettingsContext {
  const ctx: SettingsContext = {};
  if (device.chainSettingLbs !== undefined) ctx.chainsLbs = device.chainSettingLbs;
  if (device.inverseChainSettingLbs !== undefined) {
    ctx.inverseChainsLbs = device.inverseChainSettingLbs;
  }
  if (device.damperLevel !== undefined) ctx.damperLevel = device.damperLevel;
  if (device.eccentricPercentTenths !== undefined) {
    ctx.eccentricPct = device.eccentricPercentTenths / 10;
  }
  if (device.assistMode !== undefined) ctx.assistMode = String(device.assistMode);
  return ctx;
}

/**
 * Stable versioned hash over a settings context.
 *
 * Keys are sorted so the hash does not depend on insertion order, and absent
 * fields are omitted rather than serialized as null — an absent damper setting
 * and a damper setting of 0 are different claims, and hashing them alike would
 * merge two genuinely different configurations.
 *
 * Returns undefined for a wholly empty context: an empty hash would assert
 * "these two sets shared a configuration" about two sets whose configuration
 * is simply unknown.
 */
export function hashSettingsContext(ctx: SettingsContext): string | undefined {
  const entries = Object.entries(ctx)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return undefined;
  const canonical = JSON.stringify(entries);
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `${SETTINGS_HASH_VERSION}:${digest}`;
}

/**
 * Measure the telemetry sample rate for a set, in Hz, from the sample
 * timestamps.
 *
 * MEASURED, NOT ASSUMED. There is no configured rate anywhere in the server to
 * read — the ~11 Hz figure everything quotes is emergent from the device
 * stream. Writing a hardcoded constant would record an assumption as though it
 * were an observation, and would keep recording it after the rate changed.
 *
 * Uses the MEDIAN inter-sample interval rather than the mean: a set that spans
 * a disconnect has one enormous gap, and a mean would drag the whole set's
 * apparent rate toward zero on the strength of a single artifact.
 *
 * Returns undefined when there are too few samples to measure — fewer than two
 * intervals is not a rate, and a made-up one would be worse than a gap.
 */
export function measureSampleRateHz(reps: readonly Rep[]): number | undefined {
  const timestamps: number[] = [];
  for (const rep of reps) {
    for (const phase of [rep.eccentric, rep.concentric]) {
      for (const sample of phase.samples) {
        if (Number.isFinite(sample.timestamp)) timestamps.push(sample.timestamp);
      }
    }
  }
  timestamps.sort((a, b) => a - b);
  const intervals: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    const dt = timestamps[i]! - timestamps[i - 1]!;
    if (dt > 0) intervals.push(dt);
  }
  if (intervals.length < 2) return undefined;
  intervals.sort((a, b) => a - b);
  const mid = Math.floor(intervals.length / 2);
  const medianMs =
    intervals.length % 2 === 0 ? (intervals[mid - 1]! + intervals[mid]!) / 2 : intervals[mid]!;
  if (medianMs <= 0) return undefined;
  // One decimal place: the measurement is not precise enough to justify more,
  // and a stable rounded value groups a corpus cleanly.
  return Math.round((1000 / medianMs) * 10) / 10;
}

/**
 * Scale of `WorkoutSample.position` on newly-written sets.
 *
 * `'device_native'`, NOT `'meters'`, and that is the entire point of shipping
 * the marker before the conversion. The bridge still passes position through
 * unconverted, so stamping `'meters'` now would make the marker assert
 * something false about the rows it labels — worse than having no marker,
 * because a wrong marker is trusted.
 *
 * Flip this to `'meters'` in the same change that converts at the bridge, and
 * never before.
 */
export const CURRENT_POSITION_UNITS: NonNullable<StoredSet['positionUnits']> = 'device_native';
