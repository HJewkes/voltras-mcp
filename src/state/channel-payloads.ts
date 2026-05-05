// Builders for the JSON payloads we ship in `claude/channel` event content
// bodies. Centralized here (rather than inline in event-bridge.ts and
// set-tools.ts) so the contract with PT Claude lives in exactly one place
// and is unit-testable without mounting the full bridge or tool wiring.
//
// Why content is JSON.stringify'd: claude/channel delivers events to the
// model as `<channel attr1="...">{content body}</channel>` XML — meta keys
// become attributes (used for fast scanning/filtering), content carries the
// structured detail. We standardize on a JSON-encoded content with a
// leading `summary` field so the model can:
//   1. Read the summary line at-a-glance without parsing,
//   2. Drill into structured `rep` / `set` / `vbt_summary` fields when it
//      needs precise telemetry, and
//   3. Skip a follow-up retrieval call (`set.get` / `metrics.compute`) for
//      the common cases of per-rep nudges and end-of-set scoring.
//
// Meta keys are constrained to `[A-Za-z0-9_]+` per Claude Code docs (hyphens
// are silently dropped on serialization). Values must all be strings —
// helpers `toFixed(N)` or `String(...)` numbers before assignment.

import type { Rep } from '@voltras/workout-analytics';
import {
  getPhaseMeanVelocity,
  getPhaseRangeOfMotion,
  getRepPeakLoad,
} from '@voltras/workout-analytics';

import type { ActiveSet, DeviceSnapshot } from './live-state.js';
import type { StoredSet } from '../store/types.js';

/**
 * Phase movement duration in milliseconds. Workout-analytics's
 * `getPhaseMovementDuration` returns seconds; we want milliseconds in the
 * channel payload so the model doesn't have to divide.
 */
function phaseMovementDurationMs(phase: Rep['concentric']): number {
  // Total span minus hold time, expressed in ms. We compute directly off
  // the same internals `getPhaseDuration` / `getPhaseHoldDuration` use to
  // avoid the seconds-roundtrip.
  if (phase.samples.length === 0) {
    return 0;
  }
  const totalMs = phase.endTime - phase.startTime;
  return Math.max(0, Math.round(totalMs - phase._totalHoldDuration));
}

/**
 * Return ROM in meters when the phase has samples, otherwise null. ROM is
 * the absolute position delta across the phase; we expose it on the rep
 * payload as a single value (concentric ROM is the canonical "lift
 * distance") so the model gets a single ROM number per rep.
 */
function repRangeOfMotion(rep: Rep): number | null {
  if (rep.concentric.samples.length === 0) {
    return null;
  }
  return getPhaseRangeOfMotion(rep.concentric);
}

/**
 * Build the meta + content for a `rep_finalized` channel event. Caller
 * supplies the finalized rep, the still-active set, the device snapshot,
 * and the count of reps already in `set.reps` (which includes the new
 * in-progress rep — the spec's `rep_count_so_far` excludes it).
 *
 * Numbers in `rep` are kept as JS `number` (not pre-rounded strings) so
 * the model can do math directly; meta values that the coach filters on
 * (`peak_concentric_velocity`, `weight_lbs`) are `toFixed`'d / `String()`'d
 * because XML attributes must be strings.
 */
export function buildRepFinalizedPayload(
  finalizedRep: Rep,
  finalizedIndex: number,
  set: ActiveSet,
  device: DeviceSnapshot,
  repsLengthIncludingInProgress: number,
): { meta: Record<string, string>; content: string } {
  const repNumber = finalizedIndex + 1;
  const concPeak = finalizedRep.concentric.peakVelocity;
  const eccPeak = finalizedRep.eccentric.peakVelocity;
  const concMean = getPhaseMeanVelocity(finalizedRep.concentric);
  const eccMean = getPhaseMeanVelocity(finalizedRep.eccentric);

  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'rep_finalized',
    set_id: set.setId,
    rep_count: String(repNumber),
  };
  if (concPeak > 0) {
    meta.peak_concentric_velocity = concPeak.toFixed(3);
  }
  if (eccPeak > 0) {
    meta.peak_eccentric_velocity = eccPeak.toFixed(3);
  }
  if (device.weightLbs !== undefined && device.weightLbs > 0) {
    meta.weight_lbs = String(device.weightLbs);
  }

  const summary = buildRepSummary(repNumber, concPeak, device.weightLbs);
  const content = JSON.stringify({
    summary,
    rep: {
      rep_number: repNumber,
      concentric: {
        peak_velocity: concPeak,
        mean_velocity: Number(concMean.toFixed(3)),
        duration_ms: phaseMovementDurationMs(finalizedRep.concentric),
      },
      eccentric: {
        peak_velocity: eccPeak,
        mean_velocity: Number(eccMean.toFixed(3)),
        duration_ms: phaseMovementDurationMs(finalizedRep.eccentric),
      },
      peak_force: getRepPeakLoad(finalizedRep),
      rom_m: repRangeOfMotion(finalizedRep),
    },
    set_context: {
      weight_lbs: device.weightLbs ?? null,
      training_mode: device.trainingMode ?? null,
      // The caller passes the current `set.reps.length`; the in-progress
      // new rep sits at the end of that array, so subtract one.
      rep_count_so_far: Math.max(0, repsLengthIncludingInProgress - 1),
    },
  });
  return { meta, content };
}

function buildRepSummary(repNumber: number, concPeak: number, weightLbs?: number): string {
  const peak = concPeak.toFixed(2);
  if (weightLbs !== undefined && weightLbs > 0) {
    return `Rep ${repNumber}: ${peak} m/s peak conc, ${weightLbs} lbs`;
  }
  return `Rep ${repNumber}: ${peak} m/s peak conc`;
}

/**
 * Compact summary of a previously-completed set for fatigue context on the
 * `set_started` event. Used when the new set begins and the prior set in
 * the same session has been persisted.
 */
export interface PreviousSetSummary {
  set_id: string;
  rep_count: number;
  weight_lbs: number;
  /**
   * Mean concentric peak velocity across the prior set's reps, in m/s.
   * Null when none of the reps have any concentric samples (e.g., the
   * prior set was a partial-disconnect with no completed reps).
   */
  mean_concentric_velocity: number | null;
}

/**
 * Aggregate per-rep concentric peak velocities and return the simple mean.
 * Returns null when no reps have any concentric movement (would otherwise
 * be 0 — and we want the model to distinguish "we don't know" from "it was
 * a zero set").
 */
export function meanConcentricPeakVelocity(reps: readonly Rep[]): number | null {
  let total = 0;
  let count = 0;
  for (const rep of reps) {
    if (rep.concentric._movementSampleCount > 0) {
      total += rep.concentric.peakVelocity;
      count += 1;
    }
  }
  if (count === 0) {
    return null;
  }
  return Number((total / count).toFixed(3));
}

/** Build the previous-set summary from the most recent `StoredSet` in a session. */
export function summarizePreviousSet(prev: StoredSet): PreviousSetSummary {
  return {
    set_id: prev.id,
    rep_count: prev.reps.length,
    weight_lbs: prev.weightLbs,
    mean_concentric_velocity: meanConcentricPeakVelocity(prev.reps),
  };
}

/**
 * Build the meta + content for a `set_started` channel event. `ordinal` is
 * 1-indexed (this is set N of the session). `previous` is the most recent
 * persisted set in the session, or null when this is the session's first
 * set.
 */
export function buildSetStartedPayload(
  set: ActiveSet,
  device: DeviceSnapshot,
  ordinal: number,
  previous: PreviousSetSummary | null,
): { meta: Record<string, string>; content: string } {
  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'set_started',
    set_id: set.setId,
    session_id: set.sessionId,
  };
  if (device.weightLbs !== undefined && device.weightLbs > 0) {
    meta.weight_lbs = String(device.weightLbs);
  }
  if (device.trainingMode !== undefined) {
    meta.training_mode = device.trainingMode;
  }

  const summary = buildSetStartedSummary(device, ordinal);
  const content = JSON.stringify({
    summary,
    set: {
      set_id: set.setId,
      session_id: set.sessionId,
      weight_lbs: device.weightLbs ?? null,
      training_mode: device.trainingMode ?? null,
      started_at: set.startedAt,
    },
    previous_set_summary: previous,
  });
  return { meta, content };
}

function buildSetStartedSummary(device: DeviceSnapshot, ordinal: number): string {
  const parts: string[] = ['Set started:'];
  if (device.weightLbs !== undefined && device.weightLbs > 0) {
    parts.push(`${device.weightLbs} lbs`);
  }
  if (device.trainingMode !== undefined) {
    parts.push(device.trainingMode);
  }
  parts.push(`(set ${ordinal} of session)`);
  return parts.join(' ');
}

/**
 * Build the meta + content for a `set_ended` channel event. Carries the
 * full per-rep array plus a pre-computed VBT summary so the model can skip
 * the `set.get` + `metrics.compute vbt.set` follow-up calls that almost
 * every set.end currently triggers.
 */
export function buildSetEndedPayload(stored: StoredSet): {
  meta: Record<string, string>;
  content: string;
} {
  const startedMs = Date.parse(stored.startedAt);
  const endedMs = Date.parse(stored.endedAt);
  const durationMs =
    Number.isFinite(startedMs) && Number.isFinite(endedMs) ? endedMs - startedMs : 0;
  const safeDurationMs = Math.max(0, durationMs);

  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'set_ended',
    set_id: stored.id,
    rep_count: String(stored.reps.length),
    duration_ms: String(safeDurationMs),
  };
  if (stored.partial && stored.partialReason !== undefined) {
    meta.partial_reason = stored.partialReason;
  }

  const reps = stored.reps.map((rep) => ({
    rep_number: rep.repNumber,
    concentric: {
      peak_velocity: rep.concentric.peakVelocity,
      mean_velocity: Number(getPhaseMeanVelocity(rep.concentric).toFixed(3)),
    },
    eccentric: {
      peak_velocity: rep.eccentric.peakVelocity,
      mean_velocity: Number(getPhaseMeanVelocity(rep.eccentric).toFixed(3)),
    },
    rom_m: repRangeOfMotion(rep),
  }));

  const vbt = computeVbtSummary(stored.reps);
  const summary = buildSetEndedSummary(stored.reps.length, safeDurationMs, vbt.velocity_loss_pct);

  const content = JSON.stringify({
    summary,
    set: {
      set_id: stored.id,
      session_id: stored.sessionId,
      weight_lbs: stored.weightLbs,
      training_mode: stored.trainingMode,
      started_at: stored.startedAt,
      ended_at: stored.endedAt,
      partial_reason: stored.partialReason ?? null,
    },
    reps,
    vbt_summary: vbt,
  });
  return { meta, content };
}

interface VbtSummary {
  first_rep_v: number | null;
  last_rep_v: number | null;
  velocity_loss_pct: number | null;
  mean_velocity: number | null;
}

function computeVbtSummary(reps: readonly Rep[]): VbtSummary {
  if (reps.length === 0) {
    return { first_rep_v: null, last_rep_v: null, velocity_loss_pct: null, mean_velocity: null };
  }
  const first = reps[0].concentric.peakVelocity;
  const last = reps[reps.length - 1].concentric.peakVelocity;
  const mean = meanConcentricPeakVelocity(reps);
  const lossPct =
    reps.length < 2 || first <= 0 ? null : Number((100 * ((first - last) / first)).toFixed(1));
  return {
    first_rep_v: first,
    last_rep_v: last,
    velocity_loss_pct: lossPct,
    mean_velocity: mean,
  };
}

function buildSetEndedSummary(
  repCount: number,
  durationMs: number,
  lossPct: number | null,
): string {
  const seconds = Math.round(durationMs / 1000);
  const base = `Set ended: ${repCount} reps in ${seconds}s`;
  if (lossPct === null) {
    return base;
  }
  return `${base}, ${lossPct}% velocity loss`;
}
