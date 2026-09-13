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
   * "sets done" figure uses (VW-260).
   */
  completedWorkingSets: number;
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

  const done = Math.max(0, Math.trunc(input.completedWorkingSets));
  return {
    plannedMinutes: toMinutes(remainingSeconds(costs, 0)),
    elapsedMinutes: toMinutes(Math.max(0, input.nowMs - startedMs) / 1000),
    plannedSetsRemaining: Math.max(0, costs.length - done),
    projectedEndAt: new Date(input.nowMs + remainingSeconds(costs, done) * 1000).toISOString(),
  };
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
      const cost: PlannedSetCost = {
        workSeconds: setWorkSeconds(row, catalog),
        restSeconds: row.restSec ?? defaultRestSeconds(row.trainingIntent),
      };
      const sets = Math.max(0, Math.trunc(row.targetSets));
      return Array.from({ length: sets }, () => cost);
    });
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
