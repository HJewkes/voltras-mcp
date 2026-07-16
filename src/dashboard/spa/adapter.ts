/**
 * Snapshot → panel-props adapter for the Phase 1 dashboard SPA (VMCP-01.45).
 *
 * Pure, framework-free logic: the client-side view of the `/api/snapshot` JSON,
 * unit/format helpers, and the completed-set accumulator that mirrors the legacy
 * `dashboard-html.ts` `updateSetLog` / `updateRestState` state machine exactly.
 *
 * Confidentiality: this module only reads `/api/snapshot` JSON — no protocol bytes, frames,
 * or command codes cross this boundary.
 *
 * Velocity math is routed through `@voltras/workout-analytics`
 * (`getRepPeakVelocity` / `getRepMeanVelocity`) rather than hand-reading
 * `rep.concentric`. WA velocities are millimetres/second; divide by 1000 for m/s
 * (matches the legacy dashboard's `fmtVelocity`).
 */
import {
  getRepMeanVelocity,
  getRepPeakVelocity,
  getSetVelocityLossPct,
  type Rep,
} from '@voltras/workout-analytics';
// Type-only: erased at build, so this adds no titan runtime dependency to this
// otherwise WA-only pure module (safe under the node/vitest test env — no import
// is emitted). These are the shell TopBar's device/state contracts.
import type { Device, DeviceRowState, SessionState } from '@titan-design/react-ui';

/**
 * mm/s → m/s divisor. The device pipeline records velocities in mm/s; converting
 * to the m/s the UI reasons in is a data-source concern the app owns (WA stays
 * unit-agnostic; the design system rounds for display).
 */
export const MMS_PER_MPS = 1000;

/** Peak concentric velocity (mm/s) for a rep, via WA. Null when unavailable. */
export function repPeakMms(rep: Rep): number | null {
  const v = getRepPeakVelocity(rep);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Mean concentric velocity (MCV, mm/s) for a rep, via WA. Null when unavailable.
 *
 * MCV is the VBT decision metric: the velocity-loss %, FatigueMeter, and
 * StatusPill verdict all derive from per-rep MCV (`getSetVelocityLossPct`
 * folds `getRepMeanVelocity` over the first/last rep). The live VelocityStrip
 * bars use this — not {@link repPeakMms} — so the visible bar-to-bar drop is the
 * same quantity as the stated loss %/verdict shown beside it (VW-58).
 */
export function repMeanMms(rep: Rep): number | null {
  const v = getRepMeanVelocity(rep);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Peak CONCENTRIC force (lbs) for a rep. Null when the rep logged no concentric
 * force (empty phase → `peakForce` defaults to 0).
 *
 * Reads `rep.concentric.peakForce` directly rather than WA's `getRepPeakForce`,
 * which returns `max(concentric, eccentric)` — the recap tile is a concentric
 * (lifting) verdict, so folding in eccentric peaks would overstate it. WA force
 * samples are already lbs (`WorkoutSample.force`), so no conversion is needed.
 */
export function repPeakConcentricForceLbs(rep: Rep): number | null {
  const f = rep.concentric.peakForce;
  return typeof f === 'number' && Number.isFinite(f) && f > 0 ? f : null;
}

/** Convert a mm/s velocity to m/s (2-dp) as a number for chart props. */
export function toMps(mmPerSec: number | null | undefined): number | null {
  if (mmPerSec == null || !Number.isFinite(mmPerSec)) return null;
  return Number((mmPerSec / MMS_PER_MPS).toFixed(2));
}

/**
 * Canonical, surface-agnostic view of one set in the hero timeline. Carries the
 * raw WA `Rep[]` as the source of truth; the panel derives RPE / per-rep velocity
 * from it via WA so every consumer gets identical numbers. Plan context
 * (`targetReps` / `targetWeightLbs` / `previous`) is composed app-side — it comes
 * from the session/plan layer, not from WA analytics.
 */
export interface WorkoutSetView {
  setNumber: number;
  /** `'completed'` = a closed set; `'active'` = the in-progress set. */
  kind: 'completed' | 'active';
  /** Full WA reps (source of truth) — RPE / velocity derive from these. */
  reps: readonly Rep[];
  weightLbs: number | null;
  /** Active-set targets (rep-count trigger + working weight); null for completed. */
  targetReps: number | null;
  targetWeightLbs: number | null;
  /** Prior set's performance, for titan SetRow's PREV column. */
  previous: { reps: number; weightLbs: number } | null;
}

/**
 * One entry in the session's ordered planned-exercise list (VW-49). Mirrors the
 * server's `PlannedExerciseView` — the two must stay identical (see server.ts).
 */
export interface PlannedExerciseView {
  /** Display name, or the exercise id when the catalog carries no name. Never invented. */
  name: string;
  /** 0-based position within the workout template. */
  order: number;
  /** Prescribed set count. */
  sets: number;
  repsLow?: number;
  repsHigh?: number;
  weightLbs?: number;
  /** True for the exercise the live session is currently on. */
  active: boolean;
}

/** Prescribed targets for the active exercise, matching `/api/session-plan`. */
export interface PrescriptionView {
  /** Prescribed set count. Always present — `targetSets` is required on a planned exercise. */
  sets: number;
  repsLow?: number;
  repsHigh?: number;
  weightLbs?: number;
  rpe?: number;
  /** Prescribed rest between sets, seconds. Absent when the coach left it unset. */
  restSec?: number;
  /**
   * Target tempo tuple `[eccentric, pauseBottom, concentric, pauseTop]` (seconds),
   * resolved from the coach override (none yet) or the exercise default. Absent when
   * neither resolves — the live view then hides the tempo readout (VW-41).
   */
  tempo?: [number, number, number, number];
  /**
   * The session's FULL ordered planned-exercise list (VW-49), present only when a
   * template attachment resolves — the same condition that produces the prescription
   * itself. Lets the rail render `upcoming` rows beyond the active exercise. Absent
   * when the session carries no plan.
   */
  exercises?: PlannedExerciseView[];
}

/** tenths-of-a-pound → pounds divisor (targetWeightTenths). */
const TENTHS_PER_LB = 10;
/** Battery percent below which the indicator flips to its warning state. */
export const LOW_BATTERY_PCT = 20;

/** Client-side view of a single device entry in the snapshot. */
export interface SnapshotDevice {
  connected?: boolean;
  /** Last-known BLE device id (e.g. `"V-097082"`; DeviceSnapshot.deviceId). */
  deviceId?: string;
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

/**
 * One finished set as the server ships it (VW-70): the finalized set plus the
 * device snapshot captured at close. The client runs {@link summariseClosedSet}
 * over these — the same derivation the live accumulator used — so the rail /
 * recap / totals are identical whether reconstructed live or read back durably.
 */
export interface SnapshotCompletedSet {
  set: SnapshotActiveSet;
  device: SnapshotDevice | null;
}

/** Client-side view of the `/api/snapshot` JSON shape (server: buildSnapshot). */
export interface Snapshot {
  session: { sessionId: string; exerciseName?: string } | null;
  devices: Array<{ slotId: string; device: SnapshotDevice }>;
  /**
   * `active` is the in-progress set; `completed` is the current session's
   * finished sets, oldest-first (VW-70). `completed` is optional so hand-built
   * test snapshots and older servers fall back to the legacy client-side
   * active→null accumulator.
   */
  sets: { active: SnapshotActiveSet | null; completed?: SnapshotCompletedSet[] };
  /** Target muscles for the active exercise; null when idle / unknown. */
  activeExercise?: SnapshotActiveExercise | null;
  /**
   * Monotonic server send-order stamp (VMCP-03.04). Present on both the poll
   * response and the `snapshot` SSE push; the store applies a snapshot only when
   * its `rev` is strictly newer, so the fast push and slow poll can't clobber
   * each other. Absent on hand-built/empty snapshots (treated as always-apply).
   */
  rev?: number;
}

// ── Formatters (mirror legacy dashboard-html.ts) ─────────────────────────────

/** Format a mm/s velocity as `"0.74 m/s"`, or the em-dash placeholder. */
export function fmtVelocity(mmPerSec: number | null | undefined): string {
  if (mmPerSec == null || !Number.isFinite(mmPerSec)) return '—';
  return `${(mmPerSec / MMS_PER_MPS).toFixed(2)} m/s`;
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
  /** Numeric sibling of {@link velocityLoss}: raw loss %, or null when unshown. */
  velocityLossPct: number | null;
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
/**
 * Raw live velocity-loss %, or null when WA can't derive one (<2 reps, or reps
 * without finite concentric samples). The numeric source shared by the display
 * string and the auto-reg visuals (StatusPill / FatigueMeter / LiveAuraFrame),
 * so needle, verdict, and text always agree.
 */
function computeVelocityLossPct(reps: Rep[]): number | null {
  if (reps.length < 2) return null;
  const pct = getSetVelocityLossPct({ reps });
  return Number.isFinite(pct) ? pct : null;
}

function fmtVelocityLoss(reps: Rep[]): string {
  const pct = computeVelocityLossPct(reps);
  return pct === null ? '—' : `${Math.round(pct)}%`;
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
      velocityLossPct: null,
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

  // MEAN concentric velocity per rep (not peak): the VelocityStrip bars must
  // read the same metric as the velocity-loss %/FatigueMeter/StatusPill rendered
  // beside them, so the visible bar-drop and the stated loss %/verdict agree
  // across the room (VW-58).
  const velocitiesMps: number[] = [];
  for (const rep of reps) {
    velocitiesMps.push(toMps(repMeanMms(rep)) ?? 0);
  }

  return {
    active: true,
    weight: fmtWeight(resolveWeightLbs(device, set)),
    mode: fmtMode(device?.trainingMode),
    reps: reps.length,
    repTarget,
    repsLabel: fmtRepsLabel(reps.length, repTarget),
    velocityLoss: fmtVelocityLoss(reps),
    velocityLossPct: computeVelocityLossPct(reps),
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

// ── Shell TopBar mappers (real connection + session state) ───────────────────

/** Slot id → titan device side. Single-device (`'primary'`) is bound to no side. */
function slotSide(slotId: string): 'L' | 'R' | null {
  if (slotId === 'left') return 'L';
  if (slotId === 'right') return 'R';
  return null;
}

/**
 * A truthful device label for the TopBar dropdown. We hold no user-assigned
 * nickname in the snapshot, so we surface what IS real: the bound side for a
 * left/right slot, else the BLE device id, else a bare "Voltra" — never an
 * invented cable name.
 */
function slotNickname(slotId: string, deviceId: string | undefined): string {
  if (slotId === 'left') return 'Left';
  if (slotId === 'right') return 'Right';
  return deviceId ?? 'Voltra';
}

/**
 * Fold one device's snapshot + the HTTP poll status into a titan connection
 * state. Priority mirrors {@link buildConnectionStatus}: sidecar-unreachable →
 * device-offline → stale/degraded → live. A green dot must mean the cable is
 * actually live, not merely that the sidecar last answered.
 */
function deviceConnState(
  device: SnapshotDevice,
  pollStatus: 'ok' | 'stale' | 'error',
): DeviceRowState {
  // Sidecar unreachable — we can't vouch for device state at all.
  if (pollStatus === 'error') return 'lost';
  if (device.connected === false) return 'lost';
  if (device.staleSinceDisconnect != null || device.isStale) return 'degraded';
  if (pollStatus === 'stale') return device.connected ? 'degraded' : 'lost';
  return device.connected ? 'connected' : 'available';
}

/**
 * The connected Voltra(s) as titan {@link Device}s for the shell TopBar's
 * connection glyph + dropdown — sourced from the REAL device snapshot (slot
 * binding + BLE id + connection flag), never a fixture.
 */
export function buildTopBarDevices(
  snapshot: Snapshot,
  pollStatus: 'ok' | 'stale' | 'error',
): Device[] {
  return snapshot.devices.map(({ slotId, device }) => ({
    id: device.deviceId ?? slotId,
    nickname: slotNickname(slotId, device.deviceId),
    slot: slotSide(slotId),
    state: deviceConnState(device, pollStatus),
  }));
}

/**
 * Global session state for the shell TopBar status pill: an in-progress set →
 * `live`, a session between sets → `rest`, no session → `idle`. Mirrors the
 * live page's own live/rest split so the pill and the stage never disagree.
 */
export function buildSessionState(snapshot: Snapshot): SessionState {
  if (!snapshot.session) return 'idle';
  return snapshot.sets.active ? 'live' : 'rest';
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
  /**
   * The exercise this set belongs to (`snapshot.session.exerciseName` captured at
   * set-close), so consumers can split a multi-exercise log: the active-exercise rail
   * row counts only its own sets while the session rollup sums all (VW-50 / VW-52).
   * Null when the snapshot carried no exercise name at close.
   */
  exerciseName: string | null;
  /** Best (max) per-rep peak concentric velocity for the set, in mm/s. */
  bestPeakVelocityMms: number | null;
  /**
   * Best (max) per-rep peak CONCENTRIC force for the set, in lbs (VW-61). Lets the
   * rest recap show the just-closed set's peak force (VW-45 is live-overlay-only, so
   * it vanishes the instant rest begins). Null when no rep logged concentric force.
   */
  peakForceLbs: number | null;
  /**
   * Full WA `Rep[]` retained at set-close (source of truth). The reps are
   * already in `SnapshotActiveSet.reps` before the set closes, so retaining
   * them costs no backend/wire change and lets the hero derive RPE, per-rep
   * velocity (and, later, tempo) via the shared view-model mappers — which the
   * scalar summary fields structurally cannot.
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
  /** Exercise name saved at the same tick as `lastActiveSet`, tagged onto the closed set. */
  lastActiveExerciseName: string | null;
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
    lastActiveExerciseName: null,
    lastSessionId: null,
    setLog: [],
    restStartMs: null,
  };
}

function summariseClosedSet(
  set: SnapshotActiveSet,
  device: SnapshotDevice | null,
  exerciseName: string | null,
): CompletedSet {
  const reps = Array.isArray(set.reps) ? set.reps : [];
  let bestPeak: number | null = null;
  let peakForce: number | null = null;
  for (const rep of reps) {
    const v = repPeakMms(rep);
    if (v != null && (bestPeak === null || v > bestPeak)) bestPeak = v;
    const f = repPeakConcentricForceLbs(rep);
    if (f != null && (peakForce === null || f > peakForce)) peakForce = f;
  }
  const weightLbs = resolveWeightLbs(device, set);
  return {
    weightLbs,
    mode: device?.trainingMode ?? null,
    repCount: reps.length,
    exerciseName,
    bestPeakVelocityMms: bestPeak,
    peakForceLbs: peakForce,
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

  const serverCompleted = snapshot.sets.completed;
  if (serverCompleted !== undefined) {
    // VW-70: the server ships the current session's finished sets, so rebuild the
    // log from them every tick. This is authoritative and idempotent (the same
    // list re-summarised each poll), and — unlike the active→null accrual below —
    // it survives a page reload or a late SSE join because it doesn't depend on
    // having observed the live set-close transition. Tagged with the current
    // session's exercise (all completed sets in a session belong to it).
    const exerciseName = snapshot.session?.exerciseName ?? null;
    setLog = serverCompleted.map((entry) =>
      summariseClosedSet(entry.set, entry.device, exerciseName),
    );
  } else if (state.prevSetActive && !activeSet && state.lastActiveSet !== null) {
    // Legacy fallback (server without VW-70 completed-set exposure): a set just
    // closed, so push the snapshot saved at the previous tick, tagged with the
    // exercise active at that tick.
    setLog = [
      ...setLog,
      summariseClosedSet(state.lastActiveSet, state.lastActiveDevice, state.lastActiveExerciseName),
    ];
  }

  // Save this tick's active-set + device + exercise snapshots together for next-tick close.
  const lastActiveSet = activeSet ? activeSet : null;
  const lastActiveDevice = activeSet ? device : null;
  const lastActiveExerciseName = activeSet ? (snapshot.session?.exerciseName ?? null) : null;

  // Rest-timer transitions.
  const setIsActive = !!activeSet;
  let restStartMs = state.restStartMs;
  if (state.prevSetActive && !setIsActive) restStartMs = nowMs;
  if (!state.prevSetActive && setIsActive && restStartMs !== null) restStartMs = null;

  return {
    prevSetActive: setIsActive,
    lastActiveSet,
    lastActiveDevice,
    lastActiveExerciseName,
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

// ── Hero set timeline (canonical WorkoutSetView) ─────────────────────────────

function priorPerformance(setLog: CompletedSet[], i: number): WorkoutSetView['previous'] {
  const prev = i > 0 ? setLog[i - 1] : null;
  return prev && prev.weightLbs != null ? { reps: prev.repCount, weightLbs: prev.weightLbs } : null;
}

/**
 * Completed sets + the active set as canonical {@link WorkoutSetView}s, ascending
 * (mirrors the mobile app's SetLog). Each carries the raw WA `Rep[]`; the shared
 * view-model mappers derive titan `SetRow` props (RPE, per-rep velocity, PREV)
 * from it — the same code path the mobile app will reuse once it consumes the
 * shared layer, so the two surfaces converge on one component set.
 */
export function buildHeroSets(snapshot: Snapshot, setLog: CompletedSet[]): WorkoutSetView[] {
  const rows: WorkoutSetView[] = setLog.map((s, i) => ({
    setNumber: i + 1,
    kind: 'completed' as const,
    reps: s.reps,
    weightLbs: s.weightLbs,
    targetReps: null,
    targetWeightLbs: null,
    previous: priorPerformance(setLog, i),
  }));

  const active = snapshot.sets.active;
  if (active) {
    const device = firstDevice(snapshot);
    const reps = Array.isArray(active.reps) ? active.reps : [];
    const weightLbs = resolveWeightLbs(device, active);
    rows.push({
      setNumber: setLog.length + 1,
      kind: 'active',
      reps,
      weightLbs,
      targetReps: resolveRepTarget(active),
      targetWeightLbs: weightLbs,
      previous: priorPerformance(setLog, setLog.length),
    });
  }
  return rows;
}
