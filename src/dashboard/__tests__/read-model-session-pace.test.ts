/**
 * Session-pace read-model (VW-290) — the pure estimate behind the rail footer.
 * Verifies the plan arithmetic (work + rest per set, the trailing rest excluded),
 * that VW-297's goal-keyed rest default is what an unset rest costs, that logged
 * working sets are what burn down the remainder, and that a session with no plan
 * attached yields null rather than a fabricated budget. The clock is injected, so
 * nothing here needs fake timers.
 */
import { describe, expect, it } from 'vitest';

import { buildSessionPaceView, DEFAULT_SET_WORK_SECONDS } from '../read-models/session-pace';
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

describe('buildSessionPaceView', () => {
  it('costs each planned set at its work plus its rest, minus the trailing rest', () => {
    // 3 sets x (40 s work + 60 s rest) − the last rest = 240 s = 4 min.
    const pace = buildSessionPaceView(
      {
        startedAt: STARTED_AT,
        nowMs: NOW_MS,
        planned: [planned({ targetSets: 3, restSec: 60 })],
        completedWorkingSets: 0,
      },
      noCatalog,
    );
    expect(pace).toEqual({
      plannedMinutes: 4,
      elapsedMinutes: 18,
      plannedSetsRemaining: 3,
      projectedEndAt: '2026-05-09T12:22:00.000Z',
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
          completedWorkingSets: 0,
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
      { startedAt: STARTED_AT, nowMs: NOW_MS, planned: rows, completedWorkingSets: 3 },
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
        completedWorkingSets: 5,
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
        completedWorkingSets: 0,
      },
      catalog,
    );
    expect(pace?.plannedMinutes).toBe(Math.round(140 / 60));
  });

  it('returns null for a session with no plan attached', () => {
    expect(
      buildSessionPaceView(
        { startedAt: STARTED_AT, nowMs: NOW_MS, planned: [], completedWorkingSets: 2 },
        noCatalog,
      ),
    ).toBeNull();
  });

  it('returns null when the session start is unparseable', () => {
    expect(
      buildSessionPaceView(
        { startedAt: 'not-a-date', nowMs: NOW_MS, planned: [planned()], completedWorkingSets: 0 },
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
        completedWorkingSets: 0,
      },
      noCatalog,
    );
    expect(pace?.elapsedMinutes).toBe(0);
  });
});
