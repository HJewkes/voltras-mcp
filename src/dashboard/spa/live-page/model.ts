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
 * The dual (bilateral) stage is store-fed per slot (VW-71), but NOT through this model:
 * it sources from `panels/fatigue-view.ts`'s `mapStoreToDivergingHeroModel`. The full
 * per-slot `DashboardModel` projection that preceded it is gone, along with the stacked
 * two-voltra stage it fed (each in its own full live view) and the fixture-fabricating
 * `deriveDualModel` before that.
 */
import type { MetricTileData, SessionRailExercise } from '@titan-design/react-ui';
import type { FatigueVerdict } from '@voltras/workout-analytics';
import { targetVerdict, type TargetVerdict } from '../../../analytics/target-verdict.js';
import { selectWorkingSets } from '../../../store/working-sets.js';
import { type MassUnit, convertMass, formatMass } from './mass';
// Type-only: erased at build (same rationale as adapter.ts's own import of this) —
// mirrors the store's four-value set-purpose enum without a runtime dependency.
import type { SetPurpose } from '../../../store/types.js';
// Type-only, same rationale: the declared setup card (VW-275).
import type { SetupCard } from '../../../store/types.js';
// Type-only, same rationale: the server-computed session pace (VW-290).
import type { SessionPaceView } from '../../read-models/session-pace.js';
import type { FatigueStop } from './fatigue-state';
import type { ResolvedRest } from '../../../analytics/rest-defaults.js';

export type { SetPurpose, SetupCard, SessionPaceView };

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
  /** The velocity-loss % at which this set reads as "stop" (VW-440). */
  fatigueStop: FatigueStop;
  /**
   * Which auto-arm mechanism opened this set (VW-265), or null for a lifter-started set.
   * Optional so a fixture built before this field existed still type-checks.
   */
  autoCreatedBy?: 'guided_load' | 'idle_rep' | null;
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
   * field). One label per device `TrainingMode` (VW-59) — see `panels/live-view.ts`,
   * which owns the total map. `'unknown'` covers Idle and a mode the store could not
   * report; the page hides the label rather than guessing at 'weight'.
   *
   * `'chains'` and `'eccentric'` are MODIFIERS on WeightTraining, not device modes, so
   * `mapMode` never produces them from `trainingMode` alone. They stay in the union
   * because sourcing them from the settings cascade is additive and already ticketed.
   */
  mode:
    | 'weight'
    | 'band'
    | 'rowing'
    | 'damper'
    | 'custom'
    | 'isokinetic'
    | 'isometric'
    | 'chains'
    | 'eccentric'
    | 'unknown';
  repCount: number;
  /** Per-rep MEAN concentric velocities (m/s) — same basis as the live bars (VW-62). */
  reps: number[];
  /**
   * Peak concentric force logged during the set (lbs), or null when the store could
   * not source it. Lets the rest recap show the finished set's peak force (VW-45/VW-61
   * — the live overlay's `peakForce` is gone once rest begins). Hidden when null.
   */
  peakForceLbs: number | null;
  /**
   * Why this set was performed (VW-260): `'working'`, or one of the three non-working
   * intents (`'warmup'` / `'probe'` / `'technique'`) stated at `set.start`. Always a
   * concrete value — the wire's optional field is defaulted to `'working'` at the
   * mapper boundary (`panels/live-view.ts`'s `mapCompletedSet`), the same treatment
   * `mode` gets, so nothing downstream has to repeat the fallback.
   */
  setPurpose: SetPurpose;
  /**
   * Which auto-arm mechanism opened this set (VW-265), or null for a lifter-started set.
   * Optional so a fixture built before this field existed still type-checks.
   */
  autoCreatedBy?: 'guided_load' | 'idle_rep' | null;
  /** The velocity-loss % at which this set read as "stop" (VW-440): its own watch, else the exercise's. */
  fatigueStop: FatigueStop;
  /** WA's combined verdict (velocity, ROM, tempo) for the closed set; null under 2 reps. */
  fatigueVerdict: FatigueVerdict | null;
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
  /**
   * Who is on the cable, when it is NOT the owner (VW-169). Null for the
   * owner's own work, which is the overwhelmingly common case — the wall shows
   * a name only when showing one changes what the numbers mean.
   */
  lifter: string | null;
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
   * The rest to count down after a set, seconds (VW-441): the plan's rest, else the
   * training-goal default, resolved server-side by the rule `timer.start` uses. Null only
   * with no session open, when the rest stage falls back to a count-up.
   */
  restSec: number | null;
  /** Where {@link restSec} came from, so a derived rest never reads as coach-set. Null with it. */
  restBasis: RestBasisModel | null;
  /** Prescribed set count. Null until `targetSets` reaches the view (VW-42). */
  plannedSets: number | null;
  /**
   * Prescribed reps per set. The lab fixture hardcoded `8` in the header; the store has
   * this for real as the active set's configured rep target, so the port reads it.
   * Null when no target is configured (an AMRAP/untargeted set).
   */
  targetReps: number | null;
  /**
   * The active exercise's reference setup card at exercise start (VW-275) —
   * anchor landmark, mount hole, cable-length setting, mode. Null when no
   * confirmed card and no digest-seeded default resolve for this exercise.
   */
  expectedSetupCard: SetupCard | null;
  /**
   * The session's pace against its attached plan (VW-290), computed server-side.
   * Null when no plan is attached — the rail's pace footer then stays hidden
   * rather than pacing the lifter against a budget nobody prescribed.
   */
  sessionPace: SessionPaceView | null;
}

/** The provenance of a resolved rest (VW-441), from the snapshot's `rest`. */
export type RestBasisModel = Pick<ResolvedRest, 'source' | 'intent' | 'extensionSeconds'>;

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

/**
 * True right after `session.end`: no session is open anymore, but the model still has
 * something to show for it (a logged set, or a rest clock that had been running) — proof
 * a session just closed rather than the wall never having seen one. Distinguishes the
 * post-session state from the true cold start ({@link stageIsEmpty}, where `hasSession` is
 * also false but nothing was ever recorded) so the wall can route the lifter to the
 * summary instead of falling back to the idle or rest stage (VW-261).
 */
export function stageIsEnded(model: DashboardModel): boolean {
  return !model.session.hasSession && !stageIsEmpty(model);
}

// --- Derived projections (store read-model → titan presentational props) -------

/** Arithmetic mean of a per-rep velocity array (m/s). */
export function meanVelocity(reps: number[]): number {
  if (reps.length === 0) return 0;
  return reps.reduce((a, v) => a + v, 0) / reps.length;
}

/** Placeholder shown where the rail demands a value the store cannot supply yet. */
const NO_VALUE = '—';

/**
 * Which auto-arm mechanism opened `set` (VW-265), or null for a lifter-started set. Shared
 * by the live header badge and the rest recap's set-type marker so the two surfaces read
 * the same signal off the same field rather than each re-deriving it.
 */
export function autoArmedBadge(
  set: { autoCreatedBy?: 'guided_load' | 'idle_rep' | null } | null | undefined,
): 'guided_load' | 'idle_rep' | null {
  return set?.autoCreatedBy ?? null;
}

/** Compact badge text for an auto-armed set — identical wherever the badge appears. */
export const AUTO_ARM_BADGE_TEXT = 'AUTO';

/** The badge's tooltip/title line, naming which auto-arm mechanism opened the set. */
export function autoArmedTitle(source: 'guided_load' | 'idle_rep'): string {
  return source === 'guided_load' ? 'Auto-armed · guided load' : 'Auto-armed · your reps';
}

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
 * True for a set that counts toward the WORKING-set tally (VW-260) — excludes warmup /
 * probe / technique sets AND an unflagged heavy-primer warm-up at sub-top load (VW-283),
 * via the same {@link selectWorkingSets} predicate the session-summary page and
 * `plan.suggest_progression` use. `exerciseSets` must be scoped to `set`'s own exercise —
 * the top-load rank is relative to whatever it is given (see `selectWorkingSets`).
 * Distinct from {@link isRealCompletedSet}, which filters a different defect (a 0-rep
 * force-closed set) — a warmup set is a perfectly real set, just not a WORKING one.
 */
export function isWorkingSet(set: CompletedSet, exerciseSets: readonly CompletedSet[]): boolean {
  return selectWorkingSets(exerciseSets).includes(set);
}

/**
 * The active exercise's completed sets — those tagged with the active exercise's name.
 * Exported so the rest stage recaps the SAME per-exercise slice the rail counts (VW-50)
 * rather than duplicating the filter.
 */
export function activeCompletedSets(session: SessionModel): CompletedSet[] {
  return session.completedSets.filter((s) => s.exerciseName === session.exerciseName);
}

/**
 * The session's WORKING completed sets, session-wide (VW-260) — the tally the rail header's
 * pace figure ({@link LivePage}'s `setsDone`) counts. Warmup/probe/technique sets are real
 * and stay in `session.completedSets` for the recap and the log; they just do not advance a
 * progress figure that means "working sets done". `selectWorkingSets`' top-load heuristic is
 * scoped per exercise (VW-283) — grouping by `exerciseName` first keeps a heavy exercise from
 * ranking a lighter one's sets out of its own tally.
 */
export function workingCompletedSets(session: SessionModel): CompletedSet[] {
  const groups = new Map<string | null, CompletedSet[]>();
  for (const set of session.completedSets) {
    const group = groups.get(set.exerciseName);
    if (group) group.push(set);
    else groups.set(set.exerciseName, [set]);
  }
  const working = new Set<CompletedSet>();
  for (const group of groups.values()) {
    for (const set of selectWorkingSets(group)) working.add(set);
  }
  return session.completedSets.filter((set) => working.has(set));
}

/** Peak of a per-rep velocity array (m/s), or null when the set logged no reps. */
export function peakVelocity(reps: number[]): number | null {
  if (reps.length === 0) return null;
  return Math.max(...reps);
}

/**
 * Velocity loss of a completed set (%): the drop from the set's fastest rep to its last,
 * as a non-negative percentage — the same "vs the set's best rep" definition
 * `setFatigueState` (`fatigue-state.ts`) bands on. Null when fewer than 2 reps landed (no loss is
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

/** One prescription lockup's cells, in the shape titan's `SetsRepsLoad` takes. */
export interface PrescriptionCells {
  sets: number;
  /** A single count, or a prescribed range like `"8–10"`. */
  reps: number | string;
  /** The formatted load, or `NO_VALUE` ("—") for an unset/discovery load — never a faked 0. */
  load: number | string;
  unit: MassUnit;
}

/**
 * The active PLANNED exercise's prescribed rep target, or null with no plan attached.
 *
 * `session.targetReps` cannot serve this on its own: it is sourced from the DEVICE's
 * `rep_count_reached` set watch (`adapter.ts` `resolveRepTarget`), so a fully planned
 * session whose set was armed without that watch reports null and the header's whole
 * lockup disappears — the coach's `4 × 8` is sitting unused in the prescription. Read from
 * the plan instead, via the list `panels/live-view.ts` already maps `repsLow`/`repsHigh`
 * into. `repsLabel` (not `targetReps`) so a prescribed RANGE stays a range — `8–10` is
 * what the coach wrote, and collapsing it to its floor would overstate the prescription.
 */
function plannedRepTarget(session: SessionModel): number | string | null {
  const active = session.plannedExercises.find((e) => e.active);
  // `targetReps` is `repsLow ?? null`, so a null one means `repsLabel` is the em-dash
  // placeholder rather than a real range — nothing prescribed, nothing to show.
  if (active === undefined || active.targetReps === null) return null;
  return active.repsLabel;
}

/**
 * The rep COUNT to size a strip column by — the same plan-first sourcing as
 * {@link plannedRepTarget}, but numeric.
 *
 * A prescribed RANGE collapses to its committed floor (`repsLow`): those are the reps the
 * set is definitely expected to carry. The reps between the floor and the range's top are
 * real but are not columns here — titan's `SetStripSet` has a `range` variant for exactly
 * that, and it needs `repsHigh` carried through the mapper as a number. Noted, not guessed.
 */
export function plannedRepCount(session: SessionModel): number | null {
  const active = session.plannedExercises.find((e) => e.active);
  return active?.targetReps ?? session.targetReps;
}

/**
 * Per-rep mean velocities → the ratio-of-best domain `velocityZoneColor` actually bands on.
 *
 * titan documents `SetStripSet.velocities` as a rep's "mean velocity ratio" and bands it at
 * `<0.5 / <0.75 / <1.0` with 1.0 the fastest. We were handing it raw m/s — a working set
 * runs ~0.4–0.8 m/s — so every rep of every real set landed in the slow/moderate bands and
 * the strip came out uniformly orange-red however the set actually went. The colour carried
 * no information.
 *
 * Normalized against the SET'S OWN best rep, the same basis {@link velocityLossPct} and the
 * fatigue verdict use ("the drop from the set's fastest rep to its last"). The strip
 * therefore reads as within-set decay: the best rep is green by construction and the bands
 * show how far each rep fell off it. It deliberately does NOT compare across sets — a grind
 * set and a snappy set both open green.
 *
 * A non-positive best means no usable velocity landed (a rep carrying no movement samples
 * reads 0). There is no honest ratio then, so the values pass through unscaled rather than
 * being divided by a fabricated denominator.
 */
export function velocityRatios(velocities: number[]): number[] {
  const best = Math.max(...velocities, 0);
  if (best <= 0) return velocities;
  return velocities.map((v) => v / best);
}

/**
 * The `sets × reps @ load` prescription for the active exercise, or null when the store
 * cannot state one.
 *
 * The COUNTS are the spine of the line: `4 × 8` is the claim, and neither half can be
 * faked, so a missing set or rep target hides the whole lockup rather than printing a
 * meaningless `0 × —`. The rep target prefers the PLAN ({@link plannedRepTarget}) over the
 * device's set watch: this line states what was PRESCRIBED, and the plan is the only
 * source that can express a range. The device watch stays as the fallback for an unplanned
 * session that was nonetheless armed with a rep goal (VW-41/42 wire the rest).
 *
 * The LOAD is prescribed-first for the same reason, falling back to the live cascade
 * weight. A planned exercise's target load is the number this line is claiming; the live
 * pin weight is the ACTUAL load and already has a home in the rail's progress summary, so
 * preferring the plan here stops the two cells saying the same thing and keeps the target
 * on screen when the cascade has not reported (it never does under the mock adapter).
 *
 * The load can still honestly be unknown, and `SetsRepsLoad` takes a string for exactly
 * that, so it reads `4 × 8 @ — lbs` rather than dropping a prescription the coach really
 * did write. Same placeholder as the rail's `summaryLoad`.
 */
export function derivePrescription(
  session: SessionModel,
  displayUnit: MassUnit = 'lbs',
): PrescriptionCells | null {
  const { plannedSets } = session;
  const reps = plannedRepTarget(session) ?? session.targetReps;
  if (plannedSets === null || reps === null) return null;
  const { weight, unit } = summaryLoad(prescribedLoadLbs(session), displayUnit);
  return { sets: plannedSets, reps, load: weight, unit };
}

/**
 * The load cell's source, prescribed-first: the active planned exercise's target load, else
 * the live cascade weight, else `null` for "genuinely unknown". Shared so the page header and
 * the rest recap cannot disagree about the same set's load.
 */
function prescribedLoadLbs(session: SessionModel): number | null {
  return session.plannedExercises.find((e) => e.active)?.weightLbs ?? session.weightLbs;
}

/**
 * The REST recap heading's `sets × reps @ load` cells (VMCP-03.05).
 *
 * Same prescribed-first sourcing as {@link derivePrescription}; the recap used to run its own
 * path (`formatMass(session.weightLbs ?? 0)`) and printed `2 × — @ 0 lbs` for a set whose plan
 * said `2 × 12–15 @ 45 lbs` — a fabricated zero where the plan had a real number.
 *
 * It differs from the header in ONE way: the recap always has a heading to draw (it renders
 * only once a set is logged), so a missing rep target or load degrades to `—` rather than
 * hiding the lockup. `sets` stays NUMERIC because titan's `SetsRepsLoadProps.sets` is `number`
 * — only `reps` and `load` accept a string placeholder — and the count is genuinely known
 * here: the prescribed total when planned, else the sets actually logged.
 */
export function deriveRecapPrescription(
  session: SessionModel,
  loggedSets: number,
  displayUnit: MassUnit = 'lbs',
): PrescriptionCells {
  const prescribed = derivePrescription(session, displayUnit);
  if (prescribed !== null) return prescribed;
  const { weight, unit } = summaryLoad(prescribedLoadLbs(session), displayUnit);
  return {
    sets: session.plannedSets ?? loggedSets,
    reps: plannedRepTarget(session) ?? session.targetReps ?? NO_VALUE,
    load: weight,
    unit,
  };
}

/**
 * The ACTIVE exercise's per-set strip columns: its OWN completed sets (filtered from the
 * session-wide log so a prior exercise's sets don't bleed in — VW-50), the set in progress,
 * and any remaining planned sets.
 *
 * Exported because TWO surfaces draw this strip — the rail's active row and the page-level
 * exercise header — and a second derivation would let them disagree about the same set.
 */
export function deriveActiveSetStates(model: DashboardModel): SessionRailExercise['setStates'] {
  const { session, live } = model;
  const setStates: SessionRailExercise['setStates'] = activeCompletedSets(session).map((set) => ({
    status: 'done',
    velocities: velocityRatios(set.reps),
  }));
  if (live) {
    // `planned` sizes the strip's columns. With no rep target, the honest column count
    // is the reps actually landed — i.e. no pending placeholders rather than invented ones.
    setStates.push({
      status: 'active',
      velocities: velocityRatios(live.repVelocities),
      planned: plannedRepCount(session) ?? live.repVelocities.length,
    });
  }
  // Any planned sets beyond those done + the one in progress. Skipped entirely without a
  // rep target: a `todo` set must state how many reps it expects, and we would be guessing.
  const accountedFor = setStates.length;
  const targetReps = plannedRepCount(session);
  const remaining = session.plannedSets !== null ? session.plannedSets - accountedFor : 0;
  if (targetReps !== null) {
    for (let i = 0; i < remaining; i++) {
      setStates.push({ status: 'todo', planned: targetReps });
    }
  }
  return setStates;
}

/**
 * The rail row for the ACTIVE exercise: {@link deriveActiveSetStates}' strip plus the
 * row's own name / prescribed-set / progress-summary cells.
 *
 * `weight` shows the live value, or `—` when no weight is set yet (never a faked 0).
 * On real hardware it is the live cascade value.
 */
function buildActiveRow(model: DashboardModel, displayUnit: MassUnit): SessionRailExercise {
  const { session, live } = model;
  const done = activeCompletedSets(session);

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
      // Working sets only (VW-260) — the live overlay carries no purpose of its own yet, so
      // an in-progress set still counts unconditionally, same as before.
      sets: selectWorkingSets(done).length + (live ? 1 : 0),
      reps: bestRepsSoFar(done, live) ?? NO_VALUE,
      ...summaryLoad(session.weightLbs, displayUnit),
    },
    ...(session.tempo ? { tempo: session.tempo } : {}),
    indicator: 'velocity-loss',
    setStates: deriveActiveSetStates(model),
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
    setStates: logged.map((set) => ({ status: 'done', velocities: velocityRatios(set.reps) })),
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

/**
 * A completed set's verdict against its OWN exercise's planned rep floor — the
 * same rule `report.session_results`' "missed: X of Y" line uses
 * (`analytics/target-verdict.ts`), so the wall and the report can never
 * disagree about the same set. Matched by exercise name, the same key
 * {@link activeCompletedSets} already filters on. `no-target` when the exercise
 * carries no rep floor (no plan attached, or an untargeted/AMRAP exercise).
 */
export function completedSetVerdict(set: CompletedSet, session: SessionModel): TargetVerdict {
  const planned = session.plannedExercises.find((e) => e.name === set.exerciseName);
  return targetVerdict(set.repCount, planned?.targetReps ?? undefined);
}

/**
 * A "Missed: N" rail-header tile for sets that missed their rep floor this
 * session, meant to be appended to {@link deriveRailMetrics}'s Volume/Tonnage
 * rollup rather than replacing it. Null when nothing has a floor to miss, or
 * nothing missed — never a fabricated zero.
 */
export function deriveMissedSetsMetric(model: DashboardModel): MetricTileData | null {
  const missed = model.session.completedSets.filter(
    (set) => completedSetVerdict(set, model.session) === 'miss',
  ).length;
  return missed > 0 ? { label: 'Missed', value: String(missed) } : null;
}

/**
 * The rail's pace footer tiles (VW-290): how many planned sets are left and when
 * the plan projects the session to end. Empty without a `sessionPace` — a session
 * with no attached plan shows no footer at all rather than a guessed finish time.
 *
 * The planned/elapsed MINUTES of the same estimate are not tiles: they go to the
 * rail's own `elapsedMs` / `budgetMs`, which draw the header clock and its pace
 * marker. Two tiles keep the row readable at the rail's width.
 */
export function derivePaceMetrics(pace: SessionPaceView | null): MetricTileData[] {
  if (pace === null) return [];
  return [
    {
      label: 'Left',
      value: `${pace.plannedSetsRemaining} ${pluralSets(pace.plannedSetsRemaining)}`,
    },
    { label: 'ETA', value: formatClockTime(pace.projectedEndAt) },
  ];
}

function pluralSets(count: number): string {
  return count === 1 ? 'set' : 'sets';
}

/** An ISO timestamp as the wall clock reads it, e.g. `"6:42 PM"`. */
function formatClockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
