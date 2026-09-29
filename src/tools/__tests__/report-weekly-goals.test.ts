// `report.weekly` goal lines (VW-358, plan G11'): one line per accepted target, built from the
// GoalProgressView read model, plus a rollup line per muscle priority. Synthetic lifts only.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { baselineKeyId, EMPTY_PHASE } from '@voltras/workout-analytics';
import { loadSeedCatalog } from '../../exercises/__tests__/load-seed-catalog.js';
import { LOCAL_USER_ID, type SqliteSessionStore } from '../../store/sqlite-store.js';
import type { StoredGoalTarget, StoredPriority } from '../../store/types.js';
import type { ServerState } from '../../state/server-state.js';
import { STATUS_LABEL } from '../../dashboard/read-models/goal-progress.js';
import { buildWeeklyReport, renderWeeklyMarkdown } from '../report-tools.js';
import { openSqliteTestStore } from '../../store/__tests__/open-test-store.js';

beforeAll(loadSeedCatalog);

const TO = '2026-09-29T12:00:00.000Z';
const NAMES: Record<string, string> = {
  'cable-row': 'seated row',
  'cable-chest-press': 'chest press',
};

function makeState(store: SqliteSessionStore): ServerState {
  return {
    config: { adapter: 'node' },
    store,
    exercises: { getById: (id: string) => (id in NAMES ? { id, name: NAMES[id] } : undefined) },
  } as unknown as ServerState;
}

/** Marks the lift's baseline calibrated, so the band is judged rather than an execution ramp. */
function calibrate(store: SqliteSessionStore, exerciseId: string): void {
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.prepare(
    `INSERT INTO exercise_baselines
       (id, user_id, exercise_id, state, observed_sessions, anchor_count, updated_at, algorithm_version)
     VALUES (?, ?, ?, 'CALIBRATED', 5, 5, ?, 'v1')`,
  ).run(baselineKeyId({ userId: LOCAL_USER_ID, exerciseId }), LOCAL_USER_ID, exerciseId, TO);
}

/** Four weekly working sets of eight reps ending a week before `TO`, at the given loads. */
async function seedHistory(
  store: SqliteSessionStore,
  exerciseId: string,
  loads: number[],
): Promise<void> {
  calibrate(store, exerciseId);
  for (const [week, weightLbs] of loads.entries()) {
    const at = new Date(Date.parse(TO) - (loads.length - week) * 7 * 86_400_000).toISOString();
    const id = `${exerciseId}-${week}`;
    await store.putSession({ id: `ses-${id}`, startedAt: at, endedAt: at, kind: 'training' });
    await store.putSet({
      id,
      sessionId: `ses-${id}`,
      userId: LOCAL_USER_ID,
      kind: 'training',
      exerciseId,
      startedAt: at,
      endedAt: at,
      partial: false,
      weightLbs,
      reps: Array.from({ length: 8 }, (_, index) => ({
        id: `${id}-r${index}`,
        setId: id,
        index,
        repNumber: index + 1,
        concentric: { ...EMPTY_PHASE },
        eccentric: { ...EMPTY_PHASE },
      })),
    });
  }
}

function priority(over: Partial<StoredPriority> & { id: string }): StoredPriority {
  return {
    userId: LOCAL_USER_ID,
    horizonWeeks: 0,
    kind: 'lift',
    ref: 'cable-row',
    level: 'specialize',
    declaredAt: '2026-08-01T00:00:00.000Z',
    mesosHeld: 1,
    ...over,
  };
}

function target(
  over: Partial<StoredGoalTarget> & { id: string; priorityId: string },
): StoredGoalTarget {
  return {
    metric: 'top_load_at_reps',
    exerciseId: 'cable-row',
    anchorReps: 8,
    startValue: 170,
    startMeasuredAt: '2026-09-01T00:00:00.000Z',
    bandLowPctPerWeek: 0,
    bandHighPctPerWeek: 1,
    committedValue: 190,
    stretchValue: 200,
    basis: 'rp_ramp',
    infoLevel: 'ramp',
    tierUsed: 'beginner',
    tierProvisional: false,
    dietPhaseAtDerivation: 'maintenance',
    acceptedBy: 'user',
    acknowledgedStretch: false,
    derivedAt: '2026-09-01T00:00:00.000Z',
    endsAt: '2026-10-25T00:00:00.000Z',
    ...over,
  };
}

describe('report.weekly goal lines', () => {
  let store: SqliteSessionStore;

  beforeEach(() => {
    store = openSqliteTestStore();
  });

  afterEach(async () => {
    await store.close();
  });

  it('omits the goal section when no priorities exist', async () => {
    const report = await buildWeeklyReport(makeState(store), { to: TO });

    expect(report.goals).toEqual([]);
    expect(renderWeeklyMarkdown(report)).not.toContain('## Goals');
  });

  it('writes one goal line per accepted target, and skips a proposal', async () => {
    await seedHistory(store, 'cable-row', [170, 172, 174, 176]);
    await store.putPriority(priority({ id: 'p1' }));
    await store.putGoalTarget(target({ id: 't1', priorityId: 'p1' }));
    await store.putGoalTarget(
      target({ id: 't-proposal', priorityId: 'p1', acceptedBy: undefined, anchorReps: 5 }),
    );

    const report = await buildWeeklyReport(makeState(store), { to: TO });

    expect(report.goals).toHaveLength(1);
    expect(report.goals[0]).toMatchObject({ priorityId: 'p1', targetId: 't1' });
    expect(report.goals[0].text).toMatch(/^goal: seated row 190x8 by Oct 25, (on track|ahead)/);
    expect(renderWeeklyMarkdown(report)).toContain(`## Goals\n- ${report.goals[0].text}`);
  });

  it('words a behind lift with the read model status, not a value the report derived', async () => {
    await seedHistory(store, 'cable-row', [170, 160, 150, 140]);
    await store.putPriority(priority({ id: 'p1' }));
    await store.putGoalTarget(target({ id: 't1', priorityId: 'p1' }));

    const [line] = (await buildWeeklyReport(makeState(store), { to: TO })).goals;

    expect(line.status).not.toBe('on_track');
    expect(line.text).toContain(STATUS_LABEL[line.status]);
  });

  it('adds a "k of n primary lifts on track" rollup line for a muscle priority', async () => {
    await seedHistory(store, 'cable-row', [170, 172, 174, 176]);
    await seedHistory(store, 'cable-chest-press', [120, 110, 100, 90]);
    await store.putPriority(priority({ id: 'p-arms', kind: 'muscle', ref: 'arms' }));
    await store.putGoalTarget(target({ id: 'ta', priorityId: 'p-arms' }));
    await store.putGoalTarget(
      target({
        id: 'tb',
        priorityId: 'p-arms',
        exerciseId: 'cable-chest-press',
        startValue: 120,
        committedValue: 130,
      }),
    );

    const { goals } = await buildWeeklyReport(makeState(store), { to: TO });

    const rollup = goals.find((line) => line.targetId === undefined);
    expect(goals.filter((line) => line.targetId !== undefined)).toHaveLength(2);
    expect(rollup?.text).toMatch(/^goal: arms, 1 of 2 primary lifts on track/);
  });

  it('omits the goals for a named lifter even when the owner has accepted targets', async () => {
    await seedHistory(store, 'cable-row', [170, 172, 174, 176]);
    await store.putPriority(priority({ id: 'p1' }));
    await store.putGoalTarget(target({ id: 't1', priorityId: 'p1' }));

    const report = await buildWeeklyReport(makeState(store), { to: TO, lifter: 'guest-x' });

    expect(report.goals).toEqual([]);
    expect(renderWeeklyMarkdown(report)).not.toContain('## Goals');
  });

  it('leaves out a target derived after the report range ends', async () => {
    await seedHistory(store, 'cable-row', [170, 172, 174, 176]);
    await store.putPriority(priority({ id: 'p1' }));
    await store.putGoalTarget(
      target({ id: 't-late', priorityId: 'p1', derivedAt: '2026-10-05T00:00:00.000Z' }),
    );

    const report = await buildWeeklyReport(makeState(store), { to: TO });

    expect(report.goals).toEqual([]);
  });

  it('keeps a target that was retired after the report range ends', async () => {
    await seedHistory(store, 'cable-row', [170, 172, 174, 176]);
    await store.putPriority(priority({ id: 'p1' }));
    await store.putGoalTarget(
      target({
        id: 't-retired',
        priorityId: 'p1',
        retiredAt: '2026-10-05T00:00:00.000Z',
        outcome: 'abandoned',
      }),
    );

    const report = await buildWeeklyReport(makeState(store), { to: TO });

    expect(report.goals.map((line) => line.targetId)).toEqual(['t-retired']);
  });

  it('keeps a priority retired after the range ends and skips one declared after it', async () => {
    await seedHistory(store, 'cable-row', [170, 172, 174, 176]);
    await store.putPriority(priority({ id: 'p-old', retiredAt: '2026-10-05T00:00:00.000Z' }));
    await store.putPriority(priority({ id: 'p-new', declaredAt: '2026-10-05T00:00:00.000Z' }));
    await store.putGoalTarget(target({ id: 't-old', priorityId: 'p-old' }));
    await store.putGoalTarget(target({ id: 't-new', priorityId: 'p-new' }));

    const report = await buildWeeklyReport(makeState(store), { to: TO });

    expect(report.goals.map((line) => line.targetId)).toEqual(['t-old']);
  });
});
