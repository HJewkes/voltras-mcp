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
 * The dual (bilateral) stage is now store-fed per slot (VW-71) — one
 * {@link DashboardModel} per limb, projected by `panels/live-view.ts`'s
 * `mapStoreToDualModel`. The fixture-fabricating `deriveDualModel` it replaced is gone.
 */
import type { MetricTileData, SessionRailExercise } from '@titan-design/react-ui';
import { type MassUnit, convertMass, formatMass } from './mass';

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
  /** Peak concentric force this set (lbs); the store folds a running set-level max (VW-45). */
  peakForce: number | null;
}

/** A logged set on the session read-model. */
export interface CompletedSet {
  /**
   * The exercise this set belongs to. A multi-exercise session accumulates every
   * closed set in one log; the active-exercise rail row filters on this so it counts
   * only its own sets, while the session rollup sums all (VW-50 / VW-52). Null when
   * the store could not tag it.
   */
  exerciseName: string | null;
  /** Null when the settings cascade has not reported a weight (e.g. mock adapter). */
  weightLbs: number | null;
  /**
   * Resistance mode, sourced from the settings-cascade echo (never a lazy state-dump
   * field). See `panels/live-view.ts` — this union is narrower than the device's and
   * the map onto it is lossy.
   */
  mode: 'weight' | 'chains' | 'eccentric' | 'isokinetic';
  repCount: number;
  /** Per-rep MEAN concentric velocities (m/s) — same basis as the live bars (VW-62). */
  reps: number[];
  /**
   * Peak concentric force logged during the set (lbs), or null when the store could
   * not source it. Lets the rest recap show the finished set's peak force (VW-45/VW-61
   * — the live overlay's `peakForce` is gone once rest begins). Hidden when null.
   */
  peakForceLbs: number | null;
}

/**
 * One planned exercise in the session's ordered list (VW-49) — the metadata the rail
 * needs to render a non-active row (a done exercise before the active one, or an
 * upcoming one after it). The active exercise's live detail lives on the top-level
 * {@link SessionModel} fields; this carries only the plan-side targets.
 */
export interface PlannedExerciseModel {
  name: string;
  /** Prescribed set count — the rail row's column count and summary sets. */
  plannedSets: number;
  /** Rep target sizing an upcoming row's `todo` columns; null when no rep range. */
  targetReps: number | null;
  /** Preformatted reps cell for the rail summary: `"8–10"`, `8`, or the em-dash. */
  repsLabel: number | string;
  /** Null when the plan prescribes no working weight. */
  weightLbs: number | null;
  /** True for the exercise the live session is currently on. */
  active: boolean;
}

/** The session read-model. */
export interface SessionModel {
  /**
   * True when a real training session is open (`snapshot.session` present), regardless of
   * whether its exercise is named yet (VW-68). Lets the idle stage distinguish "no session —
   * waiting for a set" from "session open, first set not begun" and gate the exercise header.
   */
  hasSession: boolean;
  /**
   * The active exercise's display name. A real name when the session resolves one; otherwise
   * the neutral ordinal `Exercise N` (VW-68) — never a fabricated specific name, and never a
   * bare em-dash. `N` is the active exercise's 1-based position in the plan (1 with no plan).
   */
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
  /**
   * The session's FULL ordered planned-exercise list (VW-49), including the active
   * one (flagged). Empty when no plan is attached — the rail then shows only the
   * active exercise. Drives the rail's `upcoming` rows.
   */
  plannedExercises: PlannedExerciseModel[];
  /**
   * Prescribed rest between sets, seconds (VW-51). Null when the coach left it unset or
   * no plan is attached — the rest timer then hides its target rather than inventing one.
   */
  restSec: number | null;
  /** Prescribed set count. Null until `targetSets` reaches the view (VW-42). */
  plannedSets: number | null;
  /**
   * Prescribed reps per set. The lab fixture hardcoded `8` in the header; the store has
   * this for real as the active set's configured rep target, so the port reads it.
   * Null when no target is configured (an AMRAP/untargeted set).
   */
  targetReps: number | null;
}

/**
 * A coarse connection read-out folded from the device snapshot (VW-68) — enough for the idle
 * stage to shift its copy ("connect a Voltra" vs "waiting for a set"). The shell TopBar owns
 * the authoritative connection glyph/banner (VW-67); this is only the content-side hint.
 * Optional: a preview/fixture model omits it, and an absent value means "unknown", never
 * "disconnected".
 */
export interface ConnectionInfo {
  /** True only when a device is actually live (not merely that the sidecar answered). */
  connected: boolean;
  /** Short status label mirrored from `buildConnectionStatus` (LIVE / OFFLINE / WAITING / …). */
  label: string;
}

/** The full store read-model the live page reads. */
export interface DashboardModel {
  /**
   * The live-set overlay, or null when nothing is streaming (between sets, or before
   * the first SSE frame). The session half still renders — that IS the rest case.
   */
  live: LiveModel | null;
  session: SessionModel;
  /** Coarse connection hint for the idle stage (VW-68); absent ⇒ unknown, never disconnected. */
  connection?: ConnectionInfo;
  /**
   * Elapsed rest time (ms) since the last set closed — the client-tracked count-up the
   * legacy `RestTimerPanel` reads (`nowMs − restStartMs`). Null before any set has ended
   * (pre-session idle) or once the next set begins. Drives the rest stage's countdown /
   * count-up; it is a CLOCK value, not a plan field, so it ticks between sets and is
   * null otherwise. Never fabricated — sourced from the accumulator's `restStartMs`.
   */
  restElapsedMs: number | null;
}

/**
 * A model that is definitely mid-set. The live stage requires a stream by definition, so
 * it takes this rather than re-checking: whether there is a set to show is the PAGE's
 * decision (no stream ⇒ rest), made once, instead of every layer guarding.
 */
export type LiveDashboardModel = DashboardModel & { live: LiveModel };

/**
 * The dual (bilateral) stage's per-limb read-models (VW-71): one {@link DashboardModel}
 * per Voltra slot. A side is `null` when no device is bound to that slot (or the slot
 * reports no telemetry) — the dual stage then shows an awaiting state for it rather than
 * fabricating the missing limb. Each present side picks its own live/rest/empty stage,
 * exactly as the single view does, from that slot's own snapshot.
 */
export interface DualDashboardModel {
  left: DashboardModel | null;
  right: DashboardModel | null;
}

/**
 * True when the live stage has nothing honest to show: no set streaming, none logged, and no
 * rest clock running — exactly the inputs under which {@link RestView} would render blank
 * (VW-68). Covers the no-session idle, the session-started-but-first-set-not-begun, and the
 * disconnected cases; drives the {@link EmptyLiveView} branch. Kept here (not on the
 * component) so it is a pure, node-testable model predicate.
 */
export function stageIsEmpty(model: DashboardModel): boolean {
  return (
    model.live === null && model.session.completedSets.length === 0 && model.restElapsedMs === null
  );
}

// --- Derived projections (store read-model → titan presentational props) -------

/** Arithmetic mean of a per-rep velocity array (m/s). */
export function meanVelocity(reps: number[]): number {
  if (reps.length === 0) return 0;
  return reps.reduce((a, v) => a + v, 0) / reps.length;
}

/**
 * Verdict status from velocity loss %, on the canonical VL20/VL30 bands: below VL20
 * keep going (`productive`), VL20–VL30 approaching fatigue (`threshold`), VL30+
 * terminate the set (`stop`).
 *
 * Null loss (fewer than 2 reps, so no loss is computable yet) reads as `productive`:
 * no fatigue signal is not a fatigue signal.
 *
 * CANONICAL BANDS: 20/30. The dashboard's `toAutoRegStatus`
 * (`panels/exercise-hero-view.ts`) now bands identically, so the rest-view aura and the
 * live StatusPill agree across the whole 20–30% range. The autoregulation spec frames
 * velocity loss as a configurable fatigue proxy (its moderate-fatigue zone is 20–30%),
 * so it does not mandate exact productive/threshold/stop cutpoints — 20/30 is the
 * dashboard default the rest of the surface already names.
 * TODO(VW-64): consume WA `velocityLossVerdict` once published (the eventual SSOT).
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
 * True for a set worth showing — one that recorded at least one rep. A completed set with
 * ZERO reps is not a real working set: the only path that finalizes an empty set is the
 * inactivity force-close (a lifter armed a set, walked away, and it auto-closed), and it
 * carries no rep to recap. Filtering these at the read layer keeps them in the durable
 * log while excluding them from the recap table, the rail's set tally, and the per-set
 * strip — a 0-rep timed-out set was appearing as "Set N · 0 reps" and inflating the
 * "N/N sets" count on the wall.
 */
export function isRealCompletedSet(set: CompletedSet): boolean {
  return set.repCount > 0;
}

/**
 * The active exercise's completed sets — those tagged with the active exercise's name.
 * Exported so the rest stage recaps the SAME per-exercise slice the rail counts (VW-50)
 * rather than duplicating the filter.
 */
export function activeCompletedSets(session: SessionModel): CompletedSet[] {
  return session.completedSets.filter((s) => s.exerciseName === session.exerciseName);
}

/** Peak of a per-rep velocity array (m/s), or null when the set logged no reps. */
export function peakVelocity(reps: number[]): number | null {
  if (reps.length === 0) return null;
  return Math.max(...reps);
}

/**
 * Velocity loss of a completed set (%): the drop from the set's fastest rep to its last,
 * as a non-negative percentage — the same "vs the set's best rep" definition
 * {@link verdictFromLoss} bands on. Null when fewer than 2 reps landed (no loss is
 * computable from one point).
 *
 * This is RE-DERIVED from the recorded per-rep velocities — the store does not retain the
 * live set's `velocityLossPct` once the set closes, so the recap recomputes it from the
 * same array the strip shows. Those velocities are MEAN-concentric (VW-62), the same
 * basis WA's `getSetVelocityLossPct` folds over, so this loss reads on the canonical
 * metric rather than the optimistic peak the port originally carried.
 */
export function velocityLossPct(reps: number[]): number | null {
  if (reps.length < 2) return null;
  const best = Math.max(...reps);
  if (best <= 0) return null;
  const last = reps[reps.length - 1];
  return Math.max(0, ((best - last) / best) * 100);
}

/**
 * The best (most reps) set so far for the active exercise — the max rep count across its
 * completed sets, including the set in progress (VW-68). Null when nothing has landed yet, so
 * the summary shows an honest `—` rather than a fabricated 0. On real hardware completed sets
 * carry no per-set reps until VW-70, so this reads from the live overlay's landed reps too.
 */
function bestRepsSoFar(done: CompletedSet[], live: LiveModel | null): number | null {
  const counts = done.map((s) => s.repCount);
  if (live) counts.push(live.repVelocities.length);
  const best = counts.length > 0 ? Math.max(...counts) : 0;
  return best > 0 ? best : null;
}

/**
 * A rail summary's `weight` + `unit`: the formatted load, or `NO_VALUE` ("—") when the load
 * is unset (`null`) — a discovery / no-prescription load, NOT a faked 0. The unit label still
 * resolves from the display unit so the placeholder reads "— lbs" / "— kg".
 */
function summaryLoad(
  lbs: number | null,
  displayUnit: MassUnit,
): { weight: number | string; unit: MassUnit } {
  if (lbs === null) return { weight: NO_VALUE, unit: formatMass(0, displayUnit).unit };
  const load = formatMass(lbs, displayUnit);
  return { weight: load.value, unit: load.unit };
}

/**
 * The rail row for the ACTIVE exercise: its OWN completed sets (filtered from the
 * session-wide log so a prior exercise's sets don't bleed into its count — VW-50), the
 * set in progress, and any remaining planned sets.
 *
 * `weight` shows the live value, or `—` when no weight is set yet (never a faked 0).
 * On real hardware it is the live cascade value.
 */
function buildActiveRow(model: DashboardModel, displayUnit: MassUnit): SessionRailExercise {
  const { session, live } = model;
  const done = activeCompletedSets(session);
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

  return {
    name: session.exerciseName,
    // `plannedSets` (prescribed) drives the rail header total + pace bar; `summary.sets` below
    // is the live DONE count. Keeping them distinct stops the header under-counting by the
    // active exercise's remaining sets (its done-count is 0 before the first set closes).
    ...(session.plannedSets !== null ? { plannedSets: session.plannedSets } : {}),
    // PROGRESS aggregates for the active exercise (VW-68), not a prescription stub: what has
    // actually happened this session — sets banked, the best (most reps) set so far, the real
    // load — rather than the `— × — @ 0` target echo. Honest empties (0 sets, `—` reps, `—`
    // load) when nothing has landed / no weight is set — never a faked 0.
    summary: {
      sets: done.length + (live ? 1 : 0),
      reps: bestRepsSoFar(done, live) ?? NO_VALUE,
      ...summaryLoad(session.weightLbs, displayUnit),
    },
    ...(session.tempo ? { tempo: session.tempo } : {}),
    indicator: 'velocity-loss',
    setStates,
  };
}

/**
 * A DONE row for a planned exercise the session has already moved past: its logged sets
 * (tagged with its name) as `done` columns. Empty strip when nothing was logged for it —
 * a real, if skipped, planned exercise, never an invented one.
 */
function buildDoneRow(
  planned: PlannedExerciseModel,
  session: SessionModel,
  displayUnit: MassUnit,
): SessionRailExercise {
  const logged = session.completedSets.filter((s) => s.exerciseName === planned.name);
  return {
    name: planned.name,
    plannedSets: planned.plannedSets,
    summary: {
      sets: planned.plannedSets,
      reps: planned.repsLabel,
      ...summaryLoad(planned.weightLbs, displayUnit),
    },
    indicator: 'velocity-loss',
    setStates: logged.map((set) => ({ status: 'done', velocities: set.reps })),
  };
}

/**
 * An UPCOMING (dimmed) row for a not-yet-reached planned exercise: `todo` columns sized
 * to its planned sets × rep target. No columns when the plan states no rep target — a
 * `todo` set must declare its expected reps, and we will not guess.
 */
function buildUpcomingRow(
  planned: PlannedExerciseModel,
  displayUnit: MassUnit,
): SessionRailExercise {
  const setStates: SessionRailExercise['setStates'] = [];
  if (planned.targetReps !== null) {
    for (let i = 0; i < planned.plannedSets; i++) {
      setStates.push({ status: 'todo', planned: planned.targetReps });
    }
  }
  return {
    name: planned.name,
    plannedSets: planned.plannedSets,
    summary: {
      sets: planned.plannedSets,
      reps: planned.repsLabel,
      ...summaryLoad(planned.weightLbs, displayUnit),
    },
    indicator: 'velocity-loss',
    upcoming: true,
    setStates,
  };
}

/**
 * The session rail's exercise list. With a plan attached (VW-49) the FULL ordered list
 * renders: exercises already done, the active one (rich live detail), and dimmed
 * `upcoming` ones. Without a plan the store cannot honestly list more than one, so only
 * the active exercise shows — the pre-VW-49 behaviour.
 */
export function deriveRailExercises(
  model: DashboardModel,
  displayUnit: MassUnit = 'lbs',
): SessionRailExercise[] {
  const { session, live } = model;
  // NO SESSION at all — no `snapshot.session`, no plan, nothing logged, nothing streaming
  // (VW-68). Emit an EMPTY list so the rail shows an honest empty treatment rather than a stub
  // active row for a session that does not exist. A real session (even one whose exercise is
  // only the `Exercise N` ordinal) still shows its active row below before its first set.
  if (
    !session.hasSession &&
    session.plannedExercises.length === 0 &&
    session.completedSets.length === 0 &&
    live === null
  ) {
    return [];
  }
  if (session.plannedExercises.length === 0) return [buildActiveRow(model, displayUnit)];

  const activeIndex = session.plannedExercises.findIndex((e) => e.active);
  return session.plannedExercises.map((planned, i) => {
    if (planned.active) return buildActiveRow(model, displayUnit);
    if (activeIndex === -1 || i > activeIndex) return buildUpcomingRow(planned, displayUnit);
    return buildDoneRow(planned, session, displayUnit);
  });
}

/** Format a prescribed rep range for a rail summary cell: `"8–10"`, `8`, or the em-dash. */
export function formatRepsRange(
  low: number | null | undefined,
  high: number | null | undefined,
): number | string {
  if (low == null && high == null) return NO_VALUE;
  if (low != null && high != null) return low === high ? low : `${low}–${high}`;
  return (low ?? high) as number;
}

/** Format a load total (lbs) compactly: `"7.3k"` at ≥1000, else a rounded integer. */
function formatLoad(lbs: number): string {
  if (lbs >= 1000) return `${(lbs / 1000).toFixed(1)}k`;
  return String(Math.round(lbs));
}

/**
 * Session-level rollup tiles for the rail header (VW-52): Volume (Σ reps) and Tonnage
 * (Σ reps×weight), folded over the WHOLE session's completed sets — every exercise, not
 * just the active one (that split is what VW-50's per-set exercise tag preserves).
 * Returns null before any set closes so the header hides rather than showing zeros.
 *
 * The Σ reps×weight tile is labelled "Tonnage", NOT "Load": the verdict panel's "Load"
 * tile is the working WEIGHT (e.g. 20 lbs), and reusing "Load" here for the tonnage total
 * (e.g. 200 lbs) put the same word against two different quantities on the wall.
 *
 * No Fatigue tile: the read-models carry only a per-set live velocity loss, not an
 * honest session-wide fatigue signal, so it is omitted rather than fabricated.
 */
export function deriveRailMetrics(
  model: DashboardModel,
  displayUnit: MassUnit = 'lbs',
): MetricTileData[] | null {
  const sets = model.session.completedSets;
  if (sets.length === 0) return null;
  let reps = 0;
  let loadLbs = 0;
  for (const set of sets) {
    reps += set.repCount;
    loadLbs += (set.weightLbs ?? 0) * set.repCount;
  }
  // Volume is a rep COUNT — unit-invariant, never converted. Tonnage is a mass total (lbs),
  // converted to the display unit and suffixed so the compact "k" value stays unambiguous
  // on the wall (the tile carries no separate unit field).
  const tonnage = convertMass(loadLbs, displayUnit);
  return [
    { label: 'Volume', value: String(reps) },
    { label: 'Tonnage', value: `${formatLoad(tonnage)} ${displayUnit}` },
  ];
}
