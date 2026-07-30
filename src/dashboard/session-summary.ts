// Session-completion read-model for the dashboard (VW-120).
//
// After a session ends, the dashboard shows one card per exercise TOUCHED in
// that session — VW-114's `session.set_exercise` means a session routinely
// spans several — carrying the exercise's VBT summary and a load-progression
// recommendation.
//
// ── Where the numbers come from ───────────────────────────────────────────
//
//   * VBT: `@voltras/workout-analytics`'s `getSetVelocitySummary` /
//     `getSetFatigueSummary` / `getSetFatigueVerdict`, adapted from `StoredSet`
//     exactly the way `tools/metrics-tools.ts` does (`{ reps }`, no rep math here).
//   * Progression: `computeProgressionDelta`, imported from `tools/plan-tools.ts`
//     — the SAME function `plan.suggest_progression` runs. The heuristic is not
//     re-implemented; this module only resolves its three inputs (the planned
//     row, the exercise's sets, the basis session id).
//
// ── Grouping ──────────────────────────────────────────────────────────────
//
// Sets are grouped by each set's OWN `exerciseId` via `scopeSessionSetsToExercise`,
// which withdraws the "keep an unattributed set" leniency once a session is known
// to hold more than one exercise — so a set with no exercise recorded is never
// double-counted across two cards. Sets with no exercise in a session that has no
// exercise at all collapse into a single unattributed group rather than vanishing.
//
// Confidentiality: fitness units and plan metadata only — no protocol data (NF-07).

import {
  getSetFatigueSummary,
  getSetFatigueVerdict,
  getSetVelocitySummary,
  type Set as AnalyticsSet,
} from '@voltras/workout-analytics';

import { computeProgressionDelta } from '../tools/plan-tools.js';
import { scopeSessionSetsToExerciseId } from '../store/set-scope.js';
import type { DashboardPlanStore } from './plan-api.js';
import type { ExerciseNameLookup } from './read-models/index.js';
import type {
  SessionSummaryExercise,
  SessionSummaryProgression,
  SessionSummarySet,
  SessionSummaryView,
} from './read-models/session-summary-view.js';
import type { StoredPlannedExercise, StoredSession, StoredSet } from '../store/types.js';

export type {
  SessionSummaryExercise,
  SessionSummaryProgression,
  SessionSummarySet,
  SessionSummaryView,
};

/** The `SessionStore` slice the summary needs beyond the planning methods. */
export interface DashboardSessionStore {
  getSession(id: string): Promise<StoredSession | undefined>;
  getSetsForSession(sessionId: string): Promise<StoredSet[]>;
  listSessions(filter: {
    sort: 'startedAt:desc' | 'startedAt:asc';
    limit: number;
    offset: number;
    exerciseId?: string;
  }): Promise<StoredSession[]>;
}

/** Label for the group holding sets that recorded no exercise. */
const UNATTRIBUTED_LABEL = 'Unattributed';

function toAnalyticsSet(stored: StoredSet): AnalyticsSet {
  return { reps: stored.reps };
}

/**
 * Resolve the session the summary is for. `'latest'` picks the most recently
 * started session — the demo's "I just finished, show me the screen" path, so
 * the client never has to know a session id. Returns undefined when nothing matches.
 */
export async function resolveSummarySessionId(
  store: DashboardSessionStore,
  requested: string,
): Promise<string | undefined> {
  if (requested !== 'latest') {
    return (await store.getSession(requested)) === undefined ? undefined : requested;
  }
  const [latest] = await store.listSessions({ sort: 'startedAt:desc', limit: 1, offset: 0 });
  return latest?.id;
}

/**
 * Build the completion screen for one session: every exercise it touched, that
 * exercise's VBT rollup, and its progression recommendation.
 */
export async function buildSessionSummary(
  deps: { store: DashboardSessionStore & DashboardPlanStore; nameOf: ExerciseNameLookup },
  sessionId: string,
): Promise<SessionSummaryView | undefined> {
  const { store, nameOf } = deps;
  const session = await store.getSession(sessionId);
  if (session === undefined) return undefined;

  const allSets = await store.getSetsForSession(sessionId);
  const program = (await store.listTrainingPrograms({ includeArchived: false }))[0];

  const exercises: SessionSummaryExercise[] = [];
  for (const exerciseId of groupExerciseIds(allSets, session.exerciseId)) {
    const sets = exerciseId === null ? allSets : scopeSessionSetsToExerciseId(allSets, exerciseId);
    exercises.push(
      await buildExerciseSummary(
        { store, nameOf },
        { exerciseId, sets, sessionId, programId: program?.id },
      ),
    );
  }

  return {
    session: {
      id: session.id,
      startedAt: session.startedAt,
      endedAt: session.endedAt ?? null,
      exerciseId: session.exerciseId ?? null,
      exerciseName:
        session.exerciseId === undefined
          ? null
          : (nameOf(session.exerciseId) ?? session.exerciseId),
    },
    exercises,
  };
}

/**
 * The exercises a session touched, in first-set order. Falls back to the
 * session's own exercise when no set recorded one, and to a single `null`
 * (unattributed) group when neither does — never an empty screen for a session
 * that has sets.
 */
function groupExerciseIds(
  sets: readonly StoredSet[],
  sessionExerciseId: string | undefined,
): (string | null)[] {
  const seen: string[] = [];
  for (const set of sets) {
    if (set.exerciseId !== undefined && !seen.includes(set.exerciseId)) seen.push(set.exerciseId);
  }
  if (seen.length > 0) return seen;
  if (sessionExerciseId !== undefined) return [sessionExerciseId];
  return sets.length > 0 ? [null] : [];
}

async function buildExerciseSummary(
  deps: { store: DashboardSessionStore & DashboardPlanStore; nameOf: ExerciseNameLookup },
  args: {
    exerciseId: string | null;
    sets: StoredSet[];
    sessionId: string;
    programId: string | undefined;
  },
): Promise<SessionSummaryExercise> {
  const { exerciseId, sets, sessionId, programId } = args;
  const setViews = sets.map(toSetView);
  const working = sets.filter((s) => s.isWarmup !== true);
  const lastWorking = working[working.length - 1];
  const weights = sets.map((s) => s.weightLbs).filter((w): w is number => w !== undefined);
  const bestVelocities = setViews
    .map((s) => s.bestRepVelocity)
    .filter((v): v is number => v !== null);
  const losses = setViews.map((s) => s.velocityLossPct).filter((v): v is number => v !== null);

  const { progression, progressionNote } = await resolveProgression(deps.store, {
    exerciseId,
    sets,
    sessionId,
    programId,
  });

  return {
    exerciseId,
    name: exerciseId === null ? UNATTRIBUTED_LABEL : (deps.nameOf(exerciseId) ?? exerciseId),
    setCount: sets.length,
    workingSetCount: working.length,
    totalReps: sets.reduce((sum, s) => sum + s.reps.length, 0),
    // Null, not 0, when NO set recorded a load: tonnage is unknowable then, and
    // `0 lb` on the card reads like a measured value (the exact sentinel schema
    // v6 removed from `StoredSet.weightLbs`). Sets that individually lack a
    // weight still contribute nothing, which is the honest floor.
    volumeLbs:
      weights.length === 0
        ? null
        : sets.reduce((sum, s) => sum + (s.weightLbs ?? 0) * s.reps.length, 0),
    topWeightLbs: weights.length > 0 ? Math.max(...weights) : null,
    bestRepVelocity: bestVelocities.length > 0 ? Math.max(...bestVelocities) : null,
    maxVelocityLossPct: losses.length > 0 ? Math.max(...losses) : null,
    verdict: lastWorking === undefined ? null : getSetFatigueVerdict(toAnalyticsSet(lastWorking)),
    fatigue: lastWorking === undefined ? null : getSetFatigueSummary(toAnalyticsSet(lastWorking)),
    sets: setViews,
    progression,
    progressionNote,
  };
}

function toSetView(set: StoredSet, index: number): SessionSummarySet {
  const velocity = getSetVelocitySummary(toAnalyticsSet(set));
  return {
    id: set.id,
    index: set.setIndexInSession ?? index + 1,
    startedAt: set.startedAt,
    endedAt: set.endedAt,
    weightLbs: set.weightLbs ?? null,
    repCount: set.reps.length,
    isWarmup: set.isWarmup === true,
    velocityLossPct: velocity.lossPct ?? null,
    bestRepVelocity: velocity.best ?? null,
  };
}

/**
 * Score this exercise's sets against its planned row using the SAME heuristic
 * `plan.suggest_progression` runs. The basis session is the one being summarised
 * — the point of the screen is "given what you just did, what next time?" — so
 * unlike the MCP tool there is no most-recent-session lookup to do.
 */
async function resolveProgression(
  store: DashboardPlanStore,
  args: {
    exerciseId: string | null;
    sets: StoredSet[];
    sessionId: string;
    programId: string | undefined;
  },
): Promise<{ progression: SessionSummaryProgression | null; progressionNote: string | null }> {
  if (args.exerciseId === null) {
    return {
      progression: null,
      progressionNote: 'Sets recorded no exercise; nothing to progress.',
    };
  }
  if (args.programId === undefined) {
    return {
      progression: null,
      progressionNote:
        'No active training program — create one to get progression recommendations.',
    };
  }
  const planned = await findPlannedExercise(store, args.programId, args.exerciseId);
  if (planned === undefined) {
    return {
      progression: null,
      progressionNote: `"${args.exerciseId}" is not prescribed in the current program.`,
    };
  }
  const suggestion = computeProgressionDelta(planned, args.sets, args.sessionId);
  return {
    progression: {
      delta: suggestion.delta,
      reasoning: suggestion.reasoning,
      basedOnSessionId: suggestion.basedOnSessionId,
      targetSets: planned.targetSets,
      targetRepsLow: planned.targetRepsLow ?? null,
      targetRepsHigh: planned.targetRepsHigh ?? null,
      targetWeightLbs: planned.targetWeightLbs ?? null,
    },
    progressionNote: null,
  };
}

/**
 * Walk a program's blocks → weeks → templates for the first planned row naming
 * `exerciseId`. Mirrors `findPlannedExerciseInProgram` in `plan-tools.ts`, over
 * the narrow dashboard store slice instead of `ServerState`.
 */
async function findPlannedExercise(
  store: DashboardPlanStore,
  programId: string,
  exerciseId: string,
): Promise<StoredPlannedExercise | undefined> {
  for (const block of await store.getTrainingBlocksForProgram(programId)) {
    for (const week of await store.getTrainingWeeksForBlock(block.id)) {
      for (const template of await store.getWorkoutTemplatesForWeek(week.id)) {
        const planned = await store.getPlannedExercisesForTemplate(template.id);
        const match = planned.find((p) => p.exerciseId === exerciseId);
        if (match !== undefined) return match;
      }
    }
  }
  return undefined;
}
