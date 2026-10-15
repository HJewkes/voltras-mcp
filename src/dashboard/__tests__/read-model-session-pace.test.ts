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
  suggestPaceAdjustment,
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

  it('stops counting rest once the next set is streaming', () => {
    const sets = endedAt(onPlanEnd(1));
    const longAfterRest = onPlanEnd(1) + 180 + 600;
    expect(paceAt(longAfterRest, sets).state).toBe('behind');
    expect(paceAt(longAfterRest, sets, true)).toMatchObject({ state: 'on_pace', slipMinutes: 0 });
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

/**
 * Trim / add suggestion (VMCP-02.76 S2). Every set costs 100 s (40 s work, 60 s
 * rest), so slips and headrooms below are counted in whole sets.
 */
describe('suggestPaceAdjustment', () => {
  const SET_SECONDS = 100;
  const plan = [
    planned({ id: 'a', exerciseId: 'ex-a', orderIndex: 0, targetSets: 4, restSec: 60 }),
    planned({ id: 'b', exerciseId: 'ex-b', orderIndex: 1, targetSets: 3, restSec: 60 }),
    planned({ id: 'c', exerciseId: 'ex-c', orderIndex: 2, targetSets: 3, restSec: 60 }),
  ];
  const logged = (...ids: (string | undefined)[]): CompletedWorkingSet[] =>
    ids.map((exerciseId, i) => ({ exerciseId, endedAtMs: i }));
  const suggest = (
    state: 'ahead' | 'behind' | 'on_pace' | 'idle',
    sets: number,
    completed: CompletedWorkingSet[],
    rows = plan,
  ) => {
    const slipSeconds = (state === 'ahead' ? -sets : sets) * SET_SECONDS;
    return suggestPaceAdjustment(state, slipSeconds, rows, completed, noCatalog);
  };

  it('trims from the last exercise first, down to one set, never the in-progress exercise', () => {
    // ex-a is in progress; a four-set slip cuts ex-c to one set, then ex-b.
    const result = suggest('behind', 4, logged('ex-a'));
    expect(result).toEqual({
      kind: 'trim',
      cuts: [
        { exerciseId: 'ex-c', fromSets: 3, toSets: 1 },
        { exerciseId: 'ex-b', fromSets: 3, toSets: 1 },
      ],
      savesMinutes: Math.round(400 / 60),
      coversSlip: true,
    });
  });

  it('stops trimming once the saved time reaches the slip', () => {
    const result = suggest('behind', 1, logged('ex-a'));
    expect(result).toMatchObject({
      cuts: [{ exerciseId: 'ex-c', fromSets: 3, toSets: 2 }],
      coversSlip: true,
    });
  });

  it('never trims the in-progress exercise even when it is the last one', () => {
    const result = suggest('behind', 9, logged('ex-a', 'ex-b', 'ex-c'));
    expect(result).toMatchObject({ kind: 'trim' });
    const ids = result?.kind === 'trim' ? result.cuts.map((cut) => cut.exerciseId) : [];
    expect(ids).not.toContain('ex-c');
  });

  it('reports coversSlip false when every trimmable set still falls short', () => {
    const result = suggest('behind', 20, logged('ex-a'));
    expect(result).toMatchObject({ kind: 'trim', coversSlip: false });
    expect(result?.kind === 'trim' ? result.cuts.map((cut) => cut.toSets) : []).toEqual([1, 1]);
  });

  it('adds sets to the in-progress exercise, capped at 2', () => {
    expect(suggest('ahead', 5, logged('ex-b'))).toEqual({
      kind: 'add',
      exerciseId: 'ex-b',
      sets: 2,
      costsMinutes: Math.round(200 / 60),
    });
  });

  it('caps the added sets at the headroom', () => {
    expect(suggest('ahead', 1.5, logged('ex-b'))).toMatchObject({ sets: 1 });
  });

  it('adds to the next remaining exercise when no exercise is in progress', () => {
    expect(suggest('ahead', 3, [])).toMatchObject({ exerciseId: 'ex-a', sets: 2 });
  });

  it('skips a finished in-progress exercise and adds to the next one with sets left', () => {
    const rows = [
      planned({ id: 'a', exerciseId: 'ex-a', orderIndex: 0, targetSets: 2, restSec: 60 }),
      planned({ id: 'b', exerciseId: 'ex-b', orderIndex: 1, targetSets: 3, restSec: 60 }),
      planned({ id: 'c', exerciseId: 'ex-c', orderIndex: 2, targetSets: 3, restSec: 60 }),
    ];
    expect(suggest('ahead', 5, logged('ex-a', 'ex-a'), rows)).toMatchObject({
      kind: 'add',
      exerciseId: 'ex-b',
      sets: 2,
    });
  });

  it('trims a partly done exercise no lower than the sets already logged', () => {
    // ex-b has two of three sets logged and ex-a is in progress, so ex-b floors at two.
    const result = suggest('behind', 9, logged('ex-b', 'ex-b', 'ex-a'));
    expect(result).toMatchObject({
      cuts: [
        { exerciseId: 'ex-c', fromSets: 3, toSets: 1 },
        { exerciseId: 'ex-b', fromSets: 3, toSets: 2 },
      ],
    });
  });

  it('gives null when the headroom is smaller than one set', () => {
    expect(suggest('ahead', 0.9, logged('ex-b'))).toBeNull();
  });

  it('gives null on pace, idle, and once the plan is met', () => {
    expect(suggest('on_pace', 0, logged('ex-a'))).toBeNull();
    expect(suggest('idle', 0, [])).toBeNull();
    const done = logged(...Array.from({ length: 10 }, () => 'ex-a'));
    expect(suggest('behind', 3, done)).toBeNull();
    expect(suggest('ahead', 3, done)).toBeNull();
  });

  it('ignores sets with no exerciseId for targeting but counts them toward the total', () => {
    // Two unattributed sets leave ex-b and ex-c untouched, so both stay trimmable.
    const result = suggest('behind', 2, logged(undefined, undefined));
    expect(result).toMatchObject({ cuts: [{ exerciseId: 'ex-c', fromSets: 3, toSets: 1 }] });
    // Ten unattributed sets meet the plan total, so nothing remains to suggest.
    expect(suggest('behind', 2, logged(...Array.from({ length: 10 }, () => undefined)))).toBeNull();
  });

  it('is what buildSessionPaceView reports as its suggestion', () => {
    const startMs = Date.parse(STARTED_AT);
    const pace = buildSessionPaceView(
      {
        startedAt: STARTED_AT,
        nowMs: startMs + 3600_000,
        planned: plan,
        completedWorkingSets: [{ exerciseId: 'ex-a', endedAtMs: startMs + 40_000 }],
        liveSetActive: false,
      },
      noCatalog,
    );
    expect(pace?.state).toBe('behind');
    expect(pace?.suggestion).toMatchObject({ kind: 'trim', coversSlip: false });
  });
});
