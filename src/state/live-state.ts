// In-memory live state for voltras-mcp.
//
// `LiveState` is the synchronous, pure-data collector that backs the three
// MCP resources (`voltra://device/current`, `voltra://session/active`,
// `voltra://set/active`) and the `set.live_metrics` polling fallback. It owns
// no I/O — the event-bridge (Task 09) feeds it from SDK callbacks, and the
// resource handlers (Task 11+) read from it via the `snapshot*` methods.
//
// Behavior contracts encoded here:
//   * Battery coercion: SDK reports `battery: number | null`, but the JSON
//     output schema for `DeviceSnapshot` allows only `number | undefined`. The
//     `applySettings` mutator coerces `null → undefined` so a stray null can
//     never escape into a tool/resource result. (Critic FIX #6.)
//   * Stale-rep drop: any `appendRep` call after `endSet` is silently ignored
//     so disconnect-induced stragglers never mutate a set the server has
//     already considered finalized. (EC-11.)
//   * Snapshot independence: every `snapshot*` method returns a fresh shallow
//     copy with cloned arrays where applicable, so callers cannot mutate
//     internal state through the returned reference.
//   * `rssi` is intentionally absent from `DeviceSnapshot` until Task 10
//     confirms the SDK getter — see critic FIX in critic-report.md.
//
// The `applySettings` signature uses `Partial<DeviceSnapshot>` for the input
// rather than the SDK's settings type so the caller (event-bridge) can keep
// SDK-shape conversion at its own seam.
import type { InProgressEvent, SetSummaryEvent, SummaryEvent } from '@voltras/node-sdk';
import type { Rep, Set as AnalyticsSet, WorkoutSample } from '@voltras/workout-analytics';
import {
  createSet,
  addSampleToSet,
  completeSet,
  getPhaseMeanVelocity,
  getPhaseRangeOfMotion,
} from '@voltras/workout-analytics';

import type { TrainingModeName } from '../schemas/common.js';
import type { WatchConfig } from '../schemas/set.js';

/** Latest known device-level state. All fields are best-effort snapshots. */
export interface DeviceSnapshot {
  connected: boolean;
  /**
   * Last-known BLE device id (e.g. `"V-097082"`). Captured from the SDK's
   * `client.connectedDeviceId` on the first `onConnectionStateChange('connected')`
   * after a connect, then preserved across the soft-reset disconnect window so
   * `voltra://device/{slot}/current` and `device.get_state` can both surface
   * which device was last bound to this slot even while `client` itself has
   * been swapped to a fresh `VoltraClient` by `resetPrimarySlot`.
   */
  deviceId?: string;
  weightLbs?: number;
  trainingMode?: TrainingModeName;
  batteryPercent?: number;
  /** Damper resistance level (0-9). SDK 0.7.0 Bug 17 fix preserves this
   *  across reconnect; populated via `applySettings` on the `onSettingsUpdate`
   *  path and replayed from `client.settings` at connect time (D4). */
  damperLevel?: number;
  /** ISO timestamp of the last connection drop, when one is known. */
  disconnectedAt?: string;
  /**
   * Assist-mode raw value from the last cmd=0x07 state-dump frame. 0 = off,
   * 2 = on, 8 = device idle / no active mode (Bug 26). Absent until the
   * first state-dump has been received.
   */
  assistMode?: number;
  /**
   * Active training mode raw byte from the last cmd=0x07 state-dump
   * (0 = transitional / mid-mode-switch, 1 = WeightTraining,
   * 2 = ResistanceBand). Distinct from {@link trainingMode} above, which is
   * the string form sourced from the cmd=0x10 cascade. Absent until the
   * first state-dump has fired.
   */
  trainingModeRaw?: number;
  /**
   * Effective chain target force at the cable in tenths of pounds, decoded
   * from bytes [8-9] of the cmd=0x07 inner `aa 80 25` envelope. Equals
   * `min(chains, weight) × 10` — the device silently caps chain setting at
   * the active weight. For the user's chains setting in lbs prefer
   * {@link chainSettingLbs} (sourced from the cmd=0x10 cascade).
   */
  chainTargetForceTenths?: number;
  /**
   * Active weight setting in tenths of pounds, decoded from bytes [6-7] of
   * the cmd=0x07 inner `aa 80 25` envelope. Mirrors the cmd=0x10 cascade
   * `baseWeight` × 10. Zero in non-WeightTraining modes.
   */
  weightLbsTenths?: number;
  /**
   * Eccentric overload setting in tenths of percent, decoded from bytes
   * [10-11] of the cmd=0x07 inner `aa 80 25` envelope. Mirrors the cmd=0x10
   * cascade `eccentric` × 10.
   */
  eccentricPercentTenths?: number;
  /**
   * User's chains setting in pounds, sourced from the cmd=0x10 cascade
   * `chains` field on `onSettingsUpdate`. This is the value the firmware
   * accepted after its silent chains≤weight cap (e.g., a `set_chains(60)`
   * write against weight=50 surfaces here as 50). On-device testing
   * 2026-05-07 confirmed this matches the user's most recent post-cap
   * setting and is reliable.
   */
  chainSettingLbs?: number;
  /**
   * ISO timestamp set on disconnect and cleared on the first device push
   * after the next reconnect. Consumers can read this to know the rest of
   * the snapshot is the LAST KNOWN value from before the disconnect rather
   * than freshly-confirmed data. Soft-reset semantics: `slot-manager`'s
   * `resetPrimarySlot` no longer wipes LiveState — it marks the snapshot
   * stale and the bridge clears the flag once a real push lands.
   */
  staleSinceDisconnect?: string;
  /**
   * Convenience boolean mirroring `staleSinceDisconnect !== undefined`.
   * Lets `channel-payloads` and resource-shape consumers branch on
   * staleness without re-reading the timestamp.
   */
  isStale?: boolean;
}

/** Active session metadata. `setIds` accumulates as sets close. */
export interface ActiveSession {
  sessionId: string;
  startedAt: string;
  exerciseId?: string;
  exerciseName?: string;
  setIds: string[];
  status: 'active' | 'ended';
  disconnectedAt?: string;
  /**
   * Marks sessions the bridge minted on the user's behalf (vs sessions
   * explicitly started via `session.start`). Today only the guided-load
   * Phase 1g bootstrap auto-creates a session; the tag exists so the
   * `device.exit_guided_load` reap path can distinguish "tear down my own
   * scaffold" from "leave the explicit session alone" without string-
   * matching on `exerciseName`. F8 (VMCP-01.24).
   */
  autoCreatedBy?: 'guided_load';
}

/** Active set with its live rep buffer. `endedAt`/`partialReason` set on close. */
export interface ActiveSet {
  setId: string;
  sessionId: string;
  startedAt: string;
  reps: Rep[];
  status: 'active' | 'ended' | 'partial';
  endedAt?: string;
  /**
   * Why the set ended in something other than a graceful tool call.
   *   * `'disconnect'`    — connection drop cascade
   *   * `'session_end'`   — explicit `session.end` cascade
   *   * `'device_signal'` — historical: device-driven close
   *     (`onSetSummary` lands on an active set in WT/RB/Damper). The
   *     F14/F15 rewrite treats this as the canonical natural close (not
   *     partial). Retained here for any callers that still pass it for
   *     historical reasons.
   *   * `'inactivity_timeout'` — no SDK activity (in-progress / per-rep /
   *     set-summary) on the active set for `SET_INACTIVITY_TIMEOUT_MS`;
   *     bridge watchdog finalized as partial. The user truly abandoned the
   *     set; the bridge force-closes to free resources. Safety net for
   *     modes that don't emit a per-set close marker (rowing, iso,
   *     custom-curves) AND for any mode where the user walks away.
   *   * `'guided_load_exited'` — `device.exit_guided_load` reaped the
   *     auto-created set the Phase 1g bootstrap had minted on `armed`.
   *     F4 (VMCP-01.19) — closes the 93s inactivity_timeout leak that
   *     followed every guided-load demo.
   */
  partialReason?:
    | 'disconnect'
    | 'session_end'
    | 'device_signal'
    | 'inactivity_timeout'
    | 'guided_load_exited';
  /**
   * Trigger DSL config registered at `set.start` time. The bridge evaluates
   * triggers against finalized reps; the watchdog (sprint 2 commit 2) wires
   * `idle_timeout_ms` specs to a per-set timer in `state.setWatchdog`.
   * Undefined for sets started without a `watch` arg.
   */
  watch?: WatchConfig;
  /**
   * Dedupe ledger for trigger firings. Keys take the form
   * `${type}:${value or pct}` so identical specs collapse to one event,
   * while distinct thresholds (e.g., 15%, 25%, 40% velocity loss) all
   * fire independently as the set progresses.
   */
  firedTriggers?: Set<string>;
  /**
   * Most recent `onInProgress` payload while the set is active. Single-slot
   * — every heartbeat overwrites the prior tick rather than accumulating.
   * Exposed through `set.live_metrics` so coaching reads see the latest
   * peak-force / velocity / target-weight values without subscribing to the
   * raw frame stream. Cleared implicitly when `endSet` discards the active
   * set; once the set ends, `set.live_metrics` returns `{ active: false }`
   * anyway, so there's nothing to dangle.
   */
  latestInProgress?: {
    peakForceTenths: number;
    currentForceTenths: number;
    velocityCmPerSec: number;
    targetWeightTenths: number;
    /** `Date.now()` ms at the time the bridge captured the heartbeat. */
    capturedAt: number;
  };
  /**
   * Most recent `onSummary` payload received during this set's lifetime.
   * Read-and-cleared by `endSet` (via `consumeLatestSummary`) so the
   * finalized set carries it forward to the persisted payload exactly once.
   * If `endSet` runs without a prior `onSummary` (mid-set disconnect, no
   * graceful close), the finalized set has no summary block — never stale.
   *
   * Note: `aa 86 7d` "summary" is workout-end / post-STOP only and may not
   * fire at all in WT/RB/Damper. Per-set device-driven close in those modes
   * is signaled by `onSetSummary` (`aa 85 5f`) — see `latestSetSummary`.
   */
  latestSummary?: {
    repCount: number;
    schemaVersion: number;
  };
  /**
   * Most recent `onSetSummary` payload received during this set's lifetime.
   * Captured by `applySetSummary`, read-and-cleared by `endSet` (via
   * `consumeLatestSetSummary`). The bridge calls `finalizeSet` synchronously
   * after the apply, so the captured payload is always consumed before
   * `endSet` discards the active set.
   */
  latestSetSummary?: {
    repCount: number;
    repDurationMs: number;
    targetWeightTenths: number;
    schemaVersion: number;
  };
  /**
   * Unix-ms timestamp of the most recent SDK activity on the active set
   * (`onInProgress` / `onSetSummary` / WA rep boundary). The bridge's
   * inactivity watchdog finalizes the set as `partial` /
   * `inactivity_timeout` if this stays unchanged for
   * `SET_INACTIVITY_TIMEOUT_MS`. Initialized to `set.startedAt` when
   * `startSet` runs.
   */
  lastActivityAt?: number;
}

/**
 * A rep captured while no MCP set was armed. Carries the minimal VBT shape
 * needed for the PT skill to detect missed reps and optionally retroactively
 * attach them to the next set.
 *
 * UNITS: stored on this struct in the raw scale workout-analytics returns —
 * `vCon` is the mean concentric velocity in **mm/s** (from
 * `getPhaseMeanVelocity`), and `rom` is the concentric range-of-motion in
 * **mm** (from `getPhaseRangeOfMotion`). The `idle_rep` channel payload and
 * the session resource convert both to m/s and metres respectively at the
 * serialization boundary (F18 / VMCP-01.32). Both are null when the
 * concentric phase had no movement samples (rare; typically means the rep
 * boundary fired mid-phase-transition before enough frames arrived).
 */
export interface IdleRep {
  ts: number;
  /** Mean concentric velocity in mm/s. Converted to m/s at the channel/resource boundary. */
  vCon: number | null;
  /** Concentric range-of-motion in mm. Converted to metres at the channel/resource boundary. */
  rom: number | null;
  slot: string;
}

/** Maximum entries retained in the `idleReps` ring buffer. Monotonic
 *  `idleRepCount` continues past this cap so the PT skill can distinguish
 *  "3 idle reps captured" from "23 idle reps, only last 20 buffered". */
const IDLE_REP_BUFFER_CAP = 20;

const EMPTY_DEVICE: DeviceSnapshot = Object.freeze({ connected: false });

/**
 * In-memory snapshot of current device, session, and set state.
 *
 * All mutations are synchronous; readers always see a consistent snapshot
 * because every mutator runs to completion before the next event handler.
 */
export class LiveState {
  device: DeviceSnapshot = { ...EMPTY_DEVICE };
  session: ActiveSession | undefined = undefined;
  set: ActiveSet | undefined = undefined;
  /**
   * Monotonic count of reps detected while no MCP set was armed. Increments
   * without bound; `idleReps` is capped at `IDLE_REP_BUFFER_CAP`. The PT
   * skill compares `idleRepCount > idleReps.length` to detect buffer overflow.
   */
  idleRepCount: number = 0;
  /**
   * Bounded ring of the most recent idle-arm reps (cap 20). Oldest entry
   * dropped when the buffer is full. Each entry carries `ts` (Date.now()),
   * `vCon` (mean concentric velocity, m/s), `rom` (concentric ROM, m), and
   * `slot` (the slot that detected the rep).
   */
  idleReps: IdleRep[] = [];
  /**
   * ISO timestamp captured by `markDisconnected`; cleared by `clearStaleness`
   * once the bridge observes a fresh device push (typically the first
   * `onSettingsUpdate` after reconnect). When non-null, every snapshot built
   * from `device` carries `staleSinceDisconnect` so consumers can
   * distinguish cached pre-disconnect state from freshly-confirmed data.
   */
  private _staleSinceDisconnect: string | undefined = undefined;
  /**
   * Internal analytics-set used to detect rep boundaries from the frame
   * stream. Mirrors the canonical mobile-app pipeline: `addSampleToSet`
   * starts a new rep on each ECCENTRIC→CONCENTRIC transition, and IDLE/HOLD
   * samples are folded into the current rep as hold time. The public
   * `this.set.reps` is kept in sync with `_analyticsSet.reps` after every
   * sample so `set.live_metrics` and the resource snapshots reflect the
   * in-progress rep without waiting for set.end.
   */
  private _analyticsSet: AnalyticsSet | undefined = undefined;
  /**
   * Analytics set that runs in the background while no MCP set is armed.
   * Detects rep boundaries from the frame stream so idle reps can be captured
   * into `idleReps`. Distinct from `_analyticsSet` (which only runs when a
   * set is active) so idle-arm tracking does not interfere with the active-set
   * pipeline. Allocated lazily on the first idle-arm sample and cleared by
   * `clearIdleReps()`.
   */
  private _idleAnalyticsSet: AnalyticsSet | undefined = undefined;

  /**
   * Merge partial device fields. Coerces `batteryPercent: null` to absent so
   * the JSON schema for `DeviceSnapshot` (which forbids null) is never
   * violated — see critic FIX #6. The SDK's `VoltraDeviceSettings.battery`
   * is typed `number | null`, but our `DeviceSnapshot.batteryPercent` is
   * `number | undefined`; the bridge passes the raw value through and we
   * normalize here so the coercion logic lives in exactly one place.
   */
  applySettings(s: Partial<DeviceSnapshot>): void {
    const merged: DeviceSnapshot = { ...this.device, ...s };
    // Defensive runtime null check — TS types disallow null on the input,
    // but the SDK contract makes runtime nulls reachable.
    if ((merged as { batteryPercent?: number | null }).batteryPercent == null) {
      delete merged.batteryPercent;
    }
    this.device = merged;
  }

  /**
   * Merge state-dump fields from a cmd=0x07 frame into the device snapshot.
   * Called by the event-bridge `onStateDump` handler; decoupled from
   * `applySettings` so callers can mutate just the assist/chains surface
   * without risk of clobbering the weight/mode/battery fields that arrive
   * through a separate settings-update path.
   */
  applyStateDump(
    fields: Pick<
      DeviceSnapshot,
      | 'assistMode'
      | 'trainingModeRaw'
      | 'chainTargetForceTenths'
      | 'weightLbsTenths'
      | 'eccentricPercentTenths'
    >,
  ): void {
    this.device = { ...this.device, ...fields };
  }

  /**
   * Begin a new session. If a session is already active this call is a no-op
   * — the higher-level `session.start` tool emits `SESSION_ALREADY_ACTIVE`
   * (EC-14), so reaching this method twice indicates a bug; we choose
   * silent no-op over throw to keep state-layer mutators total.
   */
  startSession(s: ActiveSession): void {
    if (this.session !== undefined) {
      return;
    }
    this.session = { ...s, setIds: [...s.setIds] };
  }

  /**
   * Close out the active session. Returns the prior session (status set to
   * `'ended'`) for the caller to persist, or `undefined` when no session was
   * active.
   */
  endSession(): ActiveSession | undefined {
    const current = this.session;
    if (current === undefined) {
      return undefined;
    }
    this.session = undefined;
    return { ...current, setIds: [...current.setIds], status: 'ended' };
  }

  /**
   * Begin a new set. Same no-op-on-conflict policy as `startSession` (the
   * tool layer enforces EC-13 `SET_ALREADY_ACTIVE`).
   *
   * If `s.watch` is supplied, the trigger DSL config is stored on the active
   * set and a fresh `firedTriggers` ledger is initialized so trigger dedupe
   * starts clean for every new set.
   */
  startSet(s: ActiveSet): void {
    if (this.set !== undefined) {
      return;
    }
    const startedMs = Date.parse(s.startedAt);
    this.set = {
      ...s,
      reps: [...s.reps],
      lastActivityAt: Number.isFinite(startedMs) ? startedMs : Date.now(),
      ...(s.watch !== undefined ? { watch: s.watch, firedTriggers: new Set<string>() } : {}),
    };
    this._analyticsSet = createSet();
  }

  /**
   * Close out the active set. `reason` distinguishes graceful close
   * (`undefined`), explicit `session.end` cascade (`'session_end'`),
   * connection loss (`'disconnect'`), bridge inactivity-watchdog force-close
   * (`'inactivity_timeout'`), and the guided-load reap path
   * (`'guided_load_exited'`). Returns the finalized set for the caller to
   * persist, or `undefined` when none was active.
   *
   * Watch triggers (`rep_count_reached`, `velocity_loss_exceeded`) are
   * advisory cues and never force-close the set — the only remaining
   * force-close path is the bridge inactivity watchdog.
   *
   * The set's `setId` is appended to the active session's `setIds` if a
   * session is still tracked, so resource snapshots reflect the close
   * synchronously.
   */
  endSet(
    reason?: 'disconnect' | 'session_end' | 'inactivity_timeout' | 'guided_load_exited',
    opts: { dropTrailingInProgress?: boolean } = {},
  ): ActiveSet | undefined {
    const current = this.set;
    if (current === undefined) {
      return undefined;
    }
    // Trim trailing IDLE off the in-progress final rep before persistence —
    // matches the mobile app's `completeSet` behavior. Branch on whichever
    // ingestion path was used: `processSample` populates `_analyticsSet`,
    // direct `appendRep` populates `current.reps`. They're disjoint in
    // practice; whichever produced reps wins.
    const analyticsReps =
      this._analyticsSet === undefined ? [] : completeSet(this._analyticsSet).reps;
    const rawReps = analyticsReps.length > 0 ? analyticsReps : current.reps;
    // F14 (VMCP-01.28): when the inactivity watchdog force-closes, the
    // trailing rep in `_analyticsSet.reps` may be the just-started
    // in-progress next rep (concentric samples only, no eccentric phase,
    // ROM=0). Persisting it inflates the rep count by one and pollutes
    // vbt_summary.last_rep_v with a single-sample peak. Drop the trailing
    // rep only when (a) the caller signaled `dropTrailingInProgress` AND
    // (b) the rep is provably incomplete (eccentric phase never started).
    // Both guards are required: graceful `set.end` keeps trailing-rep data
    // intact (F7 deferral) and a legitimately complete rep N — eccentric
    // closed before the close — must not be discarded.
    //
    // The inactivity-watchdog path is the only force-close caller of
    // `dropTrailingInProgress` — watch triggers are advisory.
    const finalReps =
      opts.dropTrailingInProgress === true && isTrailingRepIncomplete(rawReps)
        ? rawReps.slice(0, -1)
        : rawReps;
    const endedAt = new Date().toISOString();
    const finalized: ActiveSet = {
      ...current,
      reps: [...finalReps],
      endedAt,
      status: reason === undefined ? 'ended' : 'partial',
      ...(reason === undefined ? {} : { partialReason: reason }),
    };
    if (this.session !== undefined && !this.session.setIds.includes(current.setId)) {
      this.session = {
        ...this.session,
        setIds: [...this.session.setIds, current.setId],
      };
    }
    this.set = undefined;
    this._analyticsSet = undefined;
    return finalized;
  }

  /**
   * Append a rep to the active set. Silently drops the rep if no set is
   * active (EC-11: stale rep after `set.end`); the tool layer also avoids
   * calling `sendResourceUpdated` in that case.
   */
  appendRep(rep: Rep): void {
    if (this.set === undefined) {
      return;
    }
    this.set = { ...this.set, reps: [...this.set.reps, rep] };
  }

  /**
   * Process a single telemetry sample through the analytics-set pipeline.
   * Workout-analytics's `addSampleToSet` owns the rep-boundary state machine
   * (eccentric→concentric starts a new rep; IDLE folds into the current
   * rep's hold time). After updating the internal analytics set, the public
   * `set.reps` is replaced with the analytics set's reps so callers always
   * see the current rep array — including the in-progress final rep.
   * Silently dropped if no set is active.
   */
  processSample(sample: WorkoutSample): void {
    if (this.set === undefined || this._analyticsSet === undefined) {
      return;
    }
    this._analyticsSet = addSampleToSet(this._analyticsSet, sample);
    this.set = { ...this.set, reps: [...this._analyticsSet.reps] };
  }

  /**
   * Capture the most recent `onInProgress` heartbeat on the active set. The
   * bridge calls this on every ~1 Hz tick before the SET_START_GRACE_MS
   * grace check so coaching reads always see the latest value, even within
   * the start-of-set grace window. Single-slot — each tick overwrites the
   * prior tick rather than accumulating. No-op when no set is active (the
   * device emits `onInProgress` continuously during workout mode, including
   * after an explicit `set.end` race; silent drop matches the bridge's
   * existing race-condition guard).
   */
  applyInProgress(payload: InProgressEvent, capturedAt: number): void {
    if (this.set === undefined) {
      return;
    }
    this.set = {
      ...this.set,
      latestInProgress: {
        peakForceTenths: payload.peakForceTenths,
        currentForceTenths: payload.currentForceTenths,
        velocityCmPerSec: payload.velocityCmPerSec,
        targetWeightTenths: payload.targetWeightTenths,
        capturedAt,
      },
    };
  }

  /**
   * Capture the most recent `onSummary` payload on the active set. The
   * device emits this once at end-of-set with the canonical rep count and
   * schema version. `consumeLatestSummary` reads-and-clears it during
   * `endSet` so the finalized set carries it forward exactly once. No-op
   * when no set is active.
   */
  applySummary(payload: SummaryEvent): void {
    if (this.set === undefined) {
      return;
    }
    this.set = {
      ...this.set,
      latestSummary: {
        repCount: payload.repCount,
        schemaVersion: payload.schemaVersion,
      },
    };
  }

  /**
   * Read-and-clear the active set's `latestSummary`. Returns the captured
   * summary (if any) and removes it from live state in the same call so
   * subsequent reads see `undefined`. Used by the finalize path to thread
   * the summary block onto the persisted set without leaving stale data
   * on the active-set object.
   *
   * Returns `undefined` when no set is active OR the active set never
   * received an `onSummary` (mid-set disconnect path).
   */
  consumeLatestSummary(): ActiveSet['latestSummary'] | undefined {
    if (this.set === undefined) {
      return undefined;
    }
    const summary = this.set.latestSummary;
    if (summary === undefined) {
      return undefined;
    }
    const next = { ...this.set };
    delete next.latestSummary;
    this.set = next;
    return summary;
  }

  /**
   * Capture the most recent `onSetSummary` payload on the active set. The
   * device emits this frame per-set in WT/RB/Damper after all reps complete;
   * the bridge calls `finalizeSet` immediately after this so consumers see
   * the rest-coaching prompt + persisted set close as one event sequence.
   *
   * `markActivity` is bumped here so the inactivity watchdog won't time
   * the set out before `finalizeSet` discards it.
   *
   * No-op when no set is active (ghost setSummary after `set.end` already
   * fired).
   */
  applySetSummary(payload: SetSummaryEvent, capturedAt: number = Date.now()): void {
    if (this.set === undefined) {
      return;
    }
    this.set = {
      ...this.set,
      lastActivityAt: capturedAt,
      latestSetSummary: {
        repCount: payload.repCount,
        repDurationMs: payload.repDurationMs,
        targetWeightTenths: payload.targetWeightTenths,
        schemaVersion: payload.schemaVersion,
      },
    };
  }

  /**
   * Read-and-clear the active set's `latestSetSummary`. Mirrors
   * `consumeLatestSummary`: returns the captured payload (if any) and
   * removes it in the same call so the finalized set carries the block
   * forward exactly once.
   */
  consumeLatestSetSummary(): ActiveSet['latestSetSummary'] | undefined {
    if (this.set === undefined) {
      return undefined;
    }
    const setSummary = this.set.latestSetSummary;
    if (setSummary === undefined) {
      return undefined;
    }
    const next = { ...this.set };
    delete next.latestSetSummary;
    this.set = next;
    return setSummary;
  }

  /**
   * Bump the active set's `lastActivityAt` marker. Called by the bridge
   * on every `onInProgress` / `onSetSummary` / WA rep boundary observed
   * during the set, so the inactivity watchdog (`SET_INACTIVITY_TIMEOUT_MS`)
   * has a fresh reference point. No-op when no set is active.
   */
  markActivity(now: number = Date.now()): void {
    if (this.set === undefined) {
      return;
    }
    this.set = { ...this.set, lastActivityAt: now };
  }

  /**
   * Mark the device as disconnected. Propagates the timestamp to the active
   * session so `voltra://session/active` reflects the drop without waiting
   * for a re-read of device state (R24). Also flags the device snapshot as
   * stale (cached pre-disconnect data) so consumers can distinguish a
   * resource read served from LiveState memory from a freshly-confirmed
   * push. Cleared by `clearStaleness` once the bridge observes a real push.
   */
  markDisconnected(at: string): void {
    this.device = { ...this.device, connected: false, disconnectedAt: at };
    this._staleSinceDisconnect = at;
    if (this.session !== undefined) {
      this.session = { ...this.session, disconnectedAt: at };
    }
  }

  /**
   * Clear the staleness flag. Called by the event-bridge on the first device
   * push after a reconnect (typically `onSettingsUpdate`) so subsequent
   * resource reads reflect freshly-confirmed values rather than the cached
   * pre-disconnect snapshot.
   */
  clearStaleness(): void {
    this._staleSinceDisconnect = undefined;
  }

  /** True when the snapshot is the last-known pre-disconnect state. */
  isStale(): boolean {
    return this._staleSinceDisconnect !== undefined;
  }

  /**
   * Return an independent copy of `device`. Includes the soft-reset
   * `staleSinceDisconnect` timestamp + `isStale` boolean when the snapshot
   * is the cached pre-disconnect state, so resource consumers can distinguish
   * cached data from freshly-confirmed pushes without inspecting LiveState
   * internals.
   */
  snapshotDevice(): DeviceSnapshot {
    const snap: DeviceSnapshot = { ...this.device };
    if (this._staleSinceDisconnect !== undefined) {
      snap.staleSinceDisconnect = this._staleSinceDisconnect;
      snap.isStale = true;
    }
    return snap;
  }

  /** Return an independent copy of the active session, or `undefined`. */
  snapshotSession(): ActiveSession | undefined {
    if (this.session === undefined) {
      return undefined;
    }
    return { ...this.session, setIds: [...this.session.setIds] };
  }

  /** Return an independent copy of the active set, or `undefined`. */
  snapshotSet(): ActiveSet | undefined {
    if (this.set === undefined) {
      return undefined;
    }
    // `firedTriggers` is intentionally NOT cloned — it's an internal dedupe
    // ledger the bridge mutates via `tryFireTrigger`. Snapshot consumers
    // (resource handlers, tools) don't read it; the snapshot still includes
    // the reference for type completeness, but mutating the returned set
    // doesn't churn the ledger because the bridge's mutator goes through the
    // helper.
    return { ...this.set, reps: [...this.set.reps] };
  }

  /**
   * Atomically check + mark a trigger as fired against the active set's
   * dedupe ledger. Returns `true` if the trigger fired now (caller should
   * publish the channel event); returns `false` if the key was already
   * present or no set is active. The dedupe key is owned by the caller —
   * the convention is `${type}:${value or pct}`.
   */
  tryFireTrigger(key: string): boolean {
    if (this.set === undefined || this.set.firedTriggers === undefined) {
      return false;
    }
    if (this.set.firedTriggers.has(key)) {
      return false;
    }
    this.set.firedTriggers.add(key);
    return true;
  }

  /**
   * Record one idle-arm rep (detected while no MCP set was armed). Appends
   * to the bounded `idleReps` ring buffer (oldest dropped at cap) and
   * increments the monotonic `idleRepCount`. `slot` identifies which device
   * slot produced the boundary. `vCon` and `rom` are extracted from the
   * just-closed rep's concentric phase; both are null when the concentric
   * phase held no movement samples.
   */
  recordIdleRep(rep: Rep, slot: string): IdleRep {
    const ts = Date.now();
    const hasConcentric = rep.concentric._movementSampleCount > 0;
    const entry: IdleRep = {
      ts,
      vCon: hasConcentric ? Number(getPhaseMeanVelocity(rep.concentric).toFixed(3)) : null,
      rom: hasConcentric ? getPhaseRangeOfMotion(rep.concentric) : null,
      slot,
    };
    this.idleRepCount += 1;
    if (this.idleReps.length >= IDLE_REP_BUFFER_CAP) {
      this.idleReps = [...this.idleReps.slice(1), entry];
    } else {
      this.idleReps = [...this.idleReps, entry];
    }
    return entry;
  }

  /**
   * Reset the idle-rep counters and ring buffer. Called by `session.start`
   * so the PT skill starts each session from a clean slate. Also clears
   * the idle analytics set so stale phase state from a prior idle window
   * does not bleed into the new session's idle window.
   */
  clearIdleReps(): void {
    this.idleRepCount = 0;
    this.idleReps = [];
    this._idleAnalyticsSet = undefined;
  }

  /**
   * Process a telemetry sample through the idle-arm analytics pipeline.
   * Only runs when no set is active (`this.set === undefined`). Returns the
   * index of the just-closed rep in the idle analytics set if a rep boundary
   * was detected (i.e. `nextRepCount > prevRepCount && nextRepCount >= 2`),
   * or `null` if no boundary fired. The caller is responsible for calling
   * `recordIdleRep` on the returned rep and publishing the channel event.
   *
   * The idle analytics set is allocated lazily on the first call and
   * discarded by `clearIdleReps()`. It is NOT discarded when an active set
   * starts — the idle pipeline pauses while the set is active and resumes
   * when the set ends (the caller gates on `this.set === undefined`).
   */
  processIdleSample(sample: WorkoutSample): Rep | null {
    if (this.set !== undefined) {
      return null;
    }
    if (this._idleAnalyticsSet === undefined) {
      this._idleAnalyticsSet = createSet();
    }
    const prevCount = this._idleAnalyticsSet.reps.length;
    this._idleAnalyticsSet = addSampleToSet(this._idleAnalyticsSet, sample);
    const nextCount = this._idleAnalyticsSet.reps.length;
    if (nextCount > prevCount && nextCount >= 2) {
      // The rep at index `nextCount - 2` just closed (same logic as the
      // active-set pipeline in event-bridge.ts).
      return this._idleAnalyticsSet.reps[nextCount - 2];
    }
    return null;
  }
}

/**
 * F14 helper: the trailing rep is "incomplete" when its eccentric phase
 * carries no samples. The analytics-set pipeline only opens a new rep on an
 * eccentric→concentric transition, so a rep with concentric-only samples is
 * always the in-progress rep mid-cycle — never a completed rep. Returns
 * false on an empty rep array so the caller short-circuits to a no-op slice.
 */
function isTrailingRepIncomplete(reps: readonly Rep[]): boolean {
  if (reps.length === 0) {
    return false;
  }
  const last = reps[reps.length - 1];
  return last.eccentric.samples.length === 0;
}
