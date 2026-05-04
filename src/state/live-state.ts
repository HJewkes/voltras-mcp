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
import type { Rep } from '@voltras/workout-analytics';

/** String form of the SDK's `TrainingMode` enum (e.g. `"WeightTraining"`). */
export type TrainingModeName = string;

/** Latest known device-level state. All fields are best-effort snapshots. */
export interface DeviceSnapshot {
  connected: boolean;
  deviceId?: string;
  deviceName?: string;
  weightLbs?: number;
  trainingMode?: TrainingModeName;
  batteryPercent?: number;
  /** ISO timestamp of the last connection drop, when one is known. */
  disconnectedAt?: string;
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
}

/** Active set with its live rep buffer. `endedAt`/`partialReason` set on close. */
export interface ActiveSet {
  setId: string;
  sessionId: string;
  startedAt: string;
  reps: Rep[];
  status: 'active' | 'ended' | 'partial';
  endedAt?: string;
  partialReason?: 'disconnect' | 'session_end';
}

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
   */
  startSet(s: ActiveSet): void {
    if (this.set !== undefined) {
      return;
    }
    this.set = { ...s, reps: [...s.reps] };
  }

  /**
   * Close out the active set. `reason` distinguishes graceful close
   * (`undefined`), explicit `session.end` cascade (`'session_end'`), and
   * connection loss (`'disconnect'`). Returns the finalized set for the
   * caller to persist, or `undefined` when none was active.
   *
   * The set's `setId` is appended to the active session's `setIds` if a
   * session is still tracked, so resource snapshots reflect the close
   * synchronously.
   */
  endSet(reason?: 'disconnect' | 'session_end'): ActiveSet | undefined {
    const current = this.set;
    if (current === undefined) {
      return undefined;
    }
    const endedAt = new Date().toISOString();
    const finalized: ActiveSet = {
      ...current,
      reps: [...current.reps],
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
   * Mark the device as disconnected. Propagates the timestamp to the active
   * session so `voltra://session/active` reflects the drop without waiting
   * for a re-read of device state (R24).
   */
  markDisconnected(at: string): void {
    this.device = { ...this.device, connected: false, disconnectedAt: at };
    if (this.session !== undefined) {
      this.session = { ...this.session, disconnectedAt: at };
    }
  }

  /** Return an independent copy of `device`. */
  snapshotDevice(): DeviceSnapshot {
    return { ...this.device };
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
    return { ...this.set, reps: [...this.set.reps] };
  }
}
