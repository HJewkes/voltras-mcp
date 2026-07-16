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
 *   - `session.tempo`      → VW-41 (defaults config + resolver), VW-46 (coach override)
 *   - `session.plannedSets`→ VW-42 (`targetSets` through the prescription path)
 *   - `live.lastRep.rom`   → VW-44 (WA public rep-ROM helper)
 *   - `live.peakForce`     → VW-45 (set-level peak-force accumulator)
 * Wiring each is additive here — no consumer change.
 */
import { type Rep } from '@voltras/workout-analytics';
import {
  buildCurrentSet,
  repPeakMms,
  toMps,
  type AccumulatorState,
  type CompletedSet as StoreCompletedSet,
  type PrescriptionView,
  type Snapshot,
} from '../adapter';
import { type LiveModel as StoreLiveModel } from '../live-stream';
import {
  type CompletedSet,
  type DashboardModel,
  type LiveModel,
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
 * Per-rep velocities (m/s), ordered by rep.
 *
 * These are PEAK concentric velocities — the specimen's arrays were mean-concentric.
 * The mean is the metric we actually want here, and WA has the helper for it
 * (`getSetRepMeanVelocities`), but only on main: the installed WA 1.5.0 exports
 * `getSetRepPeakVelocities` and nothing else, so the swap is gated on the next WA
 * publish (already pending — the tempo-order merge makes it a major bump). Peak reads
 * high vs mean, so the strip is optimistic until then; it matches the existing hero's
 * VelocityStrip, which reads the same array.
 */
function repVelocitiesMps(reps: readonly Rep[]): number[] {
  const out: number[] = [];
  for (const rep of reps) {
    const mps = toMps(repPeakMms(rep));
    if (mps !== null) out.push(mps);
  }
  return out;
}

/**
 * The most-recently finalized rep.
 *
 * `rom` is a GAP (VW-44): `LiveRepSignal` carries no ROM, so it stays null and the
 * page hides the read-out rather than showing a fabricated distance.
 */
function mapLastRep(live: StoreLiveModel): RepModel | null {
  if (!live.lastRep) return null;
  return {
    vCon: live.lastRep.vCon,
    peakVelocity: live.lastRep.peakVelocity,
    rom: null,
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
    peakForce: null,
  };
}

/** A closed set on the session read-model. */
function mapCompletedSet(set: StoreCompletedSet): CompletedSet {
  return {
    weightLbs: set.weightLbs,
    mode: mapMode(set.mode),
    repCount: set.repCount,
    reps: repVelocitiesMps(set.reps),
  };
}

/** The session read-model. */
function mapSession(
  snapshot: Snapshot,
  setLog: readonly StoreCompletedSet[],
  weightLbs: number | null,
  targetReps: number | null,
): SessionModel {
  return {
    exerciseName: snapshot.session?.exerciseName ?? '—',
    title: null,
    weightLbs,
    unit: 'lbs',
    tempo: undefined,
    completedSets: setLog.map(mapCompletedSet),
    plannedSets: null,
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
  const { snapshot, accumulator, live } = sources;
  if (!snapshot) return null;

  const currentSet = buildCurrentSet(snapshot);
  const device = snapshot.devices[0]?.device ?? null;
  const weightLbs = device?.weightLbs ?? null;
  // The active set's per-rep velocities — the same array the existing hero's VelocityStrip
  // reads, so the two views cannot disagree about what landed.
  const repVelocities = currentSet.active ? currentSet.velocitiesMps : [];

  return {
    live: live ? mapLive(live, currentSet.velocityLossPct, repVelocities) : null,
    session: mapSession(snapshot, accumulator.setLog, weightLbs, currentSet.repTarget),
  };
}
