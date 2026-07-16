/**
 * The live page's read-model contract + the fixture that exercises it.
 *
 * PORTED from titan's `Lab/North Star/Live Wall Dashboard` specimen (titan #109/#111),
 * where these shapes were written to MIRROR this store so the wiring would be a
 * mechanical field map, not a reshape. `panels/live-view.ts` is that map.
 *
 * Divergence from the lab original, all in one direction — the lab could assume every
 * field was present because a fixture supplied it; the store cannot. Fields with no
 * store source are `| null` (or optional) so the views HIDE them rather than render a
 * fabricated number. This extends the precedent titan #111 set for `tempo?`. See
 * `panels/live-view.ts` for the ticket per gap.
 *
 * The fixture below is retained as the dual-mode preview's data and a render check;
 * it is NOT what the mounted page reads.
 */
import type { SessionRailExercise } from '@titan-design/react-ui';

// --- Store read-model shapes (mirror voltras-mcp dashboard store) -------------

/** One completed rep's per-rep telemetry (mean-concentric metric family). */
export interface RepModel {
  /** Mean CONCENTRIC velocity (m/s) — the canonical metric (brain WA-D02). */
  vCon: number;
  /** Range of motion (m). Null until a public rep-ROM source exists (VW-44). */
  rom: number | null;
  /** Peak instantaneous velocity (m/s). */
  peakVelocity: number;
}

/** The live-set telemetry read-model. */
export interface LiveModel {
  /** Instantaneous cable velocity (m/s). */
  velocity: number;
  /**
   * Instantaneous cable force (LBS). The lab fixture called this Newtons; the store
   * converts to lbs at the live-signal boundary and lbs is what the rest of the
   * dashboard shows, so the port relabels rather than converts.
   */
  force: number;
  /** Current movement phase. */
  phase: 'concentric' | 'hold' | 'eccentric' | 'idle';
  /** Elapsed time (ms) within the current phase — drives the live tempo fill. */
  phaseElapsedMs: number;
  /** The most-recently completed rep; null before the first rep of a set lands. */
  lastRep: RepModel | null;
  /** Per-rep velocities logged so far this set (m/s). */
  repVelocities: number[];
  /** Velocity loss vs the set's best rep (%). Null until 2 reps land. */
  velocityLossPct: number | null;
  /** Peak concentric force this set (lbs). Null until an accumulator exists (VW-45). */
  peakForce: number | null;
}

/** A logged set on the session read-model. */
export interface CompletedSet {
  /** Null when the settings cascade has not reported a weight (e.g. mock adapter). */
  weightLbs: number | null;
  /**
   * Resistance mode, sourced from the settings-cascade echo (never a lazy state-dump
   * field). See `panels/live-view.ts` — this union is narrower than the device's and
   * the map onto it is lossy.
   */
  mode: 'weight' | 'chains' | 'eccentric' | 'isokinetic';
  repCount: number;
  /** Per-rep velocities (m/s). */
  reps: number[];
}

/** The session read-model. */
export interface SessionModel {
  exerciseName: string;
  /** Human session-block title. Null until composable from the plan (VW-43). */
  title: string | null;
  /** Null when the settings cascade has not reported a weight (e.g. mock adapter). */
  weightLbs: number | null;
  unit: 'lbs' | 'kg';
  /**
   * Prescribed tempo tuple [ecc, pauseBottom, con, pauseTop]. OPTIONAL — a set may carry no
   * prescribed tempo (coach left it unset and no exercise default); the live view then hides
   * the tempo readout entirely rather than inventing one.
   */
  tempo?: [number, number, number, number];
  completedSets: CompletedSet[];
  /** Prescribed set count. Null until `targetSets` reaches the view (VW-42). */
  plannedSets: number | null;
  /**
   * Prescribed reps per set. The lab fixture hardcoded `8` in the header; the store has
   * this for real as the active set's configured rep target, so the port reads it.
   * Null when no target is configured (an AMRAP/untargeted set).
   */
  targetReps: number | null;
}

/** The full store read-model the live page reads. */
export interface DashboardModel {
  /**
   * The live-set overlay, or null when nothing is streaming (between sets, or before
   * the first SSE frame). The session half still renders — that IS the rest case.
   */
  live: LiveModel | null;
  session: SessionModel;
}

/**
 * A model that is definitely mid-set. The live stage requires a stream by definition, so
 * it takes this rather than re-checking: whether there is a set to show is the PAGE's
 * decision (no stream ⇒ rest), made once, instead of every layer guarding.
 */
export type LiveDashboardModel = DashboardModel & { live: LiveModel };

// --- The fixture instance -----------------------------------------------------

/**
 * A mid-set cable chest press: 6 reps in, velocity decaying from 0.52 → 0.405 m/s,
 * ~22% velocity loss (the VL20–VL30 mid-zone → `threshold` verdict / amber aura).
 */
export const dashboardFixture: DashboardModel = {
  live: {
    velocity: 0.41,
    force: 498,
    phase: 'concentric',
    phaseElapsedMs: 700,
    lastRep: { vCon: 0.405, rom: 0.58, peakVelocity: 0.61 },
    repVelocities: [0.52, 0.5, 0.48, 0.46, 0.44, 0.405],
    velocityLossPct: 22,
    peakForce: 542,
  },
  session: {
    exerciseName: 'Cable Chest Press',
    title: 'Push A · Hypertrophy',
    weightLbs: 140,
    unit: 'lbs',
    tempo: [3, 1, 1, 0],
    plannedSets: 4,
    targetReps: 8,
    completedSets: [
      {
        weightLbs: 140,
        mode: 'weight',
        repCount: 8,
        reps: [0.55, 0.54, 0.52, 0.51, 0.49, 0.47, 0.45, 0.43],
      },
      {
        weightLbs: 140,
        mode: 'weight',
        repCount: 8,
        reps: [0.53, 0.52, 0.5, 0.48, 0.46, 0.44, 0.42, 0.4],
      },
    ],
  },
};

// --- Derived projections (store read-model → titan presentational props) -------

/** Arithmetic mean of a per-rep velocity array (m/s). */
export function meanVelocity(reps: number[]): number {
  if (reps.length === 0) return 0;
  return reps.reduce((a, v) => a + v, 0) / reps.length;
}

/**
 * Verdict status from velocity loss %, matching FatigueMeter's VL20/VL30 bands.
 *
 * Null loss (fewer than 2 reps, so no loss is computable yet) reads as `productive`:
 * no fatigue signal is not a fatigue signal.
 *
 * NOTE (unreconciled): these bands are 20/30, but the dashboard's existing
 * `toAutoRegStatus` (`panels/exercise-hero-view.ts`) bands at 20/28 — so the aura here
 * and the StatusPill elsewhere can disagree between 28% and 30%. One of the two must
 * become canonical; the burn-down flags it and it is NOT resolved by this port.
 */
export function verdictFromLoss(lossPct: number | null): 'productive' | 'threshold' | 'stop' {
  if (lossPct === null) return 'productive';
  if (lossPct >= 30) return 'stop';
  if (lossPct >= 20) return 'threshold';
  return 'productive';
}

/** Placeholder shown where the rail demands a value the store cannot supply yet. */
const NO_VALUE = '—';

/**
 * The session rail's exercise list, projected from the model: the ACTIVE exercise only —
 * its completed sets, the set in progress, and any remaining planned sets.
 *
 * Deliberately ONE exercise. The lab fixture appended two hardcoded upcoming accessories
 * (Incline DB Press, Cable Fly); the store cannot produce an upcoming list at all today
 * — `fetchSessionPlan` resolves only the active exercise's prescription — so inventing
 * them here would put fake exercises on a wall screen. The full list is VW-49.
 *
 * `weight` falls back to 0 because SessionRail requires a number: under the mock adapter
 * no settings cascade arrives, so weight reads 0/unknown (the standing weight-seed gap).
 * On real hardware it is the live value.
 */
export function deriveRailExercises(model: DashboardModel): SessionRailExercise[] {
  const { session, live } = model;
  const done = session.completedSets;
  const setStates: SessionRailExercise['setStates'] = done.map((set) => ({
    status: 'done',
    velocities: set.reps,
  }));
  if (live) {
    // `planned` sizes the strip's columns. With no rep target, the honest column count
    // is the reps actually landed — i.e. no pending placeholders rather than invented ones.
    setStates.push({
      status: 'active',
      velocities: live.repVelocities,
      planned: session.targetReps ?? live.repVelocities.length,
    });
  }
  // Any planned sets beyond those done + the one in progress. Skipped entirely without a
  // rep target: a `todo` set must state how many reps it expects, and we would be guessing.
  const accountedFor = setStates.length;
  const targetReps = session.targetReps;
  const remaining = session.plannedSets !== null ? session.plannedSets - accountedFor : 0;
  if (targetReps !== null) {
    for (let i = 0; i < remaining; i++) {
      setStates.push({ status: 'todo', planned: targetReps });
    }
  }

  return [
    {
      name: session.exerciseName,
      summary: {
        sets: session.plannedSets ?? accountedFor,
        reps: session.targetReps ?? NO_VALUE,
        weight: session.weightLbs ?? 0,
        unit: session.unit,
      },
      ...(session.tempo ? { tempo: session.tempo } : {}),
      indicator: 'velocity-loss',
      setStates,
    },
  ];
}

// --- Dual-mode (bilateral) projection -----------------------------------------

/**
 * A bilateral (dual-mode) PREVIEW pair — NOT REAL DATA, and structurally incapable of
 * being real: the "right" side is the fixture's left scaled by a constant.
 *
 * ⚠ This fabricates. It takes NO model argument ON PURPOSE — it always reads the
 * fixture, so store data can never be laundered through it onto a wall screen. A real
 * dual-mode path needs slot identity threaded through the live-signal hub and SSE
 * stream, which today are process-global and slot-blind (VW-48, the largest gap in the
 * burn-down). Until that lands the dual variant is a design preview only and its caller
 * must label it as such.
 */
export function deriveDualModel(): {
  left: DashboardModel;
  right: DashboardModel;
} {
  const base = dashboardFixture;
  const baseLive = base.live;
  if (!baseLive) return { left: base, right: base };
  // Left is the dominant side — the fixture verbatim.
  const left: DashboardModel = base;
  // Right lags: ~8% slower per-rep concentric velocity, +7 pts velocity loss, ~6% less force.
  const scale = (v: number) => Number((v * 0.92).toFixed(3));
  const right: DashboardModel = {
    session: base.session,
    live: {
      ...baseLive,
      velocity: scale(baseLive.velocity),
      force: Math.round(baseLive.force * 0.94),
      peakForce: baseLive.peakForce !== null ? Math.round(baseLive.peakForce * 0.94) : null,
      velocityLossPct: baseLive.velocityLossPct !== null ? baseLive.velocityLossPct + 7 : null,
      repVelocities: baseLive.repVelocities.map(scale),
      lastRep: baseLive.lastRep
        ? {
            vCon: scale(baseLive.lastRep.vCon),
            rom:
              baseLive.lastRep.rom !== null
                ? Number((baseLive.lastRep.rom * 0.96).toFixed(2))
                : null,
            peakVelocity: scale(baseLive.lastRep.peakVelocity),
          }
        : null,
    },
  };
  return { left, right };
}
