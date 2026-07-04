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
import {
  estimateSetRIR,
  getRepPeakVelocity,
  getSetVelocityLossPct,
  type Rep,
} from '@voltras/workout-analytics';

/** mm/s → m/s divisor (WA velocities arrive in mm/s; see legacy fmtVelocity). */
const MMS_PER_MPS = 1000;
/** tenths-of-a-pound → pounds divisor (targetWeightTenths). */
const TENTHS_PER_LB = 10;
/** Battery percent below which the indicator flips to its warning state. */
export const LOW_BATTERY_PCT = 20;

/** Client-side view of a single device entry in the snapshot. */
export interface SnapshotDevice {
  connected?: boolean;
  weightLbs?: number;
  trainingMode?: string;
  batteryPercent?: number;
  /** ISO timestamp of the last connection drop (DeviceSnapshot.disconnectedAt). */
  disconnectedAt?: string;
  /** ISO timestamp set while the snapshot is cached pre-disconnect state. */
  staleSinceDisconnect?: string;
  /** Convenience mirror of `staleSinceDisconnect !== undefined`. */
  isStale?: boolean;
}

/** One advisory trigger from the active set's `watch.notifyOn[]` config. */
export interface SnapshotWatchTrigger {
  type: string;
  /** Populated for `rep_count_reached`. */
  value?: number;
  /** Populated for `velocity_loss_exceeded`. */
  pct?: number;
}

/** Client-side view of the active set in the snapshot. */
export interface SnapshotActiveSet {
  reps?: Rep[];
  latestInProgress?: { targetWeightTenths?: number };
  /** Trigger DSL registered at set.start — carries the configured rep target. */
  watch?: { notifyOn?: SnapshotWatchTrigger[] };
}

/**
 * The active session's target muscle groups (raw voltras catalog strings, e.g.
 * `'chest'`, `'shoulders'`), joined server-side from the exercise catalog. Drives
 * the BodyMap heatmap (VMCP-01.47). Plain fitness metadata — no protocol data.
 */
export interface SnapshotActiveExercise {
  primaryMuscles: string[];
  secondaryMuscles: string[];
}

/** Client-side view of the `/api/snapshot` JSON shape (server: buildSnapshot). */
export interface Snapshot {
  session: { sessionId: string; exerciseName?: string } | null;
  devices: Array<{ slotId: string; device: SnapshotDevice }>;
  sets: { active: SnapshotActiveSet | null };
  /** Target muscles for the active exercise; null when idle / unknown. */
  activeExercise?: SnapshotActiveExercise | null;
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

/**
 * Estimated RPE (10 − RIR) for a set, via WA `estimateSetRIR` (velocity-loss
 * based, never hand-rolled). Needs at least two reps carrying real concentric
 * movement samples; under two reps, or when WA can't derive a finite RIR (e.g.
 * reps with no samples), we return null so titan SetRow renders its em-dash
 * rather than a misleading value. Rounded to the nearest 0.5 — RPE's
 * conventional granularity, which also aligns with titan's RPE color bands.
 */
function deriveRpe(reps: Rep[]): number | null {
  if (reps.length < 2) return null;
  // RPE is a velocity-loss estimate, so only surface it when velocity loss is
  // itself derivable — the same gate the live-status strip uses. Without real
  // concentric samples `estimateSetRIR` returns a misleading floor (RPE 10)
  // rather than signalling "unknown"; treat that as inestimable.
  if (!Number.isFinite(getSetVelocityLossPct({ reps }))) return null;
  const { rpe } = estimateSetRIR({ reps });
  if (!Number.isFinite(rpe)) return null;
  return Math.round(rpe * 2) / 2;
}

// ── Current-set view model ───────────────────────────────────────────────────

export interface CurrentSetView {
  active: boolean;
  weight: string;
  mode: string;
  reps: number;
  /** Configured rep target (`rep_count_reached` trigger value), or null. */
  repTarget: number | null;
  /** `"3 of 8 reps"` when a target is configured, else `"3 reps"`. */
  repsLabel: string;
  /** Live set velocity-loss %, via WA `getSetVelocityLossPct`. `"—"` if <2 reps. */
  velocityLoss: string;
  latestPeakVelocity: string;
  targetWeight: string;
  /** Per-rep peak velocities in m/s, ordered by rep, for the VelocityStrip. */
  velocitiesMps: number[];
}

function firstDevice(snapshot: Snapshot): SnapshotDevice | null {
  return snapshot.devices[0]?.device ?? null;
}

/** Read the configured rep target from the set's `watch.notifyOn` triggers. */
function resolveRepTarget(set: SnapshotActiveSet): number | null {
  const triggers = set.watch?.notifyOn;
  if (!Array.isArray(triggers)) return null;
  for (const t of triggers) {
    if (t.type === 'rep_count_reached' && typeof t.value === 'number') return t.value;
  }
  return null;
}

/** `"3 of 8 reps"` / `"3 reps"` / `"1 rep"`. */
function fmtRepsLabel(count: number, target: number | null): string {
  if (target != null) return `${count} of ${target} reps`;
  return `${count} ${count === 1 ? 'rep' : 'reps'}`;
}

/**
 * Live set velocity-loss %, routed through WA `getSetVelocityLossPct` (never
 * hand-rolled). WA needs at least two reps with real concentric-phase samples;
 * under two reps, or when WA can't derive a finite mean (e.g. reps carrying no
 * movement samples), we render the em-dash placeholder rather than `0%`.
 */
function fmtVelocityLoss(reps: Rep[]): string {
  if (reps.length < 2) return '—';
  const pct = getSetVelocityLossPct({ reps });
  if (!Number.isFinite(pct)) return '—';
  return `${Math.round(pct)}%`;
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
      repTarget: null,
      repsLabel: '—',
      velocityLoss: '—',
      latestPeakVelocity: '—',
      targetWeight: '—',
      velocitiesMps: [],
    };
  }
  const device = firstDevice(snapshot);
  const reps = Array.isArray(set.reps) ? set.reps : [];
  const latest = reps.length > 0 ? reps[reps.length - 1] : null;
  const targetTenths = set.latestInProgress?.targetWeightTenths;
  const repTarget = resolveRepTarget(set);

  const velocitiesMps: number[] = [];
  for (const rep of reps) {
    velocitiesMps.push(toMps(repPeakMms(rep)) ?? 0);
  }

  return {
    active: true,
    weight: fmtWeight(resolveWeightLbs(device, set)),
    mode: fmtMode(device?.trainingMode),
    reps: reps.length,
    repTarget,
    repsLabel: fmtRepsLabel(reps.length, repTarget),
    velocityLoss: fmtVelocityLoss(reps),
    latestPeakVelocity: fmtVelocity(latest ? repPeakMms(latest) : null),
    targetWeight: targetTenths != null ? fmtWeight(targetTenths / TENTHS_PER_LB) : '—',
    velocitiesMps,
  };
}

// ── Connection status + battery (safety-case header) ─────────────────────────

export type ConnectionTone = 'success' | 'warning' | 'error';

/**
 * Header connection state, derived from the ACTUAL device snapshot rather than
 * only whether the HTTP poll succeeded. This is the "hands on the machine, eyes
 * across the room" safety surface: a green dot must mean the cable is live, not
 * merely that the sidecar answered.
 */
export interface ConnectionStatus {
  tone: ConnectionTone;
  /** Short text label (accessibility — color alone is insufficient). */
  label: string;
  connected: boolean;
  /** ISO disconnect time to surface in the safety banner, when known. */
  disconnectedAt: string | null;
  /** Render the visible disconnect banner. */
  showBanner: boolean;
}

/**
 * Fold the device snapshot + HTTP poll status into one header state.
 * Priority: sidecar-unreachable → device-offline → device-stale → poll-lag →
 * awaiting-first-connect → live.
 */
export function buildConnectionStatus(
  snapshot: Snapshot,
  pollStatus: 'ok' | 'stale' | 'error',
): ConnectionStatus {
  const device = firstDevice(snapshot);
  // Sidecar unreachable — we cannot vouch for device state at all.
  if (pollStatus === 'error') {
    return {
      tone: 'error',
      label: 'NO SIGNAL',
      connected: false,
      disconnectedAt: device?.disconnectedAt ?? null,
      showBanner: true,
    };
  }
  if (device && device.connected === false) {
    return {
      tone: 'error',
      label: 'OFFLINE',
      connected: false,
      disconnectedAt: device.disconnectedAt ?? device.staleSinceDisconnect ?? null,
      showBanner: true,
    };
  }
  if (device && device.staleSinceDisconnect != null) {
    return {
      tone: 'warning',
      label: 'STALE',
      connected: false,
      disconnectedAt: device.disconnectedAt ?? device.staleSinceDisconnect,
      showBanner: false,
    };
  }
  if (pollStatus === 'stale') {
    return {
      tone: 'warning',
      label: 'STALE',
      connected: Boolean(device?.connected),
      disconnectedAt: null,
      showBanner: false,
    };
  }
  if (!device) {
    return {
      tone: 'warning',
      label: 'WAITING',
      connected: false,
      disconnectedAt: null,
      showBanner: false,
    };
  }
  return {
    tone: 'success',
    label: 'LIVE',
    connected: true,
    disconnectedAt: null,
    showBanner: false,
  };
}

export interface BatteryView {
  present: boolean;
  pct: number | null;
  /** `"82%"` or the em-dash placeholder. */
  label: string;
  /** True when below {@link LOW_BATTERY_PCT} — drives the warning color. */
  low: boolean;
}

/** Battery indicator view from `device.batteryPercent`. */
export function buildBattery(snapshot: Snapshot): BatteryView {
  const pct = firstDevice(snapshot)?.batteryPercent;
  if (pct == null || !Number.isFinite(pct)) {
    return { present: false, pct: null, label: '—', low: false };
  }
  return { present: true, pct, label: `${Math.round(pct)}%`, low: pct < LOW_BATTERY_PCT };
}

/** Format an ISO timestamp as a local `HH:MM:SS` clock, or `"—"`. */
export function fmtDisconnectClock(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ── Completed-set accumulator (mirrors legacy updateSetLog/updateRestState) ───

export interface CompletedSet {
  weightLbs: number | null;
  mode: string | null;
  repCount: number;
  /** Best (max) per-rep peak concentric velocity for the set, in mm/s. */
  bestPeakVelocityMms: number | null;
  /** Per-rep peak concentric velocities in m/s (ordered), for titan SetRow's
      per-row VelocityStrip. Empty when reps carry no movement samples. */
  velocitiesMps: number[];
  /**
   * Full WA `Rep[]` retained at set-close (source of truth). The reps are
   * already in `SnapshotActiveSet.reps` before the set closes, so retaining
   * them costs no backend/wire change and lets the hero derive RPE (and, later,
   * velocity-history / tempo) that the scalar summary fields structurally
   * cannot. The convenience fields above are precomputed from this array.
   */
  reps: Rep[];
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
  const velocitiesMps: number[] = [];
  for (const rep of reps) {
    const v = repPeakMms(rep);
    if (v != null && (bestPeak === null || v > bestPeak)) bestPeak = v;
    const mps = toMps(v);
    if (mps != null) velocitiesMps.push(mps);
  }
  const weightLbs = resolveWeightLbs(device, set);
  return {
    weightLbs,
    mode: device?.trainingMode ?? null,
    repCount: reps.length,
    bestPeakVelocityMms: bestPeak,
    velocitiesMps,
    reps: [...reps],
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

// ── Hero set rows (titan SetRow shape) ───────────────────────────────────────

/**
 * Numeric, framework-free row model for the exercise hero's nested set list —
 * one entry per completed set plus the active set, in ascending timeline order
 * (mirrors the mobile app's SetLog). The panel maps this onto titan `SetRow`
 * props. Peak velocity is carried as the per-rep m/s array so titan renders its
 * built-in per-row VelocityStrip (rather than a bespoke Peak column); Mode is a
 * per-set constant surfaced at the hero header, not per row; RPE is derived from
 * the retained WA `Rep[]` via velocity-loss (`deriveRpe`), or null (em-dash)
 * when the set has too few reps / no movement samples to estimate it.
 */
export interface HeroSetRow {
  setNumber: number;
  mode: 'completed' | 'active';
  /** Completed rep count; active in-progress count (null until the first rep). */
  reps: number | null;
  weightLbs: number | null;
  /** Active-set targets (from the rep-count trigger + working weight). */
  targetReps: number | null;
  targetWeightLbs: number | null;
  /** Per-rep peak velocities (m/s) for the row's VelocityStrip. */
  velocitiesMps: number[];
  /** Estimated RPE (10 − RIR, nearest 0.5), or null when inestimable. */
  rpe: number | null;
  /** Prior set's performance, for titan SetRow's PREV column. */
  previous: { reps: number; weightLbs: number } | null;
}

function priorPerformance(setLog: CompletedSet[], i: number): HeroSetRow['previous'] {
  const prev = i > 0 ? setLog[i - 1] : null;
  return prev && prev.weightLbs != null ? { reps: prev.repCount, weightLbs: prev.weightLbs } : null;
}

/** Completed sets + the active set as titan-SetRow-ready numeric rows. */
export function buildHeroSets(snapshot: Snapshot, setLog: CompletedSet[]): HeroSetRow[] {
  const rows: HeroSetRow[] = setLog.map((s, i) => ({
    setNumber: i + 1,
    mode: 'completed' as const,
    reps: s.repCount,
    weightLbs: s.weightLbs,
    targetReps: null,
    targetWeightLbs: null,
    velocitiesMps: s.velocitiesMps,
    rpe: deriveRpe(s.reps),
    previous: priorPerformance(setLog, i),
  }));

  const active = snapshot.sets.active;
  if (active) {
    const device = firstDevice(snapshot);
    const reps = Array.isArray(active.reps) ? active.reps : [];
    const weightLbs = resolveWeightLbs(device, active);
    rows.push({
      setNumber: setLog.length + 1,
      mode: 'active',
      reps: reps.length > 0 ? reps.length : null,
      weightLbs,
      targetReps: resolveRepTarget(active),
      targetWeightLbs: weightLbs,
      velocitiesMps: reps.map((r) => toMps(repPeakMms(r)) ?? 0),
      rpe: deriveRpe(reps),
      previous: priorPerformance(setLog, setLog.length),
    });
  }
  return rows;
}
