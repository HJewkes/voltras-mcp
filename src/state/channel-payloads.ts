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

import type { PreSummaryEvent } from '@voltras/node-sdk';
import type { Rep } from '@voltras/workout-analytics';
import {
  getPhaseMeanVelocity,
  getPhaseRangeOfMotion,
  getRepPeakLoad,
} from '@voltras/workout-analytics';

import type { ActiveSet, DeviceSnapshot } from './live-state.js';
import type { StoredSet } from '../store/types.js';
import type { TriggerSpec } from '../schemas/set.js';

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
 * Cause of a `set_ended*` channel emission. `'tool'` is the explicit
 * `set.end` MCP-tool path; `'device_signal'` is the bridge's autonomous
 * finalize when the user pressed Stop on the unit (an out-of-grace
 * `onInProgress` event). The cause selects the meta `event_type` and tunes
 * the summary text — payload shape is identical between the two so PT
 * Claude can parse either with one schema.
 */
export type SetEndedCause = 'tool' | 'device_signal';

/**
 * Device-asserted end-of-set summary metadata, harvested from the SDK's
 * `onSummary` vendor frame via `LiveState.consumeLatestSummary`. Threaded
 * onto the `set_ended*` payload so PT Claude can cross-reference the
 * device's canonical rep count + schema version against the analytics-set
 * count without an extra retrieval. Optional — sets that ended without
 * ever receiving an `onSummary` (mid-set disconnect, abrupt close) omit
 * the block entirely.
 */
export interface DeviceSummaryBlock {
  repCount: number;
  schemaVersion: number;
}

/**
 * Build the meta + content for a `set_ended` (or `set_ended_by_device`)
 * channel event. Carries the full per-rep array plus a pre-computed VBT
 * summary so the model can skip the `set.get` + `metrics.compute vbt.set`
 * follow-up calls that almost every set close currently triggers.
 *
 * The `cause` argument selects between the two emission types:
 *   * `'tool'` → `event_type='set_ended'`. Default.
 *   * `'device_signal'` → `event_type='set_ended_by_device'`. Summary text
 *     also adds the "(user pressed Stop on the unit)" tail so the model can
 *     distinguish the autonomous device finish from an explicit end. Caller
 *     is expected to have set `stored.partial=true` and
 *     `stored.partialReason='device_signal'` before invoking — those flow
 *     unchanged into the payload.
 *
 * The optional `deviceSummary` carries the device-asserted rep count +
 * schema version harvested from the SDK's `onSummary` frame at finalize
 * time. When supplied, meta gains `device_rep_count` + `device_schema_version`
 * and content gains a `device_summary` block. When absent (mid-set
 * disconnect, no graceful close, no summary frame received) the payload
 * omits both — backwards-compatible with pre-PR-C consumers.
 */
export function buildSetEndedPayload(
  stored: StoredSet,
  cause: SetEndedCause = 'tool',
  autoStopCause?: string,
  deviceSummary?: DeviceSummaryBlock,
): {
  meta: Record<string, string>;
  content: string;
} {
  const startedMs = Date.parse(stored.startedAt);
  const endedMs = Date.parse(stored.endedAt);
  const durationMs =
    Number.isFinite(startedMs) && Number.isFinite(endedMs) ? endedMs - startedMs : 0;
  const safeDurationMs = Math.max(0, durationMs);
  const eventType = cause === 'device_signal' ? 'set_ended_by_device' : 'set_ended';

  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: eventType,
    set_id: stored.id,
    session_id: stored.sessionId,
    rep_count: String(stored.reps.length),
    duration_ms: String(safeDurationMs),
  };
  if (stored.partial && stored.partialReason !== undefined) {
    meta.partial_reason = stored.partialReason;
  }
  if (autoStopCause !== undefined) {
    // Distinguishes auto-stop sub-causes (`rep_count_reached`,
    // `velocity_loss_exceeded`, `idle_timeout_ms`) within set_ended without
    // forcing the model to re-parse the partial_reason enum. Carried in
    // both meta (for fast scanning) and content (under `set.auto_stop_cause`).
    meta.auto_stop_cause = autoStopCause;
  }
  if (deviceSummary !== undefined) {
    // Device-asserted canonical counts harvested from the SDK's `onSummary`
    // vendor frame. Carried alongside the analytics-derived `rep_count` so
    // the model can spot a mismatch (e.g., device-side counter desync) at
    // a glance without parsing content.
    meta.device_rep_count = String(deviceSummary.repCount);
    meta.device_schema_version = String(deviceSummary.schemaVersion);
  }

  const reps = stored.reps.map(serializeRepForPayload);
  const vbt = computeVbtSummary(stored.reps);
  const summary = buildSetEndedSummary(
    stored.reps.length,
    safeDurationMs,
    vbt.velocity_loss_pct,
    cause,
  );

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
      ...(autoStopCause !== undefined ? { auto_stop_cause: autoStopCause } : {}),
    },
    reps,
    vbt_summary: vbt,
    ...(deviceSummary !== undefined
      ? {
          device_summary: {
            rep_count: deviceSummary.repCount,
            schema_version: deviceSummary.schemaVersion,
          },
        }
      : {}),
  });
  return { meta, content };
}

/**
 * Map a single Rep into the channel-payload shape — peak/mean per phase
 * plus single ROM scalar. Shared between `buildSetEndedPayload` and the
 * trigger payloads' `set_so_far` block so the model parses the same
 * structure on every set-level event.
 */
function serializeRepForPayload(rep: Rep): {
  rep_number: number;
  concentric: { peak_velocity: number; mean_velocity: number };
  eccentric: { peak_velocity: number; mean_velocity: number };
  rom_m: number | null;
} {
  return {
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
  };
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
  cause: SetEndedCause,
): string {
  const seconds = Math.round(durationMs / 1000);
  const headline = cause === 'device_signal' ? 'Set ended by device' : 'Set ended';
  const base = `${headline}: ${repCount} reps in ${seconds}s`;
  const withLoss = lossPct === null ? base : `${base}, ${lossPct}% velocity loss`;
  return cause === 'device_signal' ? `${withLoss} (user pressed Stop on the unit)` : withLoss;
}

/**
 * Build the meta + content for a `set_pre_summary` channel event. Fires
 * when the device's vendor `preSummary` frame lands (~3s before the final
 * rep) — gives PT Claude an early-warning hook for the rest period
 * coaching prompt without waiting for the set to fully close.
 *
 * The `set_so_far` block mirrors the trigger-event shape so the model
 * parses mid-set context with the same schema across `set_target_reached`,
 * `velocity_loss_exceeded`, `idle_timeout`, and now `set_pre_summary`.
 *
 * `payload.targetWeightTenths` is carried through as-is (raw tenths) for
 * completeness — the model can divide by 10 when it wants pounds.
 */
export function buildSetPreSummaryPayload(
  set: ActiveSet,
  device: DeviceSnapshot,
  payload: PreSummaryEvent,
): { meta: Record<string, string>; content: string } {
  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'set_pre_summary',
    set_id: set.setId,
    session_id: set.sessionId,
    device_rep_count: String(payload.repCount),
    final_rep_duration_ms: String(payload.repDurationMs),
    schema_version: String(payload.schemaVersion),
  };
  const summary = `Final rep complete: ${payload.repCount} reps, last rep ${payload.repDurationMs}ms`;
  const content = JSON.stringify({
    summary,
    pre_summary: {
      rep_count: payload.repCount,
      final_rep_duration_ms: payload.repDurationMs,
      schema_version: payload.schemaVersion,
      target_weight_tenths: payload.targetWeightTenths,
    },
    set_so_far: summarizeSetForTrigger(set, device),
  });
  return { meta, content };
}

/**
 * Compact mid-set summary used in the trigger DSL channel events
 * (`set_target_reached`, `velocity_loss_exceeded`, `idle_timeout`). Same
 * structural shape as the `set_ended` payload's `{set, reps, vbt_summary}`,
 * minus the persistence-only fields (no ended_at). Built directly from the
 * still-active `ActiveSet` plus the device snapshot — the set has not been
 * persisted yet at trigger-fire time.
 */
export interface SetSoFar {
  set: {
    set_id: string;
    session_id: string;
    weight_lbs: number | null;
    training_mode: string | null;
    started_at: string;
  };
  reps: ReturnType<typeof serializeRepForPayload>[];
  vbt_summary: ReturnType<typeof computeVbtSummary>;
}

/**
 * Snapshot the active set into the `set_so_far` block embedded on every
 * trigger-fire channel event. DRY'd up with `buildSetEndedPayload` via the
 * shared `serializeRepForPayload` + `computeVbtSummary` helpers so PT Claude
 * can parse mid-set and end-of-set rep arrays with the same schema.
 *
 * NOTE: `partial_reason` is intentionally absent — the set is in-progress
 * when a trigger fires (even one that auto-stops, since the trigger event
 * publishes BEFORE `finalizeSet` so the model sees the trigger first).
 */
export function summarizeSetForTrigger(set: ActiveSet, device: DeviceSnapshot): SetSoFar {
  return {
    set: {
      set_id: set.setId,
      session_id: set.sessionId,
      weight_lbs: device.weightLbs ?? null,
      training_mode: device.trainingMode ?? null,
      started_at: set.startedAt,
    },
    reps: set.reps.map(serializeRepForPayload),
    vbt_summary: computeVbtSummary(set.reps),
  };
}

/**
 * Build the meta + content for a `set_target_reached` channel event
 * (`rep_count_reached` trigger match). `target` is the configured rep
 * count; `actualReps` is the just-finalized rep number (1-indexed). The
 * `autoStopped` flag is `true` when the trigger came from `stopOn` (the
 * bridge will call `finalizeSet` after publishing this) and `false` when
 * from `notifyOn` (set continues).
 */
export function buildSetTargetReachedPayload(
  set: ActiveSet,
  device: DeviceSnapshot,
  target: number,
  actualReps: number,
  autoStopped: boolean,
): { meta: Record<string, string>; content: string } {
  const setIdShort = set.setId.slice(0, 8);
  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'set_target_reached',
    set_id: set.setId,
    session_id: set.sessionId,
    target_rep_count: String(target),
    actual_rep_count: String(actualReps),
    auto_stopped: autoStopped ? 'true' : 'false',
  };
  const summary = `Target reached: ${actualReps}/${target} reps on set ${setIdShort}${
    autoStopped ? ' — auto-stopping' : ''
  }.`;
  const content = JSON.stringify({
    summary,
    trigger: {
      type: 'rep_count_reached',
      target,
      actual: actualReps,
    },
    set_so_far: summarizeSetForTrigger(set, device),
  });
  return { meta, content };
}

/**
 * Build the meta + content for a `velocity_loss_exceeded` channel event.
 * Baseline = highest peak concentric velocity seen so far in the set;
 * `current` = peak concentric velocity of the just-finalized rep. The
 * `baselineRepNumber` gives PT Claude the rep at which the baseline was
 * established (sidesteps "is this baseline rep 1's setup pause artifact?").
 */
export function buildVelocityLossExceededPayload(
  set: ActiveSet,
  device: DeviceSnapshot,
  threshold: number,
  pct: number,
  baseline: number,
  current: number,
  baselineRepNumber: number,
  actualReps: number,
  autoStopped: boolean,
): { meta: Record<string, string>; content: string } {
  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'velocity_loss_exceeded',
    set_id: set.setId,
    session_id: set.sessionId,
    velocity_loss_pct: pct.toFixed(1),
    threshold_pct: String(threshold),
    baseline_velocity: baseline.toFixed(3),
    current_velocity: current.toFixed(3),
    rep_count_at_threshold: String(actualReps),
    auto_stopped: autoStopped ? 'true' : 'false',
  };
  const summary =
    `Velocity dropped ${pct.toFixed(1)}% (${baseline.toFixed(2)} -> ` +
    `${current.toFixed(2)} m/s) on rep ${actualReps}. Threshold: ${threshold}%${
      autoStopped ? ' — auto-stopping' : ''
    }.`;
  const content = JSON.stringify({
    summary,
    trigger: {
      type: 'velocity_loss_exceeded',
      threshold_pct: threshold,
      actual_pct: Number(pct.toFixed(1)),
      baseline_velocity: baseline,
      current_velocity: current,
      baseline_rep_number: baselineRepNumber,
    },
    set_so_far: summarizeSetForTrigger(set, device),
  });
  return { meta, content };
}

/**
 * Build the meta + content for an `idle_timeout` channel event. `set` is
 * the active set when the watchdog fires; `device` snapshot lets the
 * payload carry weight/mode for context. `set` may have zero reps (the
 * watchdog can fire before any rep finalizes), in which case `set_so_far`
 * is null — the model can't compute a velocity-loss baseline yet, but the
 * coach still needs to know the user has gone idle.
 *
 * `lastRepAt` is the ISO timestamp of the most recent finalized rep, or
 * the set's `startedAt` when no reps have closed (the watchdog uses
 * startedAt as its zero reference).
 */
export function buildIdleTimeoutPayload(
  set: ActiveSet,
  device: DeviceSnapshot,
  thresholdMs: number,
  actualIdleMs: number,
  lastRepAt: string,
  autoStopped: boolean,
): { meta: Record<string, string>; content: string } {
  const setIdShort = set.setId.slice(0, 8);
  const lastRepCount = set.reps.length;
  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'idle_timeout',
    set_id: set.setId,
    session_id: set.sessionId,
    idle_ms: String(Math.round(actualIdleMs)),
    threshold_ms: String(thresholdMs),
    last_rep_count: String(lastRepCount),
    auto_stopped: autoStopped ? 'true' : 'false',
  };
  const summary =
    `No reps for ${(actualIdleMs / 1000).toFixed(0)}s on set ${setIdShort} ` +
    `(threshold ${thresholdMs / 1000}s)${autoStopped ? ' — auto-stopping' : ''}.`;
  const content = JSON.stringify({
    summary,
    trigger: {
      type: 'idle_timeout_ms',
      threshold_ms: thresholdMs,
      actual_idle_ms: Math.round(actualIdleMs),
      last_rep_at: lastRepAt,
      last_rep_count: lastRepCount,
    },
    set_so_far: lastRepCount === 0 ? null : summarizeSetForTrigger(set, device),
  });
  return { meta, content };
}

/**
 * Cause discriminator for trigger-fire channel events, mirroring how the
 * spec is registered (stopOn vs notifyOn). Currently only used for the
 * `auto_stopped` meta flag — the payload shape is identical between the
 * two cases.
 */
export type TriggerFireCause = 'stop' | 'notify';

/**
 * Compute the dedupe key for a trigger spec. Used by the bridge's
 * `tryFireTrigger` ledger so identical specs across `stopOn`/`notifyOn`
 * collapse to one event while distinct thresholds fire independently.
 */
export function triggerDedupeKey(spec: TriggerSpec): string {
  switch (spec.type) {
    case 'rep_count_reached':
      return `${spec.type}:${spec.value}`;
    case 'velocity_loss_exceeded':
      return `${spec.type}:${spec.pct}`;
    case 'idle_timeout_ms':
      return `${spec.type}:${spec.value}`;
  }
}

/**
 * SDK connection-state values, mirrored locally so this module doesn't pull
 * in the SDK type. Matches `@voltras/node-sdk`'s connection-state union.
 */
export type ConnectionState = 'connected' | 'disconnected' | 'connecting' | 'authenticating';

/**
 * Compact summary of the active set at the moment a disconnect lands. Used
 * only on the `connection_changed` event when `state === 'disconnected'`
 * and a set was active. PT Claude reads this to decide whether to surface
 * a "you got disconnected mid-rep" prompt to the user.
 */
export interface ActiveSetAtDisconnect {
  set_id: string;
  rep_count_so_far: number;
  weight_lbs: number | null;
  training_mode: string | null;
}

/**
 * Build the meta + content for a `connection_changed` channel event. Fires
 * on every state transition (connected / disconnected / connecting /
 * authenticating). The `device` snapshot should reflect post-transition
 * state — for the disconnect case that means after `markDisconnected`, so
 * `device.disconnectedAt` is populated. The `activeSet` snapshot, on the
 * other hand, is taken from BEFORE any disconnect cascade so the payload
 * still carries the mid-set context the model can reason over.
 *
 * `device.connected` is forwarded as the boolean `connected` flag in the
 * content body — separate from the four-state `state` so the model can
 * filter on either axis without parsing.
 */
export function buildConnectionChangedPayload(
  state: ConnectionState,
  device: DeviceSnapshot,
  activeSet: ActiveSetAtDisconnect | null,
): { meta: Record<string, string>; content: string } {
  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'connection_changed',
    state,
  };
  if (state === 'disconnected') {
    if (device.disconnectedAt !== undefined) {
      meta.disconnected_at = device.disconnectedAt;
    }
    if (activeSet !== null) {
      meta.mid_set = 'true';
    }
  }
  if (state === 'connected' && !device.isStale) {
    // Tag fresh-data events: any 'connected' connection_changed where the
    // LiveState is non-stale represents either the original connect (no
    // prior disconnect) or the first push after a soft-reset reconnect
    // cleared the staleness flag.
    meta.refreshed = 'true';
  }

  const summary = buildConnectionChangedSummary(state, device, activeSet);
  const content = JSON.stringify({
    summary,
    device: {
      connected: device.connected,
      battery_percent: device.batteryPercent ?? null,
      weight_lbs: device.weightLbs ?? null,
      training_mode: device.trainingMode ?? null,
      damper_level: device.damperLevel ?? null,
      stale_since_disconnect: device.staleSinceDisconnect ?? null,
    },
    active_set_at_disconnect: state === 'disconnected' ? activeSet : null,
  });
  return { meta, content };
}

/**
 * Build the meta + content for a `set_aborted_by_mode_revert` channel event
 * (Bug 22). Fired when the user requested a training mode (e.g., Rowing)
 * via session.start / set.start and the device autonomously reverted to a
 * different mode within the detection window. The bridge raises this
 * BEFORE it would otherwise call `client.startRecording()`, so the motor
 * never engages — the model can explain the safety abort to the user
 * without an unexpected load on the cable.
 *
 * `requested` and `actual` are the canonical TrainingMode names (the same
 * lookup `settingsToSnapshot` uses) so PT Claude's surface text reads
 * naturally without re-mapping enum values.
 */
export function buildSetAbortedByModeRevertPayload(
  requested: string,
  actual: string,
  timestampMs: number,
  sessionId: string | null,
): { meta: Record<string, string>; content: string } {
  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'set_aborted_by_mode_revert',
    requested_mode: requested,
    actual_mode: actual,
    timestamp_ms: String(timestampMs),
  };
  if (sessionId !== null) {
    meta.session_id = sessionId;
  }
  const summary =
    `Set aborted: device reverted from ${requested} to ${actual}. ` +
    `Motor not engaged. Re-select ${requested} on the unit and retry.`;
  const content = JSON.stringify({
    summary,
    abort: {
      reason: 'mode_revert',
      requested_mode: requested,
      actual_mode: actual,
      timestamp_ms: timestampMs,
    },
    session_id: sessionId,
  });
  return { meta, content };
}

/**
 * Build the meta + content for a synthetic `settings_update` channel event.
 * Fires when the bridge observes a transition in a monitored device-setting
 * field (`damperLevel` from the cmd=0x10 cascade; assist mode + chains
 * activity from the cmd=0x07 state-dump).
 *
 * The content body carries a `__all` block snapshotting every known field
 * at emission time so consumers don't have to merge against a prior
 * settings_update — the same shape A4's runbook expected when filing
 * Bug 27.
 */
export interface SettingsUpdateAll {
  weightLbs?: number;
  trainingMode?: string;
  batteryPercent?: number;
  damperLevel?: number;
  assistMode?: number;
  /**
   * Active training-mode raw byte from the last cmd=0x07 state-dump
   * (1 = WeightTraining, 2 = ResistanceBand). The bridge drops transitional
   * frames where the byte is 0, so this field never appears as 0 in a
   * published payload.
   */
  trainingModeRaw?: number;
  /**
   * Effective chain target force at the cable in tenths of pounds, decoded
   * from bytes [8-9] of the cmd=0x07 inner `aa 80 25` envelope. Equals
   * `min(chains, weight) × 10` (the device caps chains at weight). For the
   * user's chains setting in lbs prefer `chainSettingLbs`.
   */
  chainTargetForceTenths?: number;
  /** Active weight in tenths of pounds from cmd=0x07 (mirrors `baseWeight × 10`). */
  weightLbsTenths?: number;
  /** Eccentric overload in tenths of percent from cmd=0x07. */
  eccentricPercentTenths?: number;
  /**
   * User's chains setting in pounds (= what `set_chains` wrote, after the
   * firmware's silent chains≤weight cap), sourced from the cmd=0x10
   * cascade `chains` field. On-device testing 2026-05-07 confirmed this
   * is reliable.
   */
  chainSettingLbs?: number;
}

export type SettingsUpdateField =
  | 'damperLevel'
  | 'assistMode'
  | 'trainingModeRaw'
  | 'chainTargetForceTenths'
  | 'weightLbsTenths'
  | 'eccentricPercentTenths';

export function buildSettingsUpdatePayload(
  changedField: SettingsUpdateField,
  changedValue: number,
  all: SettingsUpdateAll,
): { meta: Record<string, string>; content: string } {
  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'settings_update',
    changed_field: changedField,
    changed_value: String(changedValue),
  };
  if (all.damperLevel !== undefined) {
    meta.damper_level = String(all.damperLevel);
  }
  if (all.assistMode !== undefined) {
    meta.assist_mode = String(all.assistMode);
  }
  if (all.trainingModeRaw !== undefined) {
    meta.training_mode_raw = String(all.trainingModeRaw);
  }
  const summary = `${changedField} changed to ${changedValue}.`;
  const content = JSON.stringify({
    summary,
    changed: { field: changedField, value: changedValue },
    __all: {
      weight_lbs: all.weightLbs ?? null,
      training_mode: all.trainingMode ?? null,
      battery_percent: all.batteryPercent ?? null,
      damper_level: all.damperLevel ?? null,
      assist_mode: all.assistMode ?? null,
      training_mode_raw: all.trainingModeRaw ?? null,
      chain_target_force_tenths: all.chainTargetForceTenths ?? null,
      weight_lbs_tenths: all.weightLbsTenths ?? null,
      eccentric_percent_tenths: all.eccentricPercentTenths ?? null,
      chain_setting_lbs: all.chainSettingLbs ?? null,
    },
  });
  return { meta, content };
}

function buildConnectionChangedSummary(
  state: ConnectionState,
  _device: DeviceSnapshot,
  activeSet: ActiveSetAtDisconnect | null,
): string {
  if (state === 'connected') {
    return 'Voltra connected.';
  }
  if (state === 'disconnected') {
    if (activeSet === null) {
      return 'Voltra disconnected.';
    }
    const setIdShort = activeSet.set_id.slice(0, 8);
    const weight = activeSet.weight_lbs ?? 0;
    return `Voltra disconnected mid-set (rep ${activeSet.rep_count_so_far} of set ${setIdShort}, ${weight} lbs).`;
  }
  return `Voltra ${state}.`;
}

/**
 * Build the meta + content for a `wake_word_detected` channel event. Fired
 * by the voice listener as soon as the openWakeWord sidecar emits a `wake`
 * event — gives PT Claude a chance to render an "I'm listening…" cue while
 * whisper.cpp transcription is still in flight (typically 0.3-1.5 s on
 * Apple Silicon for `base.en`).
 *
 * `confidence` is the openWakeWord softmax score in [0, 1]; the listener
 * applies its own threshold before publishing, so values arriving here are
 * already above the configured floor.
 */
export function buildWakeWordDetectedPayload(
  wakeWord: string,
  confidence: number,
  capturedAtMs: number,
): { meta: Record<string, string>; content: string } {
  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'wake_word_detected',
    wake_word: wakeWord,
    confidence: confidence.toFixed(3),
  };
  const summary = `Heard "${wakeWord}" (${confidence.toFixed(2)}) — listening for the next utterance.`;
  const content = JSON.stringify({
    summary,
    wake_word: wakeWord,
    confidence,
    capture_started_at: capturedAtMs,
  });
  return { meta, content };
}

/**
 * Build the meta + content for a `voice_input` channel event. Fired by the
 * voice listener after whisper.cpp returns a transcript for the post-wake
 * audio buffer. This is the primary signal PT Claude reads — the model
 * should treat the `transcript` body as a user utterance and decide whether
 * to act (mode change, weight change, set start) or simply respond verbally.
 *
 * `latencyMs` is wake-word-fire → transcript-resolved end-to-end. The
 * listener targets <2 s on Apple Silicon for `base.en`.
 */
export function buildVoiceInputPayload(
  transcript: string,
  latencyMs: number,
  sttModel: string,
  audioDurationMs: number,
): { meta: Record<string, string>; content: string } {
  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'voice_input',
    latency_ms: String(latencyMs),
    stt_model: sttModel,
    audio_duration_ms: String(audioDurationMs),
  };
  const summary = `User said: "${transcript}"`;
  const content = JSON.stringify({
    summary,
    transcript,
    latency_ms: latencyMs,
    stt_model: sttModel,
    audio_duration_ms: audioDurationMs,
  });
  return { meta, content };
}
