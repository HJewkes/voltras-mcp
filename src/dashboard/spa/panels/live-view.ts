/**
 * Store → `DashboardModel` adapter for the ported north-star live page (VW-38).
 *
 * The live page (`../live-page/`) is a port of titan's `Lab/North Star` specimen and
 * reads ONE read-model, {@link DashboardModel}, whose shape deliberately mirrors this
 * store. This module is the seam: pure projection from the store slices
 * (snapshot + accumulator + SSE live + prescription) onto that model. No I/O, no
 * component imports — `main.tsx` owns the store reads and passes the result down.
 *
 * GAP fields (no store source yet) are left `null`/omitted rather than invented, so
 * the page hides them exactly as titan's `LiveNoTempo` story does. Each is ticketed:
 *   - `session.title`      → VW-43 (compose from WorkoutTemplate + TrainingBlock)
 * `session.tempo` is now wired: the prescription carries the resolved target tempo
 * (VW-41; coach override still pending, VW-46), hidden when the prescription has none.
 * Wiring each is additive here — no consumer change.
 */
import { type Rep } from '@voltras/workout-analytics';
import {
  buildConnectionStatus,
  buildCurrentSet,
  repMeanMms,
  toMps,
  type AccumulatorState,
  type CompletedSet as StoreCompletedSet,
  type PrescriptionView,
  type Snapshot,
} from '../adapter';
import { type LiveModel as StoreLiveModel } from '../live-stream';
import {
  formatRepsRange,
  type CompletedSet,
  type ConnectionInfo,
  type DashboardModel,
  type LiveModel,
  type PlannedExerciseModel,
  type RepModel,
  type SessionModel,
} from '../live-page/model';

/** The store slices the live page projects from. */
export interface LiveViewSources {
  snapshot: Snapshot | null;
  accumulator: AccumulatorState;
  /** SSE live overlay; null until the first frame arrives. */
  live: StoreLiveModel | null;
  prescription: PrescriptionView | null;
  /**
   * The store's monotonic clock (`nowMs`), for the rest count-up. Ticks once a second
   * plus on every snapshot; paired with `accumulator.restStartMs` it yields the elapsed
   * rest the rest stage renders. Defaults to 0 when a caller has no clock to pass (the
   * mapper then reports no rest elapsed rather than a bogus one).
   */
  nowMs?: number;
  /**
   * The HTTP poll status (`ok`/`stale`/`error`), folded with the device snapshot into the
   * idle stage's coarse connection hint (VW-68). Defaults to `ok` when a caller has none —
   * the hint then reflects only the device flag, which is the honest floor.
   */
  pollStatus?: 'ok' | 'stale' | 'error';
}

/**
 * The idle stage's connection hint, reusing the shell's own {@link buildConnectionStatus}
 * classifier (never a second copy of the priority logic — VW-67 owns it). Only the coarse
 * `connected` flag + label reach the content model.
 */
function mapConnection(snapshot: Snapshot, pollStatus: 'ok' | 'stale' | 'error'): ConnectionInfo {
  const status = buildConnectionStatus(snapshot, pollStatus);
  return { connected: status.connected, label: status.label };
}

/**
 * Store `LivePhase` (`'con'`/`'ecc'`) → the page's spelled-out phase.
 *
 * Two vocabularies for one concept: the live-signal keeps the terse wire-side labels,
 * the specimen spells them out. Remap at the boundary rather than churn either side.
 */
function mapPhase(phase: StoreLiveModel['phase']): LiveModel['phase'] {
  switch (phase) {
    case 'con':
      return 'concentric';
    case 'ecc':
      return 'eccentric';
    case 'hold':
      return 'hold';
    default:
      return 'idle';
  }
}

/**
 * Device training mode → the page's resistance-mode label.
 *
 * PROVISIONAL — the two vocabularies do not line up and this is a lossy map:
 * the device has seven modes (Idle · WeightTraining · ResistanceBand · Rowing ·
 * Damper · CustomCurves · Isokinetic) while the specimen's union has four, and its
 * `'eccentric'` is not a device mode at all — eccentric overload is a MODIFIER on
 * WeightTraining (`eccentricPercent`/`eccentricOverloadLbs`), so it can never be
 * produced from `trainingMode` alone. Rowing/Damper/CustomCurves have no analog and
 * fall back to `'weight'`. Reconciling the unions (and sourcing eccentric from the
 * settings cascade) is its own ticket; until then the recap may mislabel a
 * non-weight set.
 *
 * `trainingMode` is the REQUESTED mode echoed from the settings cascade — the
 * correct source. Never read the lazy state-dump fields.
 */
function mapMode(trainingMode: string | null): CompletedSet['mode'] {
  switch (trainingMode) {
    case 'Isokinetic':
      return 'isokinetic';
    case 'ResistanceBand':
      return 'chains';
    default:
      return 'weight';
  }
}

/**
 * Per-rep MEAN concentric velocities (m/s), ordered by rep.
 *
 * MEAN-concentric — the VBT decision metric, and the same quantity the live
 * VelocityStrip bars now show (VW-58 routed those through `repMeanMms`). A set must
 * not flip its bars from mean → peak the instant it closes, so the completed-set
 * strip reads mean too (VW-62). This is the PER-REP swap, which is unblocked: the
 * installed WA 1.5.0 exports `getRepMeanVelocity` (wrapped by `repMeanMms`). The
 * set-level `getSetRepMeanVelocities` sibling is not published in 1.5.0, so the
 * hero's `getSetRepPeakVelocities` path stays peak until then (see
 * `exercise-hero-view.ts`).
 */
function repVelocitiesMps(reps: readonly Rep[]): number[] {
  const out: number[] = [];
  for (const rep of reps) {
    const mps = toMps(repMeanMms(rep));
    if (mps !== null) out.push(mps);
  }
  return out;
}

/**
 * The most-recently finalized rep.
 *
 * `rom` is a straight passthrough: both sides are metres (`LiveRepSignal.rom` is the
 * concentric range of motion, `RepModel.rom` the same).
 */
function mapLastRep(live: StoreLiveModel): RepModel | null {
  if (!live.lastRep) return null;
  return {
    vCon: live.lastRep.vCon,
    peakVelocity: live.lastRep.peakVelocity,
    rom: live.lastRep.rom,
  };
}

/**
 * The live-set telemetry read-model.
 *
 * Units: the store's `force` is already POUNDS (the live-signal converts at the
 * boundary); the specimen's fixture labelled it Newtons. The ported view is
 * relabelled to lbs rather than converting — lbs is what the rest of the dashboard
 * shows, and a unit flip mid-page would be the real bug.
 */
function mapLive(
  live: StoreLiveModel,
  velocityLossPct: number | null,
  repVelocities: number[],
): LiveModel {
  return {
    velocity: live.velocity,
    force: live.force,
    phase: mapPhase(live.phase),
    phaseElapsedMs: live.phaseElapsedMs,
    lastRep: mapLastRep(live),
    repVelocities,
    velocityLossPct,
    peakForce: live.peakForce,
  };
}

/** A closed set on the session read-model. */
function mapCompletedSet(set: StoreCompletedSet): CompletedSet {
  return {
    exerciseName: set.exerciseName,
    weightLbs: set.weightLbs,
    mode: mapMode(set.mode),
    repCount: set.repCount,
    reps: repVelocitiesMps(set.reps),
    peakForceLbs: set.peakForceLbs,
  };
}

/**
 * The prescription's ordered planned-exercise list (VW-49) → the session model's list.
 * Empty when the session carries no plan — the rail then shows only the active exercise.
 */
function mapPlannedExercises(prescription: PrescriptionView | null): PlannedExerciseModel[] {
  const list = prescription?.exercises;
  if (list === undefined) return [];
  return list.map((e) => ({
    name: e.name,
    plannedSets: e.sets,
    targetReps: e.repsLow ?? null,
    repsLabel: formatRepsRange(e.repsLow, e.repsHigh),
    weightLbs: e.weightLbs ?? null,
    active: e.active,
  }));
}

/**
 * The active exercise's display name (VW-68). A resolved session name when there is one;
 * otherwise the neutral ordinal `Exercise N` — never a fabricated specific name, and never a
 * bare em-dash. `N` is the active exercise's 1-based position in the plan (1 with no plan).
 */
function resolveExerciseName(snapshot: Snapshot, plannedExercises: PlannedExerciseModel[]): string {
  const raw = snapshot.session?.exerciseName;
  if (raw) return raw;
  const activeIdx = plannedExercises.findIndex((e) => e.active);
  return `Exercise ${activeIdx >= 0 ? activeIdx + 1 : 1}`;
}

/** The session read-model. */
function mapSession(
  snapshot: Snapshot,
  setLog: readonly StoreCompletedSet[],
  weightLbs: number | null,
  targetReps: number | null,
  prescription: PrescriptionView | null,
): SessionModel {
  const plannedExercises = mapPlannedExercises(prescription);
  return {
    // A real training session is open when the snapshot carries one, regardless of whether its
    // exercise is named yet — lets the idle stage tell "no session" from "session, no set".
    hasSession: snapshot.session != null,
    exerciseName: resolveExerciseName(snapshot, plannedExercises),
    title: null,
    weightLbs,
    unit: 'lbs',
    // Target tempo tuple [ecc, pauseBottom, con, pauseTop], resolved server-side
    // from the exercise default (VW-41). Hidden when the prescription carries none.
    tempo: prescription?.tempo,
    completedSets: setLog.map(mapCompletedSet),
    // The full ordered planned-exercise list (VW-49) — empty without a plan.
    plannedExercises,
    // Prescribed inter-set rest (VW-51); null when the coach left it unset or no plan.
    restSec: prescription?.restSec ?? null,
    // Null when the session carries no plan attachment at all — the view then hides the
    // set count rather than implying a one-set prescription.
    plannedSets: prescription?.sets ?? null,
    targetReps,
  };
}

/**
 * Project the store slices onto the live page's {@link DashboardModel}.
 *
 * Returns null when there is no snapshot yet (nothing to render). A null `live`
 * slice is NOT null-modelled: the session/recap half still renders between sets,
 * which is exactly the rest-view case.
 */
export function mapStoreToDashboardModel(sources: LiveViewSources): DashboardModel | null {
  const { snapshot, accumulator, live, prescription, nowMs = 0, pollStatus = 'ok' } = sources;
  if (!snapshot) return null;

  const currentSet = buildCurrentSet(snapshot);
  const device = snapshot.devices[0]?.device ?? null;
  const weightLbs = device?.weightLbs ?? null;
  // The active set's per-rep velocities — the same array the existing hero's VelocityStrip
  // reads, so the two views cannot disagree about what landed.
  const repVelocities = currentSet.active ? currentSet.velocitiesMps : [];

  // Elapsed rest = the client-tracked count-up the legacy RestTimerPanel uses (main.tsx):
  // null until a set has closed, then `nowMs − restStartMs`, clamped so a clock skew never
  // shows a negative. The accumulator clears restStartMs when the next set starts.
  const restElapsedMs =
    accumulator.restStartMs == null ? null : Math.max(0, nowMs - accumulator.restStartMs);

  return {
    live: live ? mapLive(live, currentSet.velocityLossPct, repVelocities) : null,
    restElapsedMs,
    connection: mapConnection(snapshot, pollStatus),
    session: mapSession(
      snapshot,
      accumulator.setLog,
      weightLbs,
      currentSet.repTarget,
      prescription,
    ),
  };
}
