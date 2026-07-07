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
  getPhaseTimeToPeakVelocityMs,
  getPhaseVelocityDropPct,
  getPhaseVelocityEnvelope,
  getRepConcentricImpulse,
  getRepHoldTopMs,
  getRepMeanConcentricPower,
  getRepPeakForce,
  getRepTempoRatio,
} from '@voltras/workout-analytics';

import type { ActiveSet, DeviceSnapshot, IdleRep, PendingDisconnectNotice } from './live-state.js';
import { activeModeName } from './active-mode.js';
import type { StoredSet, StoredRepVbt } from '../store/types.js';
import type { TriggerSpec } from '../schemas/set.js';
import type { PendingCoercionCheck } from './coercion-watch.js';
import type { WeightImpliedResult } from './weight-implied-watch.js';
import type { BilateralDivergence } from './bilateral-reconciler.js';

/**
 * Convert a velocity from workout-analytics's native scale (mm/s, despite
 * the upstream m/s docstring — confirmed on hardware 2026-05-11) into m/s
 * for serialization. Three decimal places preserve mm/s granularity. The
 * conversion happens at the channel-payload boundary, NOT inside WA, so the
 * analytics layer's canonical unit stays untouched.
 */
function mmsToMps(mms: number): number {
  return Number((mms / 1000).toFixed(3));
}

/**
 * Convert a range-of-motion value from workout-analytics's native scale
 * (millimetres) into metres for the `rom_m` payload field. Three decimals
 * preserve millimetre granularity. Same boundary-conversion rule as
 * `mmsToMps`.
 */
function mmToM(mm: number): number {
  return Number((mm / 1000).toFixed(3));
}

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
 * Return ROM in metres when the phase has samples, otherwise null. ROM is
 * the absolute position delta across the phase; we expose it on the rep
 * payload as a single value (concentric ROM is the canonical "lift
 * distance") so the model gets a single ROM number per rep.
 *
 * Workout-analytics returns ROM in millimetres (despite some upstream m/s
 * docstrings claiming metres — verified on hardware 2026-05-11). We convert
 * here so the payload field name (`rom_m`) matches the value.
 */
function repRangeOfMotion(rep: Rep): number | null {
  if (rep.concentric.samples.length === 0) {
    return null;
  }
  return mmToM(getPhaseRangeOfMotion(rep.concentric));
}

/**
 * Concentric impulse for a rep in pound-seconds (lb·s).
 *
 * `getRepConcentricImpulse` integrates `WorkoutSample.force` over time. The
 * bridge passes raw frame force through in tenths-of-lbs (the WorkoutSample
 * contract wants lbs — VMCP-02.46), so the helper's output is inflated 10x;
 * we correct with `/ 10` here at the serialization boundary, mirroring the
 * `mmsToMps` / `mmToM` pattern of fixing units at emit rather than mutating
 * WA's inputs. Null when the concentric phase has no samples (matches
 * `repRangeOfMotion`), so the model distinguishes "no data" from a true 0.
 */
function repConcentricImpulseLbS(rep: Rep): number | null {
  if (rep.concentric.samples.length === 0) {
    return null;
  }
  return Number((getRepConcentricImpulse(rep) / 10).toFixed(3));
}

/**
 * Mean concentric power for a rep in pound-metres per second (lb·m/s).
 *
 * `getRepMeanConcentricPower` is work / concentric-time, where work is
 * `Σ force × |Δposition|`. Force arrives in tenths-of-lbs (÷10) and position
 * in millimetres (÷1000), so the helper output is inflated 10 000x relative
 * to lb·m/s; we correct with `/ 10000`. Same boundary-conversion rationale
 * as `repConcentricImpulseLbS`. Null when the concentric phase has no
 * samples.
 */
function repMeanConcentricPowerLbMps(rep: Rep): number | null {
  if (rep.concentric.samples.length === 0) {
    return null;
  }
  return Number((getRepMeanConcentricPower(rep) / 10000).toFixed(3));
}

/**
 * Round a fractional percentage to one decimal place. Used for
 * velocity-drop, which workout-analytics returns as 0-100 already.
 */
function pctOneDecimal(pct: number): number {
  return Number(pct.toFixed(1));
}

/**
 * Convert the 4-point mm/s envelope from workout-analytics into the same
 * m/s scale as `peak_velocity` / `mean_velocity`. Preserves length and
 * order so consumers can read the entries positionally (25/50/75/100% of
 * the phase movement span).
 */
function envelopeMps(env: readonly number[]): [number, number, number, number] {
  return [
    mmsToMps(env[0] ?? 0),
    mmsToMps(env[1] ?? 0),
    mmsToMps(env[2] ?? 0),
    mmsToMps(env[3] ?? 0),
  ];
}

/**
 * Telemetry-derived per-phase enrichment fields (VMCP-02.29 follow-up).
 * Slotted into `rep.concentric` / `rep.eccentric` alongside the existing
 * peak / mean / duration block.
 *
 * Impulse + mean-power are rep-level (concentric) rather than per-phase, so
 * they live on the rep block (see `repConcentricImpulseLbS` /
 * `repMeanConcentricPowerLbMps`) not here. VMCP-02.46 added them by
 * correcting WA's tenths-of-lbs / mm inflation at the emit boundary instead
 * of rewriting the bridge's `WorkoutSample` passthrough.
 */
interface PhaseEnrichment {
  time_to_peak_velocity_ms: number;
  velocity_drop_pct: number;
  velocity_envelope_mps: [number, number, number, number];
}

function phaseEnrichment(phase: Rep['concentric']): PhaseEnrichment {
  return {
    time_to_peak_velocity_ms: getPhaseTimeToPeakVelocityMs(phase),
    velocity_drop_pct: pctOneDecimal(getPhaseVelocityDropPct(phase)),
    velocity_envelope_mps: envelopeMps(getPhaseVelocityEnvelope(phase)),
  };
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
  // WA delivers velocities in mm/s; we convert to m/s at the serialization
  // boundary so the payload-field labels (`peak_velocity`, `mean_velocity`,
  // m/s by convention) match the values without disturbing WA's internal
  // canonical unit. See `mmsToMps`.
  const concPeak = mmsToMps(finalizedRep.concentric.peakVelocity);
  const eccPeak = mmsToMps(finalizedRep.eccentric.peakVelocity);
  const concMean = mmsToMps(getPhaseMeanVelocity(finalizedRep.concentric));
  const eccMean = mmsToMps(getPhaseMeanVelocity(finalizedRep.eccentric));

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
        mean_velocity: concMean,
        duration_ms: phaseMovementDurationMs(finalizedRep.concentric),
        ...phaseEnrichment(finalizedRep.concentric),
      },
      eccentric: {
        peak_velocity: eccPeak,
        mean_velocity: eccMean,
        duration_ms: phaseMovementDurationMs(finalizedRep.eccentric),
        ...phaseEnrichment(finalizedRep.eccentric),
      },
      peak_force: getRepPeakForce(finalizedRep),
      rom_m: repRangeOfMotion(finalizedRep),
      impulse_lb_s: repConcentricImpulseLbS(finalizedRep),
      mean_power_lb_mps: repMeanConcentricPowerLbMps(finalizedRep),
      tempo_ratio: Number(getRepTempoRatio(finalizedRep).toFixed(2)),
      hold_top_ms: getRepHoldTopMs(finalizedRep),
    },
    set_context: {
      weight_lbs: device.weightLbs ?? null,
      // VMCP-02.09: `requested_mode` (cmd=0x10 intent) vs `active_mode` (cmd=0x07
      // applied) make "asked for X, running Y" self-evident. `training_mode` is
      // kept as a deprecated alias (= requested) for one release.
      requested_mode: device.trainingMode ?? null,
      active_mode: activeModeName(device.trainingModeRaw),
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
 * Aggregate per-rep concentric peak velocities and return the simple mean
 * in m/s (converted from WA's native mm/s at the boundary). Returns null
 * when no reps have any concentric movement (would otherwise be 0 — and we
 * want the model to distinguish "we don't know" from "it was a zero set").
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
  return mmsToMps(total / count);
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
  // VMCP-02.09: surface requested (cmd=0x10) and applied (cmd=0x07) modes
  // distinctly; `training_mode` stays as a deprecated alias (= requested).
  if (device.trainingMode !== undefined) {
    meta.requested_mode = device.trainingMode;
    meta.training_mode = device.trainingMode;
  }
  const activeMode = activeModeName(device.trainingModeRaw);
  if (activeMode !== null) {
    meta.active_mode = activeMode;
  }

  const summary = buildSetStartedSummary(device, ordinal);
  const content = JSON.stringify({
    summary,
    set: {
      set_id: set.setId,
      session_id: set.sessionId,
      weight_lbs: device.weightLbs ?? null,
      requested_mode: device.trainingMode ?? null,
      active_mode: activeMode,
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
 * Cause of a `set_ended` channel emission. `'tool'` covers tool-driven
 * closes (explicit `set.end`, inactivity-watchdog finalize, guided-load
 * reap); `'device_signal'` is the bridge's autonomous finalize triggered
 * by the firmware emitting `aa 85 5f` (set-summary) on user disengage —
 * the device has no Stop button.
 *
 * F14/F15 rewrite: the two emissions previously diverged on `event_type`
 * (`set_ended` vs `set_ended_by_device`). They're now unified to a single
 * `event_type: 'set_ended'` with a `meta.closed_by` discriminator. PT
 * Claude reads one schema, filters on `closed_by` if it cares which path
 * fired. Summary text retains the "ended automatically" tail for
 * device-signal closes so the voice surface still distinguishes them.
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
 *
 * Note: `aa 86 7d` "summary" only fires at workout-end / post-STOP and
 * may not fire at all in WT/RB/Damper. Per-set device close in those
 * modes is captured via `DeviceSetSummaryBlock` below.
 */
export interface DeviceSummaryBlock {
  repCount: number;
  schemaVersion: number;
}

/**
 * Device-asserted per-set summary metadata, harvested from the SDK's
 * `onSetSummary` vendor frame (`aa 85 5f`) via
 * `LiveState.consumeLatestSetSummary`. The canonical per-set close marker
 * in WT/RB/Damper modes — fires after all reps complete with the final
 * rep count. Threaded onto `set_ended_by_device` payloads when present.
 */
export interface DeviceSetSummaryBlock {
  repCount: number;
  repDurationMs: number;
  targetWeightTenths: number;
  schemaVersion: number;
}

/**
 * Build the meta + content for a `set_ended` channel event. Carries the
 * full per-rep array plus a pre-computed VBT summary so the model can skip
 * the `set.get` + `metrics.compute vbt.set` follow-up calls that almost
 * every set close currently triggers.
 *
 * F14/F15 rewrite: the previously-distinct `set_ended_by_device` event
 * type has been folded into a unified `set_ended`. The `meta.closed_by`
 * discriminator carries the close cause:
 *   * `'device'`             — autonomous `aa 85 5f` close (`cause='device_signal'`).
 *   * `'inactivity_timeout'` — bridge watchdog tripped after no activity.
 *   * `'disconnect'`         — connection loss cascade.
 *   * `'session_end'`        — explicit `session.end` cascade.
 *   * `'guided_load_exited'` — `device.exit_guided_load` reap path.
 *   * `'tool'`               — explicit `set.end` MCP-tool path.
 *
 * The optional `deviceSummary` carries the device-asserted rep count +
 * schema version harvested from the SDK's `onSummary` frame at finalize
 * time. When supplied, meta gains `device_rep_count` + `device_schema_version`
 * and content gains a `device_summary` block. When absent (mid-set
 * disconnect, no graceful close, no summary frame received) the payload
 * omits both.
 */
export function buildSetEndedPayload(
  stored: StoredSet,
  cause: SetEndedCause = 'tool',
  deviceSummary?: DeviceSummaryBlock,
  deviceSetSummary?: DeviceSetSummaryBlock,
  firmwareReconciledTotal?: number,
): {
  meta: Record<string, string>;
  content: string;
} {
  const startedMs = Date.parse(stored.startedAt);
  const endedMs = Date.parse(stored.endedAt);
  const durationMs =
    Number.isFinite(startedMs) && Number.isFinite(endedMs) ? endedMs - startedMs : 0;
  const safeDurationMs = Math.max(0, durationMs);
  const closedBy = closedByFor(cause, stored.partialReason);

  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'set_ended',
    set_id: stored.id,
    session_id: stored.sessionId,
    rep_count: String(stored.reps.length),
    duration_ms: String(safeDurationMs),
    closed_by: closedBy,
  };
  if (stored.partial && stored.partialReason !== undefined) {
    meta.partial_reason = stored.partialReason;
  }
  if (deviceSummary !== undefined) {
    // Device-asserted canonical counts harvested from the SDK's `onSummary`
    // vendor frame. Carried alongside the analytics-derived `rep_count` so
    // the model can spot a mismatch (e.g., device-side counter desync) at
    // a glance without parsing content. Prefer the firmware-parity
    // reconstructed total when available (see `firmwareReconciledTotal`).
    meta.device_rep_count = String(firmwareReconciledTotal ?? deviceSummary.repCount);
    meta.device_schema_version = String(deviceSummary.schemaVersion);
  }
  if (deviceSetSummary !== undefined) {
    // Per-set device summary from the device's set-close frame. Distinct
    // from `onSummary` above which is workout-end-only. Surfaced in meta
    // for fast scanning + mismatch detection. Wins over `device_summary`
    // when both happen to be present (rare; would require both frames in
    // the same set's lifetime).
    //
    // Prefer `firmwareReconciledTotal` — the firmware-parity pipeline's
    // reconstructed total — over the raw frame count: when a set auto-ends
    // on its final rep, that rep never fires its own `onPerRep` 'return', so
    // the set-close frame's `repCount` omits it (bench 2026-07-01: frame said
    // 4 for a 5-rep set). The reconstructed total restores it. The raw frame
    // count is still echoed verbatim in `content.device_set_summary.rep_count`.
    meta.device_rep_count = String(firmwareReconciledTotal ?? deviceSetSummary.repCount);
    meta.device_set_rep_duration_ms = String(deviceSetSummary.repDurationMs);
    meta.device_schema_version = String(deviceSetSummary.schemaVersion);
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
      // VMCP-02.09: requested mode captured at set start. StoredSet does not
      // persist the cmd=0x07 applied byte, so active_mode is null on the
      // historical set_ended event (it is live on set_started / rep_finalized /
      // get_state). training_mode retained as a deprecated alias (= requested).
      requested_mode: stored.trainingMode,
      active_mode: null,
      training_mode: stored.trainingMode,
      started_at: stored.startedAt,
      ended_at: stored.endedAt,
      partial_reason: stored.partialReason ?? null,
      closed_by: closedBy,
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
    ...(deviceSetSummary !== undefined
      ? {
          device_set_summary: {
            rep_count: deviceSetSummary.repCount,
            rep_duration_ms: deviceSetSummary.repDurationMs,
            target_weight_tenths: deviceSetSummary.targetWeightTenths,
            schema_version: deviceSetSummary.schemaVersion,
          },
        }
      : {}),
  });
  return { meta, content };
}

/**
 * Possible `closed_by` discriminators on a unified `set_ended` payload.
 */
export type SetClosedBy =
  | 'device'
  | 'tool'
  | 'inactivity_timeout'
  | 'disconnect'
  | 'session_end'
  | 'guided_load_exited';

/**
 * Map a finalize `cause` + `partialReason` to the unified `closed_by`
 * discriminator. Device-signal close maps to `'device'`; otherwise we
 * prefer the partial reason (it's more specific than the generic tool
 * path); otherwise `'tool'` (graceful explicit close).
 */
function closedByFor(cause: SetEndedCause, partialReason: string | undefined): SetClosedBy {
  if (cause === 'device_signal') {
    return 'device';
  }
  if (partialReason === 'inactivity_timeout') return 'inactivity_timeout';
  if (partialReason === 'disconnect') return 'disconnect';
  if (partialReason === 'session_end') return 'session_end';
  if (partialReason === 'guided_load_exited') return 'guided_load_exited';
  return 'tool';
}

/**
 * Map a single Rep into the channel-payload shape — peak/mean per phase
 * plus single ROM scalar. Shared between `buildSetEndedPayload` and the
 * trigger payloads' `set_so_far` block so the model parses the same
 * structure on every set-level event.
 */
export function serializeRepForPayload(rep: Rep): StoredRepVbt {
  return {
    rep_number: rep.repNumber,
    concentric: {
      peak_velocity: mmsToMps(rep.concentric.peakVelocity),
      mean_velocity: mmsToMps(getPhaseMeanVelocity(rep.concentric)),
      ...phaseEnrichment(rep.concentric),
    },
    eccentric: {
      peak_velocity: mmsToMps(rep.eccentric.peakVelocity),
      mean_velocity: mmsToMps(getPhaseMeanVelocity(rep.eccentric)),
      ...phaseEnrichment(rep.eccentric),
    },
    rom_m: repRangeOfMotion(rep),
    impulse_lb_s: repConcentricImpulseLbS(rep),
    mean_power_lb_mps: repMeanConcentricPowerLbMps(rep),
    tempo_ratio: Number(getRepTempoRatio(rep).toFixed(2)),
    hold_top_ms: getRepHoldTopMs(rep),
  };
}

/**
 * Highest peak concentric velocity across a rep array. Returns 0 when the
 * array is empty or no rep has a positive concentric peak. This is the
 * canonical VBT fatigue baseline — measuring loss from the athlete's best
 * rep, not the first rep (rep 1 is routinely a cable-engagement artifact
 * with a tiny ROM and a meaninglessly low velocity; VMCP-02.24).
 */
export function peakConcentricBaseline(reps: readonly Rep[]): number {
  let max = 0;
  for (const rep of reps) {
    if (rep.concentric.peakVelocity > max) {
      max = rep.concentric.peakVelocity;
    }
  }
  return max;
}

/**
 * Rep number (1-indexed) at which the velocity baseline was set — the rep
 * with the highest peak concentric velocity. Ties prefer the earlier rep so
 * the model can reason "baseline came from rep 1, current from rep 8"
 * without ambiguity.
 */
export function baselineRepNumberFor(reps: readonly Rep[]): number {
  let best = 0;
  let idx = 0;
  for (let i = 0; i < reps.length; i++) {
    if (reps[i].concentric.peakVelocity > best) {
      best = reps[i].concentric.peakVelocity;
      idx = i;
    }
  }
  // repNumber is canonical when present; fall back to 1-indexed array
  // position for analytics' immutable rep shape.
  return reps[idx]?.repNumber ?? idx + 1;
}

interface VbtSummary {
  first_rep_v: number | null;
  /** Baseline velocity: the highest peak concentric velocity across the set. */
  peak_rep_v: number | null;
  /** 1-indexed rep number where the peak baseline was set. */
  peak_rep_number: number | null;
  last_rep_v: number | null;
  /**
   * `(peak - last) / peak × 100`. Canonical VBT velocity loss: how far the
   * final rep slowed from the set's fastest rep. Always ≥ 0 (the last rep
   * can be at most the peak). Matches the `velocity_loss_exceeded` trigger
   * event's convention — both measure loss from the peak baseline, not from
   * a contaminated rep-1 baseline (VMCP-02.12, .24).
   */
  velocity_loss_pct: number | null;
  mean_velocity: number | null;
}

function computeVbtSummary(reps: readonly Rep[]): VbtSummary {
  if (reps.length === 0) {
    return {
      first_rep_v: null,
      peak_rep_v: null,
      peak_rep_number: null,
      last_rep_v: null,
      velocity_loss_pct: null,
      mean_velocity: null,
    };
  }
  // Loss% is computed on the native scale (ratio is unit-invariant); the
  // velocity values get converted to m/s for the payload so the field labels
  // match. `meanConcentricPeakVelocity` already converts.
  const firstRaw = reps[0].concentric.peakVelocity;
  const lastRaw = reps[reps.length - 1].concentric.peakVelocity;
  const peakRaw = peakConcentricBaseline(reps);
  const lossPct =
    reps.length < 2 || peakRaw <= 0
      ? null
      : Number((100 * ((peakRaw - lastRaw) / peakRaw)).toFixed(1));
  return {
    first_rep_v: mmsToMps(firstRaw),
    peak_rep_v: mmsToMps(peakRaw),
    peak_rep_number: baselineRepNumberFor(reps),
    last_rep_v: mmsToMps(lastRaw),
    velocity_loss_pct: lossPct,
    mean_velocity: meanConcentricPeakVelocity(reps),
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
  // `lossPct` is peak-to-last velocity loss and is always ≥ 0 — the last rep
  // can be at most the set's fastest rep. Phrase any positive loss as the
  // fatigue signal it is; omit the qualifier when the last rep WAS the peak
  // (zero loss) so we don't tack on a noisy "0.0% velocity loss".
  const withLoss =
    lossPct === null || lossPct === 0
      ? base
      : `${base}, ${lossPct.toFixed(1)}% velocity loss (peak-to-last)`;
  return cause === 'device_signal' ? `${withLoss} (set ended automatically)` : withLoss;
}

// VMCP-02.73: `buildSetPreSummaryPayload` / the `set_pre_summary` channel
// event were removed. The event derived from the same `aa 85 5f` frame in the
// same handler tick as `set_ended`, carried no unique data (the reconciled
// count, final-rep duration, and schema version are all on `set_ended`), and
// was a second reconciliation surface. No consumer read it by name. `set_ended`
// (`buildSetEndedPayload`) is now the single per-set close event.

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
    // VMCP-02.09: requested (cmd=0x10) vs applied (cmd=0x07) mode; training_mode
    // retained as a deprecated alias (= requested).
    requested_mode: string | null;
    active_mode: string | null;
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
      requested_mode: device.trainingMode ?? null,
      active_mode: activeModeName(device.trainingModeRaw),
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
 * count; `actualReps` is the just-finalized rep number (1-indexed).
 * Advisory cue only — the set keeps running.
 */
export function buildSetTargetReachedPayload(
  set: ActiveSet,
  device: DeviceSnapshot,
  target: number,
  actualReps: number,
): { meta: Record<string, string>; content: string } {
  const setIdShort = set.setId.slice(0, 8);
  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'set_target_reached',
    set_id: set.setId,
    session_id: set.sessionId,
    target_rep_count: String(target),
    actual_rep_count: String(actualReps),
  };
  const summary = `Target reached: ${actualReps}/${target} reps on set ${setIdShort}.`;
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
): { meta: Record<string, string>; content: string } {
  // `baseline` and `current` arrive in WA's native mm/s — convert at the
  // serialization boundary so the labels (`baseline_velocity`,
  // `current_velocity`, m/s in the summary) match the values. Loss% is
  // unit-invariant so the caller's pre-computed `pct` is passed through.
  const baselineMps = mmsToMps(baseline);
  const currentMps = mmsToMps(current);
  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'velocity_loss_exceeded',
    set_id: set.setId,
    session_id: set.sessionId,
    velocity_loss_pct: pct.toFixed(1),
    threshold_pct: String(threshold),
    baseline_velocity: baselineMps.toFixed(3),
    current_velocity: currentMps.toFixed(3),
    rep_count_at_threshold: String(actualReps),
  };
  const summary =
    `Velocity dropped ${pct.toFixed(1)}% (${baselineMps.toFixed(2)} -> ` +
    `${currentMps.toFixed(2)} m/s) on rep ${actualReps}. Threshold: ${threshold}%.`;
  const content = JSON.stringify({
    summary,
    trigger: {
      type: 'velocity_loss_exceeded',
      threshold_pct: threshold,
      actual_pct: Number(pct.toFixed(1)),
      baseline_velocity: baselineMps,
      current_velocity: currentMps,
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
  };
  const summary =
    `No reps for ${(actualIdleMs / 1000).toFixed(0)}s on set ${setIdShort} ` +
    `(threshold ${thresholdMs / 1000}s) — auto-stopping.`;
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
 * Guided-load phase machine, mirrored locally so this module doesn't pull in
 * the SDK type (matches the `ConnectionState` mirroring below). The SDK's
 * `GuidedLoadPhase` union is `idle | armed | countdown | engaging | active |
 * exited | timeout`.
 */
export type GuidedLoadPhase =
  | 'idle'
  | 'armed'
  | 'countdown'
  | 'engaging'
  | 'active'
  | 'exited'
  | 'timeout';

/**
 * Branchable summary of where the guided-load flow stands. The key ergonomic
 * add of VMCP-02.03: agents branch on `outcome` (`failed` / `engaged`) instead
 * of memorizing the phase enum. `pending` covers the in-progress phases
 * (armed/countdown/engaging); `engaged` = active; `ended` = exited (clean
 * teardown); `failed` = timeout (the silent ceremony-skip / poll-window expiry).
 */
export type GuidedLoadOutcome = 'pending' | 'engaged' | 'ended' | 'failed';

/** Pure phase → outcome map. `idle` collapses to `pending` (not yet engaged). */
export function guidedLoadPhaseToOutcome(phase: GuidedLoadPhase): GuidedLoadOutcome {
  switch (phase) {
    case 'active':
      return 'engaged';
    case 'exited':
      return 'ended';
    case 'timeout':
      return 'failed';
    default:
      return 'pending';
  }
}

function guidedLoadSummary(
  phase: GuidedLoadPhase,
  countdownRemainingMs: number | null,
  requestedTargetLbs: number | undefined,
): string {
  const at = requestedTargetLbs !== undefined ? ` at ${requestedTargetLbs} lbs` : '';
  switch (phase) {
    case 'armed':
      return `Guided load armed${at} — waiting for the unload ceremony.`;
    case 'countdown':
      return countdownRemainingMs !== null
        ? `Guided load countdown: ${countdownRemainingMs} ms remaining.`
        : 'Guided load countdown in progress.';
    case 'engaging':
      return `Guided load engaging${at}.`;
    case 'active':
      return `Guided load engaged${at}.`;
    case 'exited':
      return 'Guided load exited.';
    case 'timeout':
      return (
        `Guided load FAILED to engage${at} (ceremony skipped or timed out). ` +
        `Call device.unload and re-trigger.`
      );
    case 'idle':
      return 'Guided load idle.';
  }
}

export interface GuidedLoadStatePayloadInput {
  phase: GuidedLoadPhase;
  countdownRemainingMs: number | null;
  /** Requested target weight (lbs) stashed by `device.start_guided_load`. */
  requestedTargetLbs?: number | undefined;
  /** Auto-created (or reused) guided-load set/session, when present. */
  setId?: string | undefined;
  sessionId?: string | undefined;
}

/**
 * Build the meta + content for a first-class `guided_load_state` channel
 * event (VMCP-02.03). Promotes the previously debug-only phase machine to the
 * regular channel stream so PT Claude can react to engagement/failure without
 * polling `debug.recent_events`.
 *
 * NDA: deliberately omits `fitnessModeRaw` (the decoded firmware mode byte) —
 * the phase/outcome pair expresses the state semantically. The debug event
 * retains `fitnessModeRaw` for diagnostics; the customer-facing channel must
 * not surface firmware mode bytes.
 *
 * `countdown_remaining_ms` is present only on the `countdown` phase (per the
 * ticket); `requested_target_lbs` and the set-context keys are omitted when
 * unavailable (e.g. a unit-direct guided load with no tool stash).
 */
export function buildGuidedLoadStatePayload(input: GuidedLoadStatePayloadInput): {
  meta: Record<string, string>;
  content: string;
} {
  const outcome = guidedLoadPhaseToOutcome(input.phase);
  const showCountdown = input.phase === 'countdown' && input.countdownRemainingMs !== null;
  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'guided_load_state',
    phase: input.phase,
    outcome,
  };
  if (showCountdown) {
    meta.countdown_remaining_ms = String(input.countdownRemainingMs);
  }
  if (input.requestedTargetLbs !== undefined) {
    meta.requested_target_lbs = String(input.requestedTargetLbs);
  }
  if (input.setId !== undefined) {
    meta.set_id = input.setId;
  }
  if (input.sessionId !== undefined) {
    meta.session_id = input.sessionId;
  }
  const content = JSON.stringify({
    summary: guidedLoadSummary(input.phase, input.countdownRemainingMs, input.requestedTargetLbs),
    guided_load: {
      phase: input.phase,
      outcome,
      countdown_remaining_ms: showCountdown ? input.countdownRemainingMs : null,
      requested_target_lbs: input.requestedTargetLbs ?? null,
    },
    set_context:
      input.setId !== undefined
        ? { set_id: input.setId, session_id: input.sessionId ?? null }
        : null,
  });
  return { meta, content };
}

export interface ModeDivergedPayloadInput {
  /** Requested-mode name (cmd=0x10), e.g. `"Isokinetic"`. */
  requestedMode: string | null;
  /** Applied-mode name (cmd=0x07), e.g. `"Weight Training"` / `"unverified(7)"`. */
  activeMode: string | null;
  /** How long the modes had disagreed at emit time, in ms. */
  divergedForMs: number;
  /** Active set/session, when one is open. */
  setId?: string | undefined;
  sessionId?: string | undefined;
}

/**
 * Build the meta + content for a `mode_diverged` channel event (VMCP-02.09c).
 * Synthesized by the bridge when the requested (cmd=0x10) and applied (cmd=0x07)
 * training modes disagree past the debounce window — the "asked for X, running
 * Y" condition VMCP-02.09a made visible. Mirrors `set_aborted_by_mode_revert`:
 * a requested≠applied signal lifted to a first-class event so PT Claude can
 * tell the user the mode change may not have taken.
 *
 * The `slot` meta key is injected by the per-slot channel publisher.
 */
export function buildModeDivergedPayload(input: ModeDivergedPayloadInput): {
  meta: Record<string, string>;
  content: string;
} {
  const requested = input.requestedMode ?? 'unknown';
  const active = input.activeMode ?? 'unknown';
  const seconds = (input.divergedForMs / 1000).toFixed(1);
  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'mode_diverged',
    requested_mode: requested,
    active_mode: active,
    diverged_for_ms: String(input.divergedForMs),
  };
  if (input.setId !== undefined) {
    meta.set_id = input.setId;
  }
  if (input.sessionId !== undefined) {
    meta.session_id = input.sessionId;
  }
  const content = JSON.stringify({
    summary:
      `Mode mismatch: requested ${requested} but the device is running ${active} ` +
      `(${seconds}s). The mode change may not have taken — re-select on the unit.`,
    divergence: {
      requested_mode: input.requestedMode,
      active_mode: input.activeMode,
      diverged_for_ms: input.divergedForMs,
    },
    set_context:
      input.setId !== undefined
        ? { set_id: input.setId, session_id: input.sessionId ?? null }
        : null,
  });
  return { meta, content };
}

/**
 * Compute the dedupe key for a trigger spec. Used by the bridge's
 * `tryFireTrigger` ledger so identical specs in `notifyOn` collapse to
 * one event while distinct thresholds fire independently.
 */
export function triggerDedupeKey(spec: TriggerSpec): string {
  switch (spec.type) {
    case 'rep_count_reached':
      return `${spec.type}:${spec.value}`;
    case 'velocity_loss_exceeded':
      return `${spec.type}:${spec.pct}`;
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
      // VMCP-02.09: requested (cmd=0x10) vs applied (cmd=0x07) mode; training_mode
      // retained as a deprecated alias (= requested).
      requested_mode: device.trainingMode ?? null,
      active_mode: activeModeName(device.trainingModeRaw),
      training_mode: device.trainingMode ?? null,
      damper_level: device.damperLevel ?? null,
      stale_since_disconnect: device.staleSinceDisconnect ?? null,
    },
    active_set_at_disconnect: state === 'disconnected' ? activeSet : null,
  });
  return { meta, content };
}

/**
 * Advisory attached to `device.get_state` / `bilateral.cascade` returns to
 * explain the delayed disconnect notice the agent is about to read.
 */
const DISCONNECT_NOTICE_TEXT =
  'Slot disconnected while idle since your last tool call. Surfacing the drop ' +
  'here because push channels were off. Verify the connection before loading ' +
  'the cable; this notice is delivered once.';

/**
 * Build the one-shot {@link PendingDisconnectNotice} the bridge stashes on a
 * disconnect while channels are off (VMCP-02.32). Reuses the same `device`
 * snapshot and pre-cascade `activeSet` inputs as
 * {@link buildConnectionChangedPayload} so the drained advisory mirrors the
 * `connection_changed` channel event's disconnect shape (state,
 * disconnected_at, mid-set context). Advisory only — no motor action.
 */
export function buildPendingDisconnectNotice(
  device: DeviceSnapshot,
  activeSet: ActiveSetAtDisconnect | null,
): PendingDisconnectNotice {
  return {
    event_type: 'connection_changed',
    state: 'disconnected',
    disconnected_at: device.disconnectedAt ?? null,
    mid_set: activeSet !== null,
    active_set_at_disconnect: activeSet,
    note: DISCONNECT_NOTICE_TEXT,
  };
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
  // VMCP-02.40: chain + weight transitions now publish from the cmd=0x10
  // cascade path under the user-facing field names. The state-dump-derived
  // `chainTargetForceTenths` / `weightLbsTenths` no longer emit per-field
  // settings_update channel events (they remain in the `__all` payload for
  // diagnostic context) — they're the firmware's lazily-computed
  // effective-force values and false-positive on mode-bounce transients.
  | 'chainSettingLbs'
  | 'weightLbs'
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
 * Build the meta + content for a `setting_coerced` channel event (F2+F3).
 *
 * Fires when the bridge correlates a recent setter return against a
 * subsequent state-dump / settings-update field value whose device value
 * differs from the user-requested value. The payload is advisory only —
 * per memory rule `feedback_no_force_stop_set_close.md` the bridge does
 * NOT retry the setter, disconnect, or otherwise auto-recover. It informs
 * PT Claude that the device silently rewrote a setting so the model can
 * explain the coercion to the user.
 *
 * Meta keys are XML attributes (strings only). Content JSON carries the
 * structured detail. `summary` is field-specific where helpful (see
 * `coercionSummaryFor`); unknown fields fall back to a generic phrasing.
 */
export interface CoercionSetContext {
  /**
   * Slot the coercion was observed on. The slot-scoped publisher already
   * folds this into the outgoing channel meta as `slot`, so the
   * payload-builder echoes the value into the content JSON's
   * `set_context.slot_id` (and into meta as `slot_id` for parity with the
   * other set/session id keys) so JSON-only consumers don't have to read
   * the wrapper attribute to attribute the event.
   */
  slotId: string;
  setId: string | null;
  sessionId: string | null;
}

export function buildSettingCoercedPayload(
  check: PendingCoercionCheck,
  deviceValue: number,
  now: number,
  device: DeviceSnapshot,
  context: CoercionSetContext,
): { meta: Record<string, string>; content: string } {
  const coercionDelta = deviceValue - check.requested;
  const coercionWindowMs = now - check.setterReturnedAt;
  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'setting_coerced',
    field: check.field,
    requested_value: String(check.requested),
    device_value: String(deviceValue),
    source_setter: check.setterName,
    coercion_delta: String(coercionDelta),
    coercion_window_ms: String(coercionWindowMs),
    slot_id: context.slotId,
  };
  if (context.setId !== null) {
    meta.set_id = context.setId;
  }
  if (context.sessionId !== null) {
    meta.session_id = context.sessionId;
  }
  const summary = coercionSummaryFor(check, deviceValue, device);
  const content = JSON.stringify({
    summary,
    field: check.field,
    requested: check.requested,
    device: deviceValue,
    delta: coercionDelta,
    source_setter: check.setterName,
    coercion_window_ms: coercionWindowMs,
    set_context: {
      slot_id: context.slotId,
      set_id: context.setId,
      session_id: context.sessionId,
      weight_lbs: device.weightLbs ?? null,
      // VMCP-02.09: requested (cmd=0x10) vs applied (cmd=0x07) mode; training_mode
      // retained as a deprecated alias (= requested).
      requested_mode: device.trainingMode ?? null,
      active_mode: activeModeName(device.trainingModeRaw),
      training_mode: device.trainingMode ?? null,
    },
  });
  return { meta, content };
}

/**
 * Pick a field-specific phrasing for the summary line. The eccentric +
 * assist + chains + weight branches name the safety constraint or behavior
 * the model can explain to the user; everything else falls back to the
 * generic phrasing per the design doc.
 */
function coercionSummaryFor(
  check: PendingCoercionCheck,
  deviceValue: number,
  device: DeviceSnapshot,
): string {
  switch (check.field) {
    case 'eccentricPercentTenths':
      return eccCoercionSummary(check, deviceValue, device);
    case 'chainTargetForceTenths':
      return chainsCoercionSummary(check, deviceValue, device);
    case 'weightLbsTenths':
      return `Device coerced weight ${tenthsToLbs(check.requested)} -> ${tenthsToLbs(deviceValue)} lbs after ${check.setterName}.`;
    case 'assistMode':
      return `Device coerced assist mode ${check.requested} -> ${deviceValue} after ${check.setterName}.`;
    case 'damperLevel':
      return `Device coerced damper level ${check.requested} -> ${deviceValue} after ${check.setterName}.`;
    default:
      return `Device coerced ${check.field} ${check.requested} -> ${deviceValue} after ${check.setterName}.`;
  }
}

function eccCoercionSummary(
  check: PendingCoercionCheck,
  deviceValue: number,
  _device: DeviceSnapshot,
): string {
  // Original 2026-05-11 capture hypothesized "assistMode=on enforces a
  // non-zero ecc floor" and we appended that to the summary when
  // device.assistMode === 2. Hardware re-validation 2026-05-11 evening
  // disproved this — vendor docs confirm assist mode is a mid-rep
  // automated spotter, unrelated to the ecc setpoint, and the original
  // 320 reading was a transient mid-cascade observation rather than a
  // sticky floor. We no longer claim a cause in the summary.
  const reqPct = check.requested / 10;
  const devPct = deviceValue / 10;
  return `Device coerced ecc ${reqPct}% -> ${devPct}% after ${check.setterName}.`;
}

function chainsCoercionSummary(
  check: PendingCoercionCheck,
  deviceValue: number,
  _device: DeviceSnapshot,
): string {
  return `Device coerced chains ${tenthsToLbs(check.requested)} -> ${tenthsToLbs(deviceValue)} lbs after ${check.setterName}.`;
}

function tenthsToLbs(tenths: number): number {
  return Number((tenths / 10).toFixed(1));
}

function round1(value: number): number {
  return Number(value.toFixed(1));
}

/**
 * Build the meta + content for a `weight_implied_mismatch` channel event
 * (VMCP-02.68). Fired at set finalize when the force-implied weight (median
 * concentric peak force ÷ the calibration constant) disagrees with the logged
 * header weight by more than the configured ratio. Advisory only — mirrors the
 * `setting_coerced` shape (no coercion, no rewrite of the stored weight). The
 * `calibration_note` flags that the implied weight rests on a single-session
 * force/lb constant so the model qualifies the claim to the user.
 */
export function buildWeightImpliedMismatchPayload(
  stored: StoredSet,
  result: WeightImpliedResult,
  slotId: string,
): { meta: Record<string, string>; content: string } {
  const impliedLbs = round1(result.impliedWeightLbs);
  const mismatchPct = round1(result.ratio * 100);
  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'weight_implied_mismatch',
    set_id: stored.id,
    session_id: stored.sessionId,
    slot_id: slotId,
    header_weight_lbs: String(stored.weightLbs),
    implied_weight_lbs: String(impliedLbs),
    mismatch_pct: String(mismatchPct),
  };
  const content = JSON.stringify({
    summary: `Force-implied weight ${impliedLbs} lb disagrees with the logged header weight ${stored.weightLbs} lb by ${mismatchPct}% for set ${stored.id.slice(0, 8)}.`,
    header_weight_lbs: stored.weightLbs,
    implied_weight_lbs: impliedLbs,
    median_concentric_peak_force: round1(result.medianConcentricPeakForce),
    mismatch_pct: mismatchPct,
    rep_count: stored.reps.length,
    calibration_note:
      'Implied weight uses a single-cable-session force/lb constant; treat as advisory and re-calibrate per device / movement.',
    set_context: { slot_id: slotId, set_id: stored.id, session_id: stored.sessionId },
  });
  return { meta, content };
}

/**
 * Build the meta + content for a `bilateral_divergence` channel event
 * (VMCP-02.67). Fired when the reconciler pairs two opposite-slot set closes
 * whose rep counts differ by one or more. Cross-slot by nature, so it carries
 * both sides' slot / session / set ids and counts rather than being scoped to
 * a single slot. `delta` is `a.rep_count − b.rep_count` (signed).
 */
export function buildBilateralDivergencePayload(divergence: BilateralDivergence): {
  meta: Record<string, string>;
  content: string;
} {
  const { a, b, delta } = divergence;
  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'bilateral_divergence',
    slot_id: a.slotId,
    partner_slot_id: b.slotId,
    session_id: a.sessionId,
    partner_session_id: b.sessionId,
    set_id: a.setId,
    partner_set_id: b.setId,
    rep_count: String(a.repCount),
    partner_rep_count: String(b.repCount),
    rep_count_delta: String(delta),
    weight_lbs: String(a.weightLbs),
  };
  const content = JSON.stringify({
    summary: `Bilateral rep-count mismatch at ${a.weightLbs} lb: slot ${a.slotId} logged ${a.repCount} reps vs slot ${b.slotId} ${b.repCount} (delta ${delta}).`,
    delta,
    weight_lbs: a.weightLbs,
    sides: [
      {
        slot_id: a.slotId,
        session_id: a.sessionId,
        set_id: a.setId,
        rep_count: a.repCount,
      },
      {
        slot_id: b.slotId,
        session_id: b.sessionId,
        set_id: b.setId,
        rep_count: b.repCount,
      },
    ],
  });
  return { meta, content };
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

/**
 * Build the meta + content for an `idle_rep` channel event. Fires when the
 * bridge detects a rep boundary from the frame stream while no MCP set is
 * armed — i.e., the user completed a rep between two `set.start` calls.
 *
 * `entry` is the `IdleRep` just recorded on `LiveState`. `idleRepCount` is
 * the monotonic counter AFTER this rep (so `idleRepCount === 1` for the first
 * idle rep in a session window). The PT skill can compare `idleRepCount` to
 * `idleReps.length` from the session resource to detect buffer overflow.
 *
 * `vCon` and `rom` are null when the concentric phase had no movement samples
 * (unusual — typically means the rep boundary fired on a very short burst with
 * insufficient frames). The meta only includes them when non-null to avoid
 * "null" strings in attribute filtering.
 */
/**
 * Build the meta + content for an `idle_rep_summary` channel event (VMCP-02.11).
 * Replaces the per-occurrence `idle_rep` stream by default so the channel
 * doesn't drown in noise when the user rests between real sets.
 *
 * Emitted once per 5s window when at least one idle rep was observed during
 * the window. Empty windows are skipped (no zero-count summaries). The
 * verbose path (`session.start { verboseIdleReps: true }`) suppresses
 * summaries entirely.
 *
 * `count` is the number of idle reps detected in this window. `idleRepCount`
 * is the session-monotonic total AFTER this window (matches the resource
 * counter). `sinceMs` / `untilMs` bound the window in wall-clock ms; the
 * model can use them to attribute the count to a specific rest interval.
 * `windowMs` is the configured cadence (5000ms today; documented so a future
 * tuning is observable from the wire).
 */
export function buildIdleRepSummaryPayload(args: {
  slot: string;
  count: number;
  idleRepCount: number;
  sinceMs: number;
  untilMs: number;
  windowMs: number;
}): { meta: Record<string, string>; content: string } {
  const { slot, count, idleRepCount, sinceMs, untilMs, windowMs } = args;
  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'idle_rep_summary',
    slot,
    count: String(count),
    idle_rep_count: String(idleRepCount),
  };
  const summary = `${count} idle rep${count === 1 ? '' : 's'} in last ${Math.round(windowMs / 1000)}s (no set armed). Session total idle: ${idleRepCount}.`;
  const content = JSON.stringify({
    summary,
    idle_rep_summary: {
      count,
      since_ms: sinceMs,
      until_ms: untilMs,
      window_ms: windowMs,
      slot,
    },
    idle_rep_count: idleRepCount,
  });
  return { meta, content };
}

/**
 * Build the meta + content for a passive `rest_status` channel event
 * (VMCP-02.08). Emitted on a 15s cadence after `set_ended` (capped at
 * 5 minutes) so the PT skill can observe elapsed rest time without
 * blocking on `timer.wait` or polling.
 *
 * `elapsedSeconds` is the seconds since the originating `set_ended`
 * (0 on the initial emit, then 15, 30, ... up to `capSeconds`).
 * `setId` is the id of the set that just ended; the model uses it to
 * attribute the rest period to a specific set. `final` is `true` only
 * on the terminal emit at the cap — the skill can use it to surface
 * "long rest" coaching or simply stop expecting more rest_status events.
 */
export function buildRestStatusPayload(args: {
  slotId: string;
  setId: string;
  elapsedSeconds: number;
  capSeconds: number;
  final: boolean;
}): { meta: Record<string, string>; content: string } {
  const { slotId, setId, elapsedSeconds, capSeconds, final } = args;
  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'rest_status',
    slot: slotId,
    set_id: setId,
    elapsed_seconds: String(elapsedSeconds),
  };
  if (final) {
    meta.final = 'true';
  }
  const summary = final
    ? `Rest reached cap (${capSeconds}s elapsed since set ${setId.slice(0, 8)}). No further rest_status events for this set.`
    : `Resting: ${elapsedSeconds}s elapsed since set ${setId.slice(0, 8)}.`;
  const content = JSON.stringify({
    summary,
    rest_status: {
      slot: slotId,
      set_id: setId,
      elapsed_seconds: elapsedSeconds,
      cap_seconds: capSeconds,
      final,
    },
  });
  return { meta, content };
}

export function buildIdleRepPayload(
  entry: IdleRep,
  idleRepCount: number,
): { meta: Record<string, string>; content: string } {
  // LiveState stores `vCon` in mm/s and `rom` in mm (the raw scale WA
  // returns from `getPhaseMeanVelocity` / `getPhaseRangeOfMotion`). The
  // channel payload documents both as m/s and metres respectively, so
  // convert at the emit boundary (F18 / VMCP-01.32).
  const vConMps = entry.vCon !== null ? mmsToMps(entry.vCon) : null;
  const romM = entry.rom !== null ? mmToM(entry.rom) : null;
  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'idle_rep',
    slot: entry.slot,
    idle_rep_count: String(idleRepCount),
  };
  if (vConMps !== null) {
    meta.v_con = vConMps.toFixed(3);
  }
  const summary =
    vConMps !== null
      ? `Idle rep detected (no set armed): ${vConMps.toFixed(2)} m/s mean conc. Total idle: ${idleRepCount}.`
      : `Idle rep detected (no set armed): no velocity data. Total idle: ${idleRepCount}.`;
  const content = JSON.stringify({
    summary,
    idle_rep: {
      ts: entry.ts,
      v_con: vConMps,
      rom: romM,
      slot: entry.slot,
    },
    idle_rep_count: idleRepCount,
  });
  return { meta, content };
}

/**
 * Build the meta + content for a `voltras_available` channel event
 * (VMCP-02.19). Fires from the passive scanner when one or more Voltras
 * appear in the BLE scan results that weren't there on the prior tick.
 * Advisory only — the agent decides whether to call `device.connect`.
 *
 * Meta keys are XML attributes (strings only). `content` JSON carries
 * the structured detail (device id list, optional RSSI map).
 */
export function buildVoltrasAvailablePayload(
  devices: ReadonlyArray<{ id: string; rssi?: number }>,
): {
  meta: Record<string, string>;
  content: string;
} {
  const ids = devices.map((d) => d.id);
  const meta: Record<string, string> = {
    source: 'voltras',
    event_type: 'voltras_available',
    device_count: String(devices.length),
    device_ids: ids.join(','),
  };
  const rssiByDeviceId: Record<string, number> = {};
  for (const d of devices) {
    if (d.rssi !== undefined) rssiByDeviceId[d.id] = d.rssi;
  }
  const summary =
    devices.length === 1
      ? `Voltra ${ids[0]} is now reachable. Use device.connect to bind it to a slot.`
      : `${devices.length} Voltras are now reachable: ${ids.join(', ')}. Use device.connect to bind each to a slot.`;
  const content = JSON.stringify({
    summary,
    device_ids: ids,
    rssi_by_device_id: rssiByDeviceId,
  });
  return { meta, content };
}
