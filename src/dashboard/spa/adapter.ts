/**
 * Snapshot → panel-props adapter for the Phase 1 dashboard SPA (VMCP-01.45).
 *
 * Pure, framework-free logic: the client-side view of the `/api/snapshot` JSON,
 * unit/format helpers, and the completed-set accumulator that mirrors the legacy
 * `dashboard-html.ts` `updateSetLog` / `updateRestState` state machine exactly.
 *
 * NDA: this module only reads `/api/snapshot` JSON — no protocol bytes, frames,
 * or command codes cross this boundary.
 *
 * Velocity math is routed through `@voltras/workout-analytics`
 * (`getRepPeakVelocity`) rather than hand-reading `rep.concentric.peakVelocity`.
 * WA peak velocities are millimetres/second; divide by 1000 for m/s (matches the
 * legacy dashboard's `fmtVelocity`).
 */
import { getRepPeakVelocity, type Rep } from '@voltras/workout-analytics';

/** mm/s → m/s divisor (WA velocities arrive in mm/s; see legacy fmtVelocity). */
const MMS_PER_MPS = 1000;
/** tenths-of-a-pound → pounds divisor (targetWeightTenths). */
const TENTHS_PER_LB = 10;

/** Client-side view of a single device entry in the snapshot. */
export interface SnapshotDevice {
  connected?: boolean;
  weightLbs?: number;
  trainingMode?: string;
  batteryPercent?: number;
}

/** Client-side view of the active set in the snapshot. */
export interface SnapshotActiveSet {
  reps?: Rep[];
  latestInProgress?: { targetWeightTenths?: number };
}

/** Client-side view of the `/api/snapshot` JSON shape (server: buildSnapshot). */
export interface Snapshot {
  session: { sessionId: string; exerciseName?: string } | null;
  devices: Array<{ slotId: string; device: SnapshotDevice }>;
  sets: { active: SnapshotActiveSet | null };
}

// ── Formatters (mirror legacy dashboard-html.ts) ─────────────────────────────

/** Format a mm/s velocity as `"0.74 m/s"`, or the em-dash placeholder. */
export function fmtVelocity(mmPerSec: number | null | undefined): string {
  if (mmPerSec == null || !Number.isFinite(mmPerSec)) return '—';
  return `${(mmPerSec / MMS_PER_MPS).toFixed(2)} m/s`;
}

/** Convert a mm/s velocity to m/s (2-dp) as a number for chart props. */
export function toMps(mmPerSec: number | null | undefined): number | null {
  if (mmPerSec == null || !Number.isFinite(mmPerSec)) return null;
  return Number((mmPerSec / MMS_PER_MPS).toFixed(2));
}

/** Format a pounds value as `"135.0 lbs"`, or the em-dash placeholder. */
export function fmtWeight(lbs: number | null | undefined): string {
  if (lbs == null || !Number.isFinite(lbs)) return '—';
  return `${lbs.toFixed(1)} lbs`;
}

/** camelCase / PascalCase training mode → spaced words (`weightTraining`→`weight Training`). */
export function fmtMode(mode: string | null | undefined): string {
  if (mode == null) return '—';
  return mode.replace(/([A-Z])/g, ' $1').trim();
}

/** Elapsed milliseconds → `M:SS`. */
export function fmtElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

/** Peak concentric velocity (mm/s) for a rep, via WA. Null if unavailable. */
function repPeakMms(rep: Rep): number | null {
  const v = getRepPeakVelocity(rep);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ── Current-set view model ───────────────────────────────────────────────────

export interface CurrentSetView {
  active: boolean;
  weight: string;
  mode: string;
  reps: number;
  latestPeakVelocity: string;
  targetWeight: string;
  /** Per-rep peak velocities in m/s, ordered by rep, for the VelocityStrip. */
  velocitiesMps: number[];
}

function firstDevice(snapshot: Snapshot): SnapshotDevice | null {
  return snapshot.devices[0]?.device ?? null;
}

/** Weight precedence: live device weight, else the in-progress target (tenths/10). */
function resolveWeightLbs(device: SnapshotDevice | null, set: SnapshotActiveSet): number | null {
  if (device?.weightLbs != null) return device.weightLbs;
  const tenths = set.latestInProgress?.targetWeightTenths;
  return tenths != null ? tenths / TENTHS_PER_LB : null;
}

export function buildCurrentSet(snapshot: Snapshot): CurrentSetView {
  const set = snapshot.sets.active;
  if (!set) {
    return {
      active: false,
      weight: '—',
      mode: '—',
      reps: 0,
      latestPeakVelocity: '—',
      targetWeight: '—',
      velocitiesMps: [],
    };
  }
  const device = firstDevice(snapshot);
  const reps = Array.isArray(set.reps) ? set.reps : [];
  const latest = reps.length > 0 ? reps[reps.length - 1] : null;
  const targetTenths = set.latestInProgress?.targetWeightTenths;

  const velocitiesMps: number[] = [];
  for (const rep of reps) {
    velocitiesMps.push(toMps(repPeakMms(rep)) ?? 0);
  }

  return {
    active: true,
    weight: fmtWeight(resolveWeightLbs(device, set)),
    mode: fmtMode(device?.trainingMode),
    reps: reps.length,
    latestPeakVelocity: fmtVelocity(latest ? repPeakMms(latest) : null),
    targetWeight: targetTenths != null ? fmtWeight(targetTenths / TENTHS_PER_LB) : '—',
    velocitiesMps,
  };
}

// ── Completed-set accumulator (mirrors legacy updateSetLog/updateRestState) ───

export interface CompletedSet {
  weightLbs: number | null;
  mode: string | null;
  repCount: number;
  /** Best (max) per-rep peak concentric velocity for the set, in mm/s. */
  bestPeakVelocityMms: number | null;
}

export interface AccumulatorState {
  /** Whether a set was active at the previous tick. */
  prevSetActive: boolean;
  /** Active-set snapshot saved at the previous tick (read when the set closes). */
  lastActiveSet: SnapshotActiveSet | null;
  /** Device snapshot saved at the same tick as `lastActiveSet`. */
  lastActiveDevice: SnapshotDevice | null;
  /** Session id seen at the previous tick — detects session change. */
  lastSessionId: string | null;
  /** Completed sets accumulated during the current session. */
  setLog: CompletedSet[];
  /** Unix-ms when the current rest period began (last set ended); null if none. */
  restStartMs: number | null;
}

export function initialAccumulatorState(): AccumulatorState {
  return {
    prevSetActive: false,
    lastActiveSet: null,
    lastActiveDevice: null,
    lastSessionId: null,
    setLog: [],
    restStartMs: null,
  };
}

function summariseClosedSet(set: SnapshotActiveSet, device: SnapshotDevice | null): CompletedSet {
  const reps = Array.isArray(set.reps) ? set.reps : [];
  let bestPeak: number | null = null;
  for (const rep of reps) {
    const v = repPeakMms(rep);
    if (v != null && (bestPeak === null || v > bestPeak)) bestPeak = v;
  }
  const weightLbs = resolveWeightLbs(device, set);
  return {
    weightLbs,
    mode: device?.trainingMode ?? null,
    repCount: reps.length,
    bestPeakVelocityMms: bestPeak,
  };
}

/**
 * Fold a new snapshot into the accumulator. Pure: returns the next state.
 * Order matches the legacy poll loop — set-log accrual (reads the previous
 * tick's active/device snapshots) then rest-state transition — so a set that
 * closes between two ticks is logged with the weight/mode captured at the tick
 * it was still open.
 */
export function reduceSnapshot(
  state: AccumulatorState,
  snapshot: Snapshot,
  nowMs: number,
): AccumulatorState {
  const sessionId = snapshot.session?.sessionId ?? null;
  const activeSet = snapshot.sets.active;
  const device = firstDevice(snapshot);

  let setLog = state.setLog;
  let lastSessionId = state.lastSessionId;

  // Session changed (or ended) — clear the log.
  if (sessionId !== lastSessionId) {
    setLog = [];
    lastSessionId = sessionId;
  }

  // Set just closed: push the snapshot saved at the previous tick.
  if (state.prevSetActive && !activeSet && state.lastActiveSet !== null) {
    setLog = [...setLog, summariseClosedSet(state.lastActiveSet, state.lastActiveDevice)];
  }

  // Save this tick's active-set + device snapshots together for next-tick close.
  const lastActiveSet = activeSet ? activeSet : null;
  const lastActiveDevice = activeSet ? device : null;

  // Rest-timer transitions.
  const setIsActive = !!activeSet;
  let restStartMs = state.restStartMs;
  if (state.prevSetActive && !setIsActive) restStartMs = nowMs;
  if (!state.prevSetActive && setIsActive && restStartMs !== null) restStartMs = null;

  return {
    prevSetActive: setIsActive,
    lastActiveSet,
    lastActiveDevice,
    lastSessionId,
    setLog,
    restStartMs,
  };
}

// ── Session-progress view model ──────────────────────────────────────────────

export interface SessionProgressView {
  active: boolean;
  exercise: string;
  sets: number;
  totalReps: number;
  totalVolume: number;
}

/**
 * Session totals from the completed-set log. Only closed sets count — in-flight
 * reps stay excluded so the numbers are stable until a set closes (legacy
 * parity). Volume is a plain load×reps sum; WA `computeVolume` needs full VBT
 * `Set` models the snapshot accumulator doesn't carry.
 */
export function buildSessionProgress(
  snapshot: Snapshot,
  setLog: CompletedSet[],
): SessionProgressView {
  const session = snapshot.session;
  if (!session) {
    return { active: false, exercise: '—', sets: 0, totalReps: 0, totalVolume: 0 };
  }
  let totalReps = 0;
  let totalVolume = 0;
  for (const entry of setLog) {
    totalReps += entry.repCount;
    totalVolume += (entry.weightLbs ?? 0) * entry.repCount;
  }
  return {
    active: true,
    exercise: session.exerciseName || '—',
    sets: setLog.length,
    totalReps,
    totalVolume,
  };
}

/** Set-log table row (formatted) for the SetLogPanel. */
export interface SetLogRow {
  index: number;
  weight: string;
  mode: string;
  reps: number;
  peakVelocity: string;
}

export function buildSetLogRows(setLog: CompletedSet[]): SetLogRow[] {
  return setLog.map((entry, i) => ({
    index: i + 1,
    weight: fmtWeight(entry.weightLbs),
    mode: fmtMode(entry.mode),
    reps: entry.repCount,
    peakVelocity: fmtVelocity(entry.bestPeakVelocityMms),
  }));
}
