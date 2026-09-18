// The committed definition behind `npm run dashboard:preview` (VW-416).
//
// The wall dashboard only ever existed inside a running PT session's server, so
// looking at a page meant owning a Voltra and starting a workout. This module is
// the other half of `scripts/dashboard-preview.mjs`: the page list, and — for
// `#/goals` — the store seed that lands the goal read model in a chosen state.
//
// WHY `#/goals` IS SEEDED RATHER THAN DRIVEN. Every other preview page reuses a
// capture scenario, which drives the real MCP pipeline against the mock adapter
// (`src/docs/capture-shots.ts`). A driven run can only ever produce the state it
// produces: the capture's own goals scenario lands on `calibrating`, because a
// band derived with no baseline past SHAPE_ONLY is the execution ramp by
// construction (`analytics/goal-band.ts`, `earnedInfoLevel`). Every other status
// needs history that a no-hardware run cannot perform in the time it takes to
// look at a page. So the readings are written through the store's own
// `putSession` / `putSet` — recorded outcomes, never fabricated telemetry — and
// the band, the status and the trajectory chart on top of them are the real
// ones, re-derived by the same `deriveTarget` the MCP tools run.
//
// WHAT EACH STATE IS. `expectedStatus` is the verdict the read model must reach,
// pinned by `src/dashboard/__tests__/preview-seeds.test.ts`. `hit_exact` lands
// `goal_met` and `beyond_goal` lands `beyond_goal` (VW-400); the test also pins
// where each newest reading sits against the committed number, so a seed that
// stopped reaching it would fail rather than quietly preview a page that no
// longer shows what its name says.
//
// Confidentiality: exercise ids, loads, rep counts and velocities only —
// derived fitness metadata, no protocol data of any kind (NF-07).

import { EMPTY_PHASE } from '@voltras/workout-analytics';

import { blockEndsAt } from '../analytics/goal-block-weeks.js';
import type { GoalProgressStatus } from '../dashboard/read-models/index.js';
import { startOfCalendarWeekIso } from '../dashboard/read-models/muscle-set-scope.js';
import {
  LOCAL_USER_ID,
  type SessionStore,
  type StoredRep,
  type StoredSet,
} from '../store/types.js';
import type { CaptureScenarioName } from './capture-shots.js';

/** The pages `npm run dashboard:preview -- <page>` can open. */
export type PreviewPageName = 'goals' | 'body' | 'plan';

export interface PreviewPage {
  readonly name: PreviewPageName;
  /** Path plus hash route, relative to the dashboard origin. */
  readonly route: string;
  /**
   * The capture scenario whose driver and args this page reuses, or `null` for
   * `#/goals`, which seeds the store itself (see this file's header).
   */
  readonly captureScenario: CaptureScenarioName | null;
  readonly summary: string;
}

export const PREVIEW_PAGES: readonly PreviewPage[] = [
  {
    name: 'goals',
    route: '/app#/goals',
    captureScenario: null,
    summary: 'The goal coach: a declared priority, its committed/stretch band and the trajectory.',
  },
  {
    name: 'body',
    route: '/app#/body',
    captureScenario: 'body',
    summary: "A training week's volume per muscle, what is due next, and recent PRs.",
  },
  {
    name: 'plan',
    route: '/app#/plan',
    captureScenario: 'planned',
    summary: 'The plan builder over a seeded workout template and the exercise catalog.',
  },
];

/** The lift every goal preview is declared on. A catalog id, so the page resolves a name. */
export const GOAL_PREVIEW_EXERCISE = {
  id: 'cable-chest-press',
  name: 'Cable Chest Press',
} as const;

/** The rep anchor the target is measured at — `top_load_at_reps`' own question. */
export const GOAL_PREVIEW_ANCHOR_REPS = 8;

/** Weeks in the previewed mesocycle horizon. */
export const GOAL_PREVIEW_HORIZON_WEEKS = 8;

/** Working sets per seeded session. Three is over `minShapeSets`, so the baseline establishes. */
const SETS_PER_SESSION = 3;

export type GoalPreviewStateName =
  | 'calibrating'
  | 'on_track'
  | 'fast_climb'
  | 'behind'
  | 'ahead'
  | 'hit_exact'
  | 'beyond_goal';

export interface GoalPreviewState {
  readonly name: GoalPreviewStateName;
  /** The status `buildGoalProgressView` must reach over this seed. Pinned by the test. */
  readonly expectedStatus: GoalProgressStatus;
  readonly summary: string;
  /**
   * One session per ISO week, oldest first, each `SETS_PER_SESSION` working
   * sets at that load for {@link GOAL_PREVIEW_ANCHOR_REPS} reps. Weekly steps
   * are wide on purpose: `history.trend`'s plateau detector calls a run inside
   * 5% of its median a flatline, and a flatline reads `stalled` before any of
   * these rules get a say.
   */
  readonly weeklyLoadsLbs: readonly number[];
  /**
   * A heavier set at FEWER than the anchor's reps in the newest session. It
   * raises `history.trend`'s weekly top load (which reads every working set)
   * without moving the band's start value (which reads only sets at the
   * anchor), and that gap is the only way a reading lands past the stretch edge.
   */
  readonly heavySingleLbs?: number;
  /**
   * How many weeks before the newest session the target was measured, which is
   * what puts `now` in a meso week. Dated by {@link seededAt}, like the sessions.
   * The target's start value is that week's load: the band is anchored there (VW-449).
   */
  readonly targetStartWeeksAgo: number;
  readonly committedLbs: number;
  readonly stretchLbs: number;
  /**
   * Stored as `goal.propose_targets` stores a target derived before
   * calibration: the execution ramp at `cold`, committed equal to stretch.
   */
  readonly acceptedCold?: boolean;
}

export const GOAL_PREVIEW_STATES: readonly GoalPreviewState[] = [
  {
    name: 'calibrating',
    expectedStatus: 'calibrating',
    summary: 'One session on record: too little history for a gain band, so the ramp stands in.',
    weeklyLoadsLbs: [100],
    targetStartWeeksAgo: 4,
    committedLbs: 110,
    stretchLbs: 110,
    acceptedCold: true,
  },
  {
    name: 'on_track',
    expectedStatus: 'on_track',
    summary: 'Top loads rising from 100 through a lighter week 3, inside the band anchored at 100.',
    // Inside a band anchored at its start (VW-449) the programmed ramp adds
    // about 2.5% a week, and three weekly readings that close together are
    // what `history.trend`'s plateau detector calls a flatline. The lighter
    // week 3 keeps the run wider than that without leaving the band.
    weeklyLoadsLbs: [100, 103, 97, 104, 108],
    targetStartWeeksAgo: 4,
    committedLbs: 110,
    stretchLbs: 120,
  },
  {
    name: 'fast_climb',
    expectedStatus: 'ahead',
    summary:
      'Five weeks climbing 100 to 146, far faster than the programmed ramp: ahead of a band ' +
      'anchored where the goal began (VW-449; this read on_track while the band restarted at ' +
      'the latest lift).',
    weeklyLoadsLbs: [100, 110, 121, 133, 146],
    targetStartWeeksAgo: 4,
    committedLbs: 160,
    stretchLbs: 175,
  },
  {
    name: 'behind',
    expectedStatus: 'behind',
    summary: 'The same five weeks run backwards: under the committed edge with a falling trend.',
    weeklyLoadsLbs: [146, 133, 121, 110, 100],
    targetStartWeeksAgo: 4,
    committedLbs: 160,
    stretchLbs: 175,
  },
  {
    name: 'ahead',
    expectedStatus: 'ahead',
    summary: 'A heavy set in week 2 passes the stretch edge of the band, short of the goal.',
    weeklyLoadsLbs: [100, 110, 121, 133, 146],
    heavySingleLbs: 155,
    targetStartWeeksAgo: 1,
    committedLbs: 160,
    stretchLbs: 175,
  },
  {
    name: 'hit_exact',
    expectedStatus: 'goal_met',
    summary: 'The newest reading lands exactly on the committed target.',
    weeklyLoadsLbs: [100, 110, 121, 133, 146],
    targetStartWeeksAgo: 4,
    committedLbs: 146,
    stretchLbs: 160,
  },
  {
    name: 'beyond_goal',
    expectedStatus: 'beyond_goal',
    summary: 'The newest reading passes the committed target with weeks of the block left.',
    weeklyLoadsLbs: [100, 110, 121, 133, 146],
    targetStartWeeksAgo: 4,
    committedLbs: 130,
    stretchLbs: 140,
  },
];

export function goalPreviewState(name: string): GoalPreviewState {
  const found = GOAL_PREVIEW_STATES.find((state) => state.name === name);
  if (found === undefined) {
    const known = GOAL_PREVIEW_STATES.map((state) => state.name).join(', ');
    throw new Error(`unknown --state ${name}; known: ${known}`);
  }
  return found;
}

/** The store slice the seed writes through. Every write is a public store method. */
export type GoalPreviewStore = Pick<
  SessionStore,
  'putSession' | 'putSet' | 'putPriority' | 'putGoalTarget' | 'reharvestExercise' | 'recalcBaseline'
>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What was written, for the script to print. */
export interface GoalPreviewSeedReport {
  priorityId: string;
  targetId: string;
  sessions: number;
  sets: number;
  latestLoadLbs: number;
  baselineState: string;
}

/**
 * Write one previewable goal state into `store`, which must be the ONLY holder
 * of its file — the server opens it afterwards, never alongside.
 */
export async function seedGoalPreview(
  store: GoalPreviewStore,
  state: GoalPreviewState,
  now: Date,
): Promise<GoalPreviewSeedReport> {
  const written = await seedSessions(store, state, now);
  const key = { userId: LOCAL_USER_ID, exerciseId: GOAL_PREVIEW_EXERCISE.id };
  await store.reharvestExercise(key);
  const baseline = await store.recalcBaseline(key);
  const priority = await store.putPriority(priorityRow(now));
  const target = await store.putGoalTarget(targetRow(state, now));
  return {
    priorityId: priority.id,
    targetId: target.id,
    ...written,
    baselineState: baseline.state,
  };
}

/**
 * When the session `weeksBack` weeks before the newest one happened. The newest
 * sits halfway between the Monday of `now`'s ISO week and `now`: in the past and
 * in the current calendar week on any weekday, so it is the current week's reading.
 */
export function seededAt(now: Date, weeksBack: number): string {
  const monday = Date.parse(startOfCalendarWeekIso(now));
  const newest = monday + (now.getTime() - monday) / 2;
  return new Date(newest - weeksBack * 7 * DAY_MS).toISOString();
}

/** One session per weekly load, oldest first, seven days apart so each lands in its own week. */
async function seedSessions(
  store: GoalPreviewStore,
  state: GoalPreviewState,
  now: Date,
): Promise<{ sessions: number; sets: number; latestLoadLbs: number }> {
  const weeks = state.weeklyLoadsLbs.length;
  let sets = 0;
  for (const [index, load] of state.weeklyLoadsLbs.entries()) {
    const at = seededAt(now, weeks - 1 - index);
    const sessionId = `preview-goal-session-${index + 1}`;
    await store.putSession({
      id: sessionId,
      startedAt: at,
      endedAt: at,
      exerciseId: GOAL_PREVIEW_EXERCISE.id,
      exerciseName: GOAL_PREVIEW_EXERCISE.name,
    });
    const newest = index === weeks - 1;
    const planned = sessionSets(state, load, newest);
    const spacingMs = setSpacingMs(at, now, planned.length);
    for (const [order, set] of planned.entries()) {
      const setAt = new Date(Date.parse(at) + order * spacingMs).toISOString();
      await store.putSet(workingSet(sessionId, setAt, sets++, set.weightLbs, set.reps));
    }
  }
  const latest = state.weeklyLoadsLbs[weeks - 1] ?? 0;
  return { sessions: weeks, sets, latestLoadLbs: state.heavySingleLbs ?? latest };
}

/** Five minutes between sets, squeezed when the session is so recent that five would run past `now`. */
function setSpacingMs(sessionAt: string, now: Date, setCount: number): number {
  return Math.min(5 * 60_000, (now.getTime() - Date.parse(sessionAt)) / (setCount + 1));
}

/** One session's working sets: the week's load at the anchor, plus the newest week's heavy set. */
function sessionSets(
  state: GoalPreviewState,
  load: number,
  newest: boolean,
): { weightLbs: number; reps: number }[] {
  const sets = Array.from({ length: SETS_PER_SESSION }, () => ({
    weightLbs: load,
    reps: GOAL_PREVIEW_ANCHOR_REPS,
  }));
  if (newest && state.heavySingleLbs !== undefined) {
    sets.push({ weightLbs: state.heavySingleLbs, reps: 5 });
  }
  return sets;
}

/**
 * One recorded working set, at `at`.
 *
 * `source: 'local'` rather than `'mock'`: these stand in for the lifter's own
 * recorded work, and the per-muscle read models exclude mock sets by design
 * (`read-models/muscle-set-scope.ts`), the same reason `dashboard-body-seed`
 * gives.
 */
function workingSet(
  sessionId: string,
  at: string,
  index: number,
  weightLbs: number,
  reps: number,
): StoredSet {
  const id = `preview-goal-set-${index + 1}`;
  return {
    id,
    sessionId,
    userId: LOCAL_USER_ID,
    startedAt: at,
    endedAt: at,
    partial: false,
    exerciseId: GOAL_PREVIEW_EXERCISE.id,
    slot: 'primary',
    setPurpose: 'working',
    weightLbs,
    trainingMode: 'weight',
    source: 'local',
    reps: grindingReps(id, reps),
  };
}

/**
 * A set that ground to a stall: velocities decay to 64% of the set's fastest rep
 * at full range. That shape is what `evaluateFailureCandidate` harvests as a
 * failure anchor (`store/failure-harvest.ts`), and three of them across
 * separate sessions are what promote the baseline past SHAPE_ONLY — without
 * which every band comes back `cold` and every state reads `calibrating`.
 */
function grindingReps(setId: string, count: number): StoredRep[] {
  const fastestMps = 0.62;
  const decay = 0.36;
  return Array.from({ length: count }, (_, index) => {
    const velocity = Number((fastestMps * (1 - (decay * index) / (count - 1))).toFixed(3));
    return rep(setId, index, velocity);
  });
}

/** Rep `index`, three seconds long, at `velocityMps` over a fixed range of motion. */
function rep(setId: string, index: number, velocityMps: number): StoredRep {
  const durationMs = 3_000;
  const startTime = index * durationMs;
  return {
    id: `${setId}-rep-${index}`,
    setId,
    index,
    repNumber: index + 1,
    concentric: {
      ...EMPTY_PHASE,
      startTime,
      endTime: startTime + durationMs,
      startPosition: 0,
      endPosition: 0.5,
      _totalVelocity: velocityMps,
      _movementSampleCount: 1,
      _lastMovementVelocity: velocityMps,
      peakVelocity: velocityMps,
    },
    eccentric: { ...EMPTY_PHASE },
  };
}

function priorityRow(now: Date): Parameters<GoalPreviewStore['putPriority']>[0] {
  return {
    id: 'preview-goal-priority',
    userId: LOCAL_USER_ID,
    horizonWeeks: GOAL_PREVIEW_HORIZON_WEEKS,
    kind: 'lift',
    ref: GOAL_PREVIEW_EXERCISE.id,
    level: 'specialize',
    declaredAt: new Date(now.getTime() - 28 * DAY_MS).toISOString(),
    mesosHeld: 1,
  };
}

/**
 * The accepted target. Its numbers are FIXED once accepted (`putGoalTarget`'s
 * `GOAL_TARGET_FIXED`), which is why the state's committed/stretch are written
 * here rather than re-derived: they are the fixed promise the page judges the
 * readings against, and only the weekly corridor is re-derived at read time.
 */
function targetRow(
  state: GoalPreviewState,
  now: Date,
): Parameters<GoalPreviewStore['putGoalTarget']>[0] {
  const startMeasuredAt = seededAt(now, state.targetStartWeeksAgo);
  const loads = state.weeklyLoadsLbs;
  const startLoad = loads[Math.max(0, loads.length - 1 - state.targetStartWeeksAgo)] ?? 0;
  return {
    id: 'preview-goal-target',
    priorityId: 'preview-goal-priority',
    metric: 'top_load_at_reps',
    exerciseId: GOAL_PREVIEW_EXERCISE.id,
    anchorReps: GOAL_PREVIEW_ANCHOR_REPS,
    startValue: startLoad,
    startMeasuredAt,
    bandLowPctPerWeek: 1,
    bandHighPctPerWeek: 2,
    committedValue: state.committedLbs,
    stretchValue: state.stretchLbs,
    basis: state.acceptedCold === true ? 'execution_ramp' : 'rp_ramp',
    infoLevel: state.acceptedCold === true ? 'cold' : 'ramp',
    tierUsed: 'intermediate',
    tierProvisional: false,
    dietPhaseAtDerivation: 'maintenance',
    acceptedBy: 'user',
    acknowledgedStretch: false,
    derivedAt: startMeasuredAt,
    endsAt: blockEndsAt(startMeasuredAt, GOAL_PREVIEW_HORIZON_WEEKS),
  };
}
