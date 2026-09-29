// Pure read-model for the session's pace against its attached plan (VW-290).
//
// `buildSessionPaceView` answers the one question the rail footer asks: given
// what this workout PLANS (exercises x sets, each set's own work and rest) and
// what the lifter has already logged, how long should the whole thing take, how
// far in are we, how many sets are left, and when does it end?
//
// It performs NO I/O and reads no clock: the caller passes `nowMs`, so the same
// inputs always produce the same output and the model is testable without fake
// timers. The caller (`dashboard/server.ts` for the snapshot, `session.get` for
// the tool result) owns the store reads; this module owns the arithmetic.
//
// Every number here is an ESTIMATE from the plan, never a measurement. A session
// with no attached plan has nothing to estimate from and yields `null` rather
// than a fabricated budget — the rail footer then stays hidden.
//
// Confidentiality: plan metadata and clock values only — no protocol data (NF-07).

import { defaultRestSeconds } from '../../analytics/rest-defaults.js';
import { resolveTargetTempo } from '../tempo-defaults.js';
import type { StoredPlannedExercise } from '../../store/types.js';
import type { ExerciseCatalogLookup } from './session-plan.js';

/**
 * Work time for a planned set whose tempo or rep target does not resolve — a
 * plain stand-in for "one working set", not a training recommendation. Sits
 * near the middle of the range the tempo path produces for a real prescription
 * (8 reps at a 3-0-1-0 push tempo is 32 s; 12 at 2-0-2-1 is 60 s).
 */
export const DEFAULT_SET_WORK_SECONDS = 40;

/** Slip inside this many seconds reads as on pace, however short the plan (VMCP-02.76). */
export const PACE_TOLERANCE_FLOOR_SECONDS = 120;

/** Slip inside this share of the planned session reads as on pace, when it beats the floor. */
export const PACE_TOLERANCE_FRACTION = 0.05;

/**
 * Where the session stands against its plan. `idle` means no working set is
 * logged and none is streaming: the clock since `session.start` is setup time,
 * not a pace signal, so idle is never reported as behind.
 */
export type PaceState = 'ahead' | 'on_pace' | 'behind' | 'idle';

/** Most sets an `add` suggestion offers at once. */
export const PACE_ADD_MAX_SETS = 2;

/** One logged working set, as far as pace needs it. */
export interface CompletedWorkingSet {
  exerciseId?: string | undefined;
  /** When the set ended, ms since epoch. */
  endedAtMs: number;
}

/** Sets to drop from one planned exercise so the session ends nearer its plan. */
export interface PaceTrimCut {
  exerciseId: string;
  fromSets: number;
  toSets: number;
}

/**
 * What to change to bring the session back to its plan. Ids and numbers only:
 * the consumer resolves names and writes the sentence.
 */
export type PaceSuggestion =
  | { kind: 'trim'; cuts: PaceTrimCut[]; savesMinutes: number; coversSlip: boolean }
  | { kind: 'add'; exerciseId: string; sets: number; costsMinutes: number };

/** The session's pace against its plan. Every field is plan-derived, never measured. */
export interface SessionPaceView {
  /** Estimated total session length, minutes: every planned set's work plus its rest. */
  plannedMinutes: number;
  /** Minutes since `session.start`. Never negative. */
  elapsedMinutes: number;
  /** Planned sets not yet logged as working sets. Zero once the plan is met or exceeded. */
  plannedSetsRemaining: number;
  /** ISO timestamp the remaining planned sets project the session to end at. */
  projectedEndAt: string;
  /** Ahead of, on, or behind the plan's cadence; `idle` before the first set. */
  state: PaceState;
  /** Signed delay against the plan, minutes: positive is behind, negative ahead, 0 when idle. */
  slipMinutes: number;
  /** Trim or add offer for the state; absent when there is nothing to suggest. */
  suggestion?: PaceSuggestion;
}

/** Everything `buildSessionPaceView` needs, already resolved out of the store. */
export interface SessionPaceInput {
  /** The session's `startedAt` (ISO) — the elapsed clock's origin. */
  startedAt: string;
  /** Injected clock, ms since epoch. The model never reads `Date.now()` itself. */
  nowMs: number;
  /** Every planned exercise attached to the session, unsorted. Empty ⇒ no pace. */
  planned: readonly StoredPlannedExercise[];
  /**
   * Working sets already logged this session. Warm-up / probe / technique sets
   * are real and logged but do not advance the plan, the same rule the rail's
   * "sets done" figure uses (VW-260). The count is the list's length.
   */
  completedWorkingSets: readonly CompletedWorkingSet[];
  /** A set is streaming right now, so any rest before it is over. */
  liveSetActive: boolean;
}

/** One planned set's estimated cost: the lift itself, then the rest after it. */
interface PlannedSetCost {
  workSeconds: number;
  restSeconds: number;
}

/**
 * Estimate the session's pace, or `null` when there is nothing to estimate from
 * (no planned exercises, or an unparseable `startedAt`).
 *
 * The estimate walks the plan in `orderIndex` order and costs each set at its
 * own exercise's work time plus its own prescribed rest — VW-297's
 * goal-keyed {@link defaultRestSeconds} when the coach set none, so a strength
 * block is not paced as if it rested like a hypertrophy one. The final set's
 * rest is excluded: the session ends when the last rep is done, not a rest later.
 */
export function buildSessionPaceView(
  input: SessionPaceInput,
  catalog: ExerciseCatalogLookup | undefined,
): SessionPaceView | null {
  const startedMs = Date.parse(input.startedAt);
  if (!Number.isFinite(startedMs)) return null;
  const costs = plannedSetCosts(input.planned, catalog);
  if (costs.length === 0) return null;

  const done = input.completedWorkingSets.length;
  const plannedSeconds = remainingSeconds(costs, 0);
  const idle = done === 0 && !input.liveSetActive;
  const slipSeconds = idle ? 0 : computeSlipSeconds(input, startedMs, costs);
  const state = classifyPace(slipSeconds, plannedSeconds, idle);
  const suggestion = suggestPaceAdjustment(
    state,
    slipSeconds,
    input.planned,
    input.completedWorkingSets,
    catalog,
  );
  return {
    plannedMinutes: toMinutes(plannedSeconds),
    elapsedMinutes: toMinutes(Math.max(0, input.nowMs - startedMs) / 1000),
    plannedSetsRemaining: Math.max(0, costs.length - done),
    projectedEndAt: new Date(input.nowMs + remainingSeconds(costs, done) * 1000).toISOString(),
    state,
    slipMinutes: toSignedMinutes(slipSeconds),
    ...(suggestion !== null && { suggestion }),
  };
}

/**
 * Seconds the session runs behind its plan (negative when ahead): how late the
 * last working set ended against the plan's cadence, plus any rest taken beyond
 * the rest that set owed. Rest inside the owed rest is not slip, so a lifter 20 s
 * into a 90 s rest does not read as ahead. A streaming set means the rest is
 * over; once the plan is met there is no next set to rest for.
 */
function computeSlipSeconds(
  input: SessionPaceInput,
  startedMs: number,
  costs: readonly PlannedSetCost[],
): number {
  const done = Math.min(input.completedWorkingSets.length, costs.length);
  const endedAts = input.completedWorkingSets
    .map((set) => set.endedAtMs)
    .filter((ms) => Number.isFinite(ms));
  const lastEndedMs = endedAts.length > 0 ? Math.max(...endedAts) : startedMs;
  const plannedThroughLast = remainingSeconds(costs.slice(0, done), 0);
  const lateness = (lastEndedMs - startedMs) / 1000 - plannedThroughLast;
  if (input.liveSetActive || done === 0 || done >= costs.length) return lateness;
  const restTaken = Math.max(0, input.nowMs - lastEndedMs) / 1000;
  return lateness + Math.max(0, restTaken - costs[done - 1]!.restSeconds);
}

/**
 * The pace state for a slip. Slip within the tolerance, the larger of
 * {@link PACE_TOLERANCE_FLOOR_SECONDS} and {@link PACE_TOLERANCE_FRACTION} of the
 * planned session, is on pace; exactly the tolerance still is.
 */
export function classifyPace(
  slipSeconds: number,
  plannedSeconds: number,
  idle: boolean,
): PaceState {
  if (idle) return 'idle';
  const tolerance = Math.max(
    PACE_TOLERANCE_FLOOR_SECONDS,
    PACE_TOLERANCE_FRACTION * plannedSeconds,
  );
  if (slipSeconds > tolerance) return 'behind';
  if (slipSeconds < -tolerance) return 'ahead';
  return 'on_pace';
}

/**
 * Every planned set the session owes, in plan order, each with its own work and
 * rest cost. One entry per set, so a caller can drop the sets already done and
 * sum what is left without re-deriving which exercise it is on.
 */
function plannedSetCosts(
  planned: readonly StoredPlannedExercise[],
  catalog: ExerciseCatalogLookup | undefined,
): PlannedSetCost[] {
  return [...planned]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .flatMap((row) => {
      const cost = rowSetCost(row, catalog);
      const sets = Math.max(0, Math.trunc(row.targetSets));
      return Array.from({ length: sets }, () => cost);
    });
}

function rowSetCost(
  row: StoredPlannedExercise,
  catalog: ExerciseCatalogLookup | undefined,
): PlannedSetCost {
  return {
    workSeconds: setWorkSeconds(row, catalog),
    restSeconds: row.restSec ?? defaultRestSeconds(row.trainingIntent),
  };
}

/**
 * How long one set of this exercise takes: its rep target at its target tempo.
 * Falls back to {@link DEFAULT_SET_WORK_SECONDS} when either is unknown —
 * a `carry` has no rep tempo, and an AMRAP set has no rep count.
 */
function setWorkSeconds(
  row: StoredPlannedExercise,
  catalog: ExerciseCatalogLookup | undefined,
): number {
  const coachTempo = row.targetTempo;
  const tempo = resolveTargetTempo(
    row.exerciseId,
    coachTempo !== undefined
      ? [coachTempo.ecc, coachTempo.pauseBottom, coachTempo.con, coachTempo.pauseTop]
      : undefined,
    catalog?.getById(row.exerciseId)?.movementPattern,
  );
  const reps = row.targetRepsHigh ?? row.targetRepsLow;
  if (tempo === null || reps === undefined) return DEFAULT_SET_WORK_SECONDS;
  return reps * (tempo[0] + tempo[1] + tempo[2] + tempo[3]);
}

/**
 * Seconds of plan left from set `from` onward, excluding the trailing rest after
 * the last set. Zero once every planned set is done.
 */
function remainingSeconds(costs: readonly PlannedSetCost[], from: number): number {
  if (from >= costs.length) return 0;
  const rest = costs.slice(from);
  const total = rest.reduce((sum, cost) => sum + cost.workSeconds + cost.restSeconds, 0);
  return total - rest[rest.length - 1]!.restSeconds;
}

function toMinutes(seconds: number): number {
  return Math.round(seconds / 60);
}

/** Rounds half away from zero, so a slip reads the same magnitude either side, and never -0. */
function toSignedMinutes(seconds: number): number {
  return Math.sign(seconds) * Math.round(Math.abs(seconds) / 60) + 0;
}

/** One planned exercise with what the lifter has and has not done of it. */
interface ExerciseProgress {
  exerciseId: string;
  targetSets: number;
  loggedSets: number;
  setSeconds: number;
}

/**
 * Trim or add sets to move the session toward its plan, or `null` when the state
 * is not behind or ahead or nothing is left to change. Behind trims from the last
 * exercise backward, one set at a time, never below one set and never the
 * exercise in progress. Ahead adds up to {@link PACE_ADD_MAX_SETS} sets to the
 * exercise in progress, else the next one with sets left, while they fit the
 * headroom. Sets logged with no `exerciseId` count toward the plan total but are
 * never attributed to an exercise.
 */
export function suggestPaceAdjustment(
  state: PaceState,
  slipSeconds: number,
  planned: readonly StoredPlannedExercise[],
  completed: readonly CompletedWorkingSet[],
  catalog: ExerciseCatalogLookup | undefined,
): PaceSuggestion | null {
  if (state !== 'behind' && state !== 'ahead') return null;
  const totalSets = planned.reduce((sum, row) => sum + Math.max(0, Math.trunc(row.targetSets)), 0);
  if (totalSets - completed.length <= 0) return null;
  const progress = exerciseProgress(planned, completed, catalog);
  const current = inProgressExerciseId(completed);
  return state === 'behind'
    ? suggestTrim(slipSeconds, progress, current)
    : suggestAdd(-slipSeconds, progress, current);
}

function exerciseProgress(
  planned: readonly StoredPlannedExercise[],
  completed: readonly CompletedWorkingSet[],
  catalog: ExerciseCatalogLookup | undefined,
): ExerciseProgress[] {
  const unattributed = new Map<string, number>();
  for (const set of completed) {
    if (set.exerciseId === undefined) continue;
    unattributed.set(set.exerciseId, (unattributed.get(set.exerciseId) ?? 0) + 1);
  }
  return [...planned]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((row) => {
      const targetSets = Math.max(0, Math.trunc(row.targetSets));
      const loggedSets = Math.min(targetSets, unattributed.get(row.exerciseId) ?? 0);
      unattributed.set(row.exerciseId, (unattributed.get(row.exerciseId) ?? 0) - loggedSets);
      const cost = rowSetCost(row, catalog);
      return {
        exerciseId: row.exerciseId,
        targetSets,
        loggedSets,
        setSeconds: cost.workSeconds + cost.restSeconds,
      };
    });
}

/** The exercise of the most recently ended logged set that names one. */
function inProgressExerciseId(completed: readonly CompletedWorkingSet[]): string | undefined {
  let latest: CompletedWorkingSet | undefined;
  for (const set of completed) {
    if (set.exerciseId === undefined) continue;
    if (latest === undefined || set.endedAtMs >= latest.endedAtMs) latest = set;
  }
  return latest?.exerciseId;
}

function suggestTrim(
  slipSeconds: number,
  progress: readonly ExerciseProgress[],
  current: string | undefined,
): PaceSuggestion | null {
  const cuts: PaceTrimCut[] = [];
  let saved = 0;
  for (const exercise of [...progress].reverse()) {
    if (saved >= slipSeconds) break;
    if (exercise.exerciseId === current) continue;
    const floor = Math.max(1, exercise.loggedSets);
    let toSets = exercise.targetSets;
    while (toSets > floor && saved < slipSeconds) {
      toSets -= 1;
      saved += exercise.setSeconds;
    }
    if (toSets < exercise.targetSets) {
      cuts.push({ exerciseId: exercise.exerciseId, fromSets: exercise.targetSets, toSets });
    }
  }
  if (cuts.length === 0) return null;
  return { kind: 'trim', cuts, savesMinutes: toMinutes(saved), coversSlip: saved >= slipSeconds };
}

function suggestAdd(
  headroomSeconds: number,
  progress: readonly ExerciseProgress[],
  current: string | undefined,
): PaceSuggestion | null {
  const target =
    progress.find((exercise) => exercise.exerciseId === current) ??
    progress.find((exercise) => exercise.targetSets > exercise.loggedSets);
  if (target === undefined || target.setSeconds <= 0) return null;
  const sets = Math.min(PACE_ADD_MAX_SETS, Math.floor(headroomSeconds / target.setSeconds));
  if (sets < 1) return null;
  return {
    kind: 'add',
    exerciseId: target.exerciseId,
    sets,
    costsMinutes: toMinutes(sets * target.setSeconds),
  };
}
