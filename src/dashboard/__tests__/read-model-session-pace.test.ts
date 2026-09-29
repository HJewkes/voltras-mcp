/**
 * Session-pace read-model (VW-290) — the pure estimate behind the rail footer.
 * Verifies the plan arithmetic (work + rest per set, the trailing rest excluded),
 * that VW-297's goal-keyed rest default is what an unset rest costs, that logged
 * working sets are what burn down the remainder, and that a session with no plan
 * attached yields null rather than a fabricated budget. The clock is injected, so
 * nothing here needs fake timers.
 */
import { describe, expect, it } from 'vitest';

import {
  buildSessionPaceView,
  classifyPace,
  DEFAULT_SET_WORK_SECONDS,
  PACE_TOLERANCE_FLOOR_SECONDS,
  PACE_TOLERANCE_FRACTION,
  type CompletedWorkingSet,
  type SessionPaceView,
} from '../read-models/session-pace';
import { HYPERTROPHY_REST_SECONDS, STRENGTH_REST_SECONDS } from '../../analytics/rest-defaults';
import type { StoredPlannedExercise } from '../../store/types';

const STARTED_AT = '2026-05-09T12:00:00.000Z';
/** 18 minutes into the session. */
const NOW_MS = Date.parse('2026-05-09T12:18:00.000Z');

const planned = (over: Partial<StoredPlannedExercise> = {}): StoredPlannedExercise => ({
  id: 'pe-1',
  workoutTemplateId: 'tpl-1',
  exerciseId: 'cable-chest-press',
  orderIndex: 0,
  targetSets: 3,
  ...over,
});

/** No catalog: every exercise's tempo falls back, isolating the rest arithmetic. */
const noCatalog = undefined;

/** `count` working sets; only the list's length matters to the VW-290 arithmetic. */
const workingSets = (count: number): CompletedWorkingSet[] =>
  Array.from({ length: count }, () => ({ endedAtMs: Date.parse(STARTED_AT) }));

describe('buildSessionPaceView', () => {
  it('costs each planned set at its work plus its rest, minus the trailing rest', () => {
    // 3 sets x (40 s work + 60 s rest) − the last rest = 240 s = 4 min.
    const pace = buildSessionPaceView(
      {
        startedAt: STARTED_AT,
        nowMs: NOW_MS,
        planned: [planned({ targetSets: 3, restSec: 60 })],
        completedWorkingSets: workingSets(0),
        liveSetActive: false,
      },
      noCatalog,
    );
    expect(pace).toEqual({
      plannedMinutes: 4,
      elapsedMinutes: 18,
      plannedSetsRemaining: 3,
      projectedEndAt: '2026-05-09T12:22:00.000Z',
      state: 'idle',
      slipMinutes: 0,
    });
    expect(DEFAULT_SET_WORK_SECONDS).toBe(40);
  });

  it('rests a strength exercise longer than a hypertrophy one when the coach set none', () => {
    const paceFor = (intent: 'strength' | 'hypertrophy'): number =>
      buildSessionPaceView(
        {
          startedAt: STARTED_AT,
          nowMs: NOW_MS,
          planned: [planned({ targetSets: 2, trainingIntent: intent })],
          completedWorkingSets: workingSets(0),
          liveSetActive: false,
        },
        noCatalog,
      )!.plannedMinutes;
    // 2 sets: 2 x 40 s work + ONE rest (the trailing one is dropped).
    expect(paceFor('strength')).toBe(Math.round((80 + STRENGTH_REST_SECONDS) / 60));
    expect(paceFor('hypertrophy')).toBe(Math.round((80 + HYPERTROPHY_REST_SECONDS) / 60));
    expect(paceFor('strength')).toBeGreaterThan(paceFor('hypertrophy'));
  });

  it('burns the remainder down in plan order as working sets are logged', () => {
    const rows = [
      planned({ id: 'pe-1', orderIndex: 1, targetSets: 2, restSec: 60 }),
      planned({ id: 'pe-0', orderIndex: 0, targetSets: 2, restSec: 30 }),
    ];
    const pace = buildSessionPaceView(
      {
        startedAt: STARTED_AT,
        nowMs: NOW_MS,
        planned: rows,
        completedWorkingSets: workingSets(3),
        liveSetActive: false,
      },
      noCatalog,
    );
    // One set left, from the orderIndex-1 exercise: 40 s work, no trailing rest.
    expect(pace?.plannedSetsRemaining).toBe(1);
    expect(pace?.projectedEndAt).toBe('2026-05-09T12:18:40.000Z');
  });

  it('projects the end as now once the plan is met or exceeded', () => {
    const pace = buildSessionPaceView(
      {
        startedAt: STARTED_AT,
        nowMs: NOW_MS,
        planned: [planned({ targetSets: 2 })],
        completedWorkingSets: workingSets(5),
        liveSetActive: false,
      },
      noCatalog,
    );
    expect(pace?.plannedSetsRemaining).toBe(0);
    expect(pace?.projectedEndAt).toBe(new Date(NOW_MS).toISOString());
  });

  it('paces a set at its rep target x its resolved tempo when both are known', () => {
    const catalog = { getById: () => ({ movementPattern: 'push' }) };
    // push default tempo is 3-0-1-0 = 4 s; 10 reps = 40 s work, + 60 s rest, x2 sets,
    // minus the trailing rest = 140 s.
    const pace = buildSessionPaceView(
      {
        startedAt: STARTED_AT,
        nowMs: NOW_MS,
        planned: [planned({ targetSets: 2, targetRepsHigh: 10, restSec: 60 })],
        completedWorkingSets: workingSets(0),
        liveSetActive: false,
      },
      catalog,
    );
    expect(pace?.plannedMinutes).toBe(Math.round(140 / 60));
  });

  it('returns null for a session with no plan attached', () => {
    expect(
      buildSessionPaceView(
        {
          startedAt: STARTED_AT,
          nowMs: NOW_MS,
          planned: [],
          completedWorkingSets: workingSets(2),
          liveSetActive: false,
        },
        noCatalog,
      ),
    ).toBeNull();
  });

  it('returns null when the session start is unparseable', () => {
    expect(
      buildSessionPaceView(
        {
          startedAt: 'not-a-date',
          nowMs: NOW_MS,
          planned: [planned()],
          completedWorkingSets: workingSets(0),
          liveSetActive: false,
        },
        noCatalog,
      ),
    ).toBeNull();
  });

  it('never reports negative elapsed minutes for a clock behind the session start', () => {
    const pace = buildSessionPaceView(
      {
        startedAt: STARTED_AT,
        nowMs: Date.parse(STARTED_AT) - 60_000,
        planned: [planned()],
        completedWorkingSets: workingSets(0),
        liveSetActive: false,
      },
      noCatalog,
    );
    expect(pace?.elapsedMinutes).toBe(0);
  });
});

/**
 * Pace state and slip (VMCP-02.76 S1). The plan is five sets of 40 s work and
 * 180 s rest: 920 s in all, so its 5% (46 s) is under the floor and the
 * tolerance is the 120 s floor. Set n (1-based) ends on the plan at
 * 40 + 220 x (n - 1) seconds after the start.
 */
describe('buildSessionPaceView pace state', () => {
  const startMs = Date.parse(STARTED_AT);
  const plan = [planned({ targetSets: 5, restSec: 180 })];
  const onPlanEnd = (setNumber: number): number => 40 + 220 * (setNumber - 1);
  const endedAt = (...seconds: number[]): CompletedWorkingSet[] =>
    seconds.map((s) => ({ exerciseId: 'cable-chest-press', endedAtMs: startMs + s * 1000 }));
  const paceAt = (
    nowSeconds: number,
    sets: CompletedWorkingSet[],
    liveSetActive = false,
  ): SessionPaceView =>
    buildSessionPaceView(
      {
        startedAt: STARTED_AT,
        nowMs: startMs + nowSeconds * 1000,
        planned: plan,
        completedWorkingSets: sets,
        liveSetActive,
      },
      noCatalog,
    )!;

  it('is idle ten minutes in with no working set and no set streaming', () => {
    const pace = paceAt(600, []);
    expect(pace.state).toBe('idle');
    expect(pace.slipMinutes).toBe(0);
  });

  it('stays idle, never behind, an hour in before the first set', () => {
    const pace = paceAt(3600, []);
    expect(pace.state).toBe('idle');
    expect(pace.slipMinutes).toBe(0);
    expect(pace.plannedMinutes).toBe(Math.round(920 / 60));
  });

  it('is on pace when sets land on the planned cadence', () => {
    const pace = paceAt(onPlanEnd(3) + 20, endedAt(onPlanEnd(1), onPlanEnd(2), onPlanEnd(3)));
    expect(pace.state).toBe('on_pace');
    expect(pace.slipMinutes).toBe(0);
  });

  it('is behind by the rounded overrun when a rest runs past its tolerance', () => {
    const overrunSeconds = 430;
    const pace = paceAt(onPlanEnd(1) + 180 + overrunSeconds, endedAt(onPlanEnd(1)));
    expect(pace.state).toBe('behind');
    expect(pace.slipMinutes).toBe(Math.round(overrunSeconds / 60));
  });

  it('is ahead when sets land faster than plan and the next set is streaming', () => {
    // Three sets by 300 s against a planned 480 s: 180 s early.
    const pace = paceAt(330, endedAt(40, 170, 300), true);
    expect(pace.state).toBe('ahead');
    expect(pace.slipMinutes).toBe(-3);
  });

  it('does not move the state for a rest still inside the rest the last set owed', () => {
    const sets = endedAt(40, 170, 300);
    const early = paceAt(301, sets);
    const lateInRest = paceAt(300 + 180, sets);
    expect(early.state).toBe('ahead');
    expect(lateInRest).toMatchObject({ state: early.state, slipMinutes: early.slipMinutes });
  });

  it('reads exactly the tolerance as on pace and one second over as behind', () => {
    const restEnds = onPlanEnd(1) + 180;
    const sets = endedAt(onPlanEnd(1));
    expect(paceAt(restEnds + PACE_TOLERANCE_FLOOR_SECONDS, sets).state).toBe('on_pace');
    expect(paceAt(restEnds + PACE_TOLERANCE_FLOOR_SECONDS + 1, sets).state).toBe('behind');
  });

  it('widens the tolerance to its share of a long plan', () => {
    const plannedSeconds = 3600;
    const tolerance = PACE_TOLERANCE_FRACTION * plannedSeconds;
    expect(tolerance).toBeGreaterThan(PACE_TOLERANCE_FLOOR_SECONDS);
    expect(classifyPace(tolerance, plannedSeconds, false)).toBe('on_pace');
    expect(classifyPace(tolerance + 1, plannedSeconds, false)).toBe('behind');
    expect(classifyPace(-tolerance - 1, plannedSeconds, false)).toBe('ahead');
  });

  it('pins the tolerance constants the owner confirms', () => {
    expect(PACE_TOLERANCE_FLOOR_SECONDS).toBe(120);
    expect(PACE_TOLERANCE_FRACTION).toBe(0.05);
  });
});
