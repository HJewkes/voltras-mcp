// Unit tests for `report.weekly` (src/tools/report-tools.ts).
//
// Uses a real `SqliteSessionStore.open(':memory:')` rather than a hand-rolled
// stub: the tool composes plan-tree, baseline-gate and self-report reads
// across many store methods, and re-deriving each one's filtering behaviour
// by hand would test the stub, not the tool. `self_reports` has no writer yet
// (see `sqlite-store-self-reports.test.ts`), so those rows are seeded through
// the raw handle.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { baselineKeyId, type Phase, type Rep } from '@voltras/workout-analytics';
import { LOCAL_USER_ID, SqliteSessionStore } from '../../store/sqlite-store.js';
import type { StoredRep, StoredSet } from '../../store/types.js';
import type { ServerState } from '../../state/server-state.js';
import { buildWeeklyReport, renderWeeklyMarkdown } from '../report-tools.js';
import { RIR_VELOCITY_MODEL_VERSION } from '../../analytics/rir-velocity.js';
import { seedTrainingDay } from '../../__tests__/fixtures/training-day.js';

const EXERCISE_ID = 'seated-row';

const EMPTY_PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 0,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

function rawDb(store: SqliteSessionStore): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

const DEFAULT_WEIGHT_LBS = 170;
/** `170 * PEAK_OVERSHOOT_FACTOR` (1.017) — force-consistent with `DEFAULT_WEIGHT_LBS`, so a
 *  fixture that doesn't override `peakForce` never trips `weight_implied_mismatch` by accident. */
const FORCE_CONSISTENT_PEAK_FORCE = DEFAULT_WEIGHT_LBS * 1.017;

function makeRep(
  setId: string,
  index: number,
  overrides: { peakVelocity?: number; meanVelocity?: number; peakForce?: number } = {},
): StoredRep {
  // `getRepMeanVelocity` reads `_totalVelocity / _movementSampleCount`, not
  // `peakVelocity` — set both so a fixture's "velocity" reads the same way to
  // every WA consumer (mean- and peak-based alike), unless a mean is supplied.
  const velocity = overrides.peakVelocity ?? 0.6;
  const rep: Rep = {
    repNumber: index + 1,
    concentric: {
      ...EMPTY_PHASE,
      peakVelocity: velocity,
      peakForce: overrides.peakForce ?? FORCE_CONSISTENT_PEAK_FORCE,
      _totalVelocity: overrides.meanVelocity ?? velocity,
      _movementSampleCount: 1,
    },
    eccentric: { ...EMPTY_PHASE, peakVelocity: 0.4, _totalVelocity: 0.4, _movementSampleCount: 1 },
  };
  return { ...rep, id: `${setId}-r${String(index)}`, setId, index };
}

function makeSet(overrides: Partial<StoredSet> & { id: string }): StoredSet {
  return {
    sessionId: 'sess-1',
    exerciseId: EXERCISE_ID,
    startedAt: '2026-09-08T12:00:00.000Z',
    endedAt: '2026-09-08T12:01:00.000Z',
    partial: false,
    weightLbs: DEFAULT_WEIGHT_LBS,
    reps: [makeRep(overrides.id, 0), makeRep(overrides.id, 1)],
    ...overrides,
  };
}

function makeState(store: SqliteSessionStore): ServerState {
  return {
    config: { adapter: 'node' },
    store,
    exercises: { getById: () => undefined },
  } as unknown as ServerState;
}

function insertSelfReport(
  store: SqliteSessionStore,
  row: {
    id: string;
    muscleGroup?: string;
    questionCode?: string;
    valueNum?: number;
    valueText?: string;
    recordedAt: string;
  },
): void {
  rawDb(store)
    .prepare(
      `INSERT INTO self_reports
        (id, user_id, session_id, set_id, muscle_group, kind, question_code, value_num, value_text, recorded_at)
       VALUES (?, ?, NULL, NULL, ?, 'check_in', ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      LOCAL_USER_ID,
      row.muscleGroup ?? null,
      row.questionCode ?? null,
      row.valueNum ?? null,
      row.valueText ?? null,
      row.recordedAt,
    );
}

/** Marks the `rir-estimate` gate CALIBRATED (full) for `EXERCISE_ID`, side-agnostic. */
function calibrateRirBaseline(store: SqliteSessionStore): void {
  const id = baselineKeyId({ userId: LOCAL_USER_ID, exerciseId: EXERCISE_ID });
  rawDb(store)
    .prepare(
      `INSERT INTO exercise_baselines
        (id, user_id, exercise_id, state, observed_sessions, anchor_count, updated_at, algorithm_version)
       VALUES (?, ?, ?, 'CALIBRATED', 5, 5, ?, 'v1')`,
    )
    .run(id, LOCAL_USER_ID, EXERCISE_ID, '2026-09-08T00:00:00.000Z');
}

/** Inserts a fitted RIR-velocity curve (VW-298) for `EXERCISE_ID`, VW-310's fitted-path fixture. */
function fitRirVelocityRow(
  store: SqliteSessionStore,
  { interceptMps, slopeMpsPerRir }: { interceptMps: number; slopeMpsPerRir: number },
): void {
  const model = {
    form: 'linear',
    version: RIR_VELOCITY_MODEL_VERSION,
    resistanceFamily: 'constant',
    interceptMps,
    slopeMpsPerRir,
    r2: 0.9,
    seeMps: 0.05,
    rirErrorReps: 0.5,
    pointCount: 12,
    setCount: 3,
    sessionCount: 2,
    rirRange: [0, 5],
    intensityRange: [0.7, 0.9],
    anchorSources: { failure: 2, selfReport: 1 },
    observedFrom: '2026-08-01T00:00:00.000Z',
    observedTo: '2026-09-01T00:00:00.000Z',
  };
  rawDb(store)
    .prepare(
      `INSERT INTO rir_velocity_models
        (user_id, exercise_id, model_json, fitted_at, sample_size, fit_quality)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(LOCAL_USER_ID, EXERCISE_ID, JSON.stringify(model), '2026-09-08T00:00:00.000Z', 12, 0.9);
}

describe('report.weekly', () => {
  let store: SqliteSessionStore;

  beforeEach(() => {
    store = SqliteSessionStore.open(':memory:');
  });

  afterEach(async () => {
    await store.close();
  });

  it("computes adherence as planned N / done M against the touched week's templates", async () => {
    // Arrange: a 3-template week, two templates attached to ended sessions,
    // one session in range with no assignment at all.
    await store.putTrainingProgram({
      id: 'prog-1',
      name: 'Base',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await store.putTrainingBlock({
      id: 'block-1',
      programId: 'prog-1',
      orderIndex: 0,
      name: 'Block 1',
      weeksCount: 1,
    });
    await store.putTrainingWeek({ id: 'week-1', blockId: 'block-1', orderIndex: 0 });
    await store.putWorkoutTemplate({
      id: 'tpl-1',
      weekId: 'week-1',
      name: 'Upper A',
      orderIndex: 0,
    });
    await store.putWorkoutTemplate({
      id: 'tpl-2',
      weekId: 'week-1',
      name: 'Lower A',
      orderIndex: 1,
    });
    await store.putWorkoutTemplate({
      id: 'tpl-3',
      weekId: 'week-1',
      name: 'Upper B',
      orderIndex: 2,
    });

    await seedTrainingDay(store, {
      kind: 'training',
      id: 's1',
      startedAt: '2026-09-08T00:00:00.000Z',
      endedAt: '2026-09-08T00:30:00.000Z',
    });
    await store.putProgramAssignment({
      id: 'a1',
      sessionId: 's1',
      workoutTemplateId: 'tpl-1',
      assignedAt: '2026-09-08T00:00:00.000Z',
    });
    await seedTrainingDay(store, {
      kind: 'training',
      id: 's2',
      startedAt: '2026-09-09T00:00:00.000Z',
      endedAt: '2026-09-09T00:30:00.000Z',
    });
    await store.putProgramAssignment({
      id: 'a2',
      sessionId: 's2',
      workoutTemplateId: 'tpl-2',
      assignedAt: '2026-09-09T00:00:00.000Z',
    });
    // An unattached, unplanned session in the same range.
    await seedTrainingDay(store, {
      kind: 'training',
      id: 's3',
      startedAt: '2026-09-10T00:00:00.000Z',
      endedAt: '2026-09-10T00:30:00.000Z',
    });

    // Act
    const report = await buildWeeklyReport(makeState(store), {
      from: '2026-09-07T00:00:00.000Z',
      to: '2026-09-11T00:00:00.000Z',
    });

    // Assert
    expect(report.header.adherence).toEqual({
      planned: 3,
      done: 2,
      trend: 'no-prior-data',
      // No block is dated in this fixture, so the older touched-weeks rule counts (VW-478).
      basis: 'touched_weeks',
      weeks: [],
    });
    expect(report.header.trainingDaysCompleted).toBe(3);
  });

  // VW-489. An empty week and a withheld week read the same in the counts, so the
  // header has to say which one it is or the coach reads "no training".
  it('leaves an unreviewed day out of both counts and says how many are waiting', async () => {
    const at = new Date(2026, 8, 8, 9);
    await store.putSession({
      id: 'unreviewed',
      startedAt: at.toISOString(),
      endedAt: new Date(at.getTime() + 60_000).toISOString(),
    });
    await store.putSet({
      id: 'unreviewed-set',
      sessionId: 'unreviewed',
      startedAt: at.toISOString(),
      endedAt: new Date(at.getTime() + 30_000).toISOString(),
      partial: false,
      reps: [],
    });

    const report = await buildWeeklyReport(makeState(store), {
      from: new Date(2026, 8, 7).toISOString(),
      to: new Date(2026, 8, 11).toISOString(),
    });

    expect(report.header.trainingDaysCompleted).toBe(0);
    expect(report.header.rolling28DayTrainingDays).toBe(0);
    expect(report.header.unreviewedDays).toBe(1);
  });

  it('counts twelve sessions on one local day as one training day in both header counts (VW-462)', async () => {
    for (let i = 0; i < 12; i++) {
      const start = new Date(2026, 8, 8, 9, i * 4);
      await seedTrainingDay(store, {
        kind: 'training',
        id: `row-${i}`,
        startedAt: start.toISOString(),
        endedAt: new Date(start.getTime() + 3 * 60_000).toISOString(),
      });
    }

    const report = await buildWeeklyReport(makeState(store), {
      from: new Date(2026, 8, 7).toISOString(),
      to: new Date(2026, 8, 11).toISOString(),
    });

    expect(report.sessions).toHaveLength(12);
    expect(report.header.trainingDaysCompleted).toBe(1);
    expect(report.header.rolling28DayTrainingDays).toBe(1);
  });

  it("omits a guest lifter's sets from a session's rendered exercises", async () => {
    await seedTrainingDay(store, {
      kind: 'training',
      id: 'sess-1',
      startedAt: '2026-09-08T12:00:00.000Z',
      endedAt: '2026-09-08T12:30:00.000Z',
    });
    await store.putSet(makeSet({ id: 's1' }));
    await store.putSet(makeSet({ id: 'guest-1', lifter: 'Jordan', weightLbs: 300 }));

    const report = await buildWeeklyReport(makeState(store), {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-15T00:00:00.000Z',
    });

    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]?.exercises[0]?.result).toContain('170 lb');
    expect(report.sessions[0]?.exercises[0]?.result).not.toContain('300');
  });

  it('flags a velocity-loss hold from a ratio, correct even on a device_native set', async () => {
    // Arrange: a set marked `device_native` (unconverted mm/s-scale numbers)
    // whose final rep drops far enough below the first to cross VL30. The
    // flag is a ratio of same-set values, so it must read correctly whether
    // or not the absolute numbers have been through `normaliseVelocityToMps`.
    await seedTrainingDay(store, {
      kind: 'training',
      id: 'sess-1',
      startedAt: '2026-09-08T12:00:00.000Z',
      endedAt: '2026-09-08T12:30:00.000Z',
    });
    await store.putSet(
      makeSet({
        id: 'hold-1',
        velocityUnits: 'device_native',
        reps: [
          makeRep('hold-1', 0, { peakVelocity: 600 }),
          makeRep('hold-1', 1, { peakVelocity: 350 }),
        ],
      }),
    );

    const report = await buildWeeklyReport(makeState(store), {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-15T00:00:00.000Z',
    });

    expect(report.flags.velocityLossHold).toHaveLength(1);
    expect(report.flags.velocityLossHold[0]).toMatchObject({ setId: 'hold-1' });
    expect(report.flags.velocityLossHold[0]?.lossPct).toBeCloseTo(((600 - 350) / 600) * 100, 5);
  });

  it('omits the RIR line when the rir-estimate gate is withheld (no baseline)', async () => {
    await seedTrainingDay(store, {
      kind: 'training',
      id: 'sess-1',
      startedAt: '2026-09-08T12:00:00.000Z',
      endedAt: '2026-09-08T12:30:00.000Z',
    });
    await store.putSet(makeSet({ id: 's1' }));

    const report = await buildWeeklyReport(makeState(store), {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-15T00:00:00.000Z',
    });

    expect(report.sessions[0]?.exercises[0]?.rir).toBeNull();
  });

  it('includes the RIR line only once the rir-estimate gate is CALIBRATED, general-model labelled (VW-310)', async () => {
    calibrateRirBaseline(store);
    await seedTrainingDay(store, {
      kind: 'training',
      id: 'sess-1',
      startedAt: '2026-09-08T12:00:00.000Z',
      endedAt: '2026-09-08T12:30:00.000Z',
    });
    await store.putSet(makeSet({ id: 's1' }));

    const report = await buildWeeklyReport(makeState(store), {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-15T00:00:00.000Z',
    });

    // Pinned pre-VW-310: no fitted curve exists, so the number itself is
    // unchanged from the plain `estimateRIRWithProfile` fallback — only the
    // label changed, to stop a coach reading it as proximity to failure.
    expect(report.sessions[0]?.exercises[0]?.rir).toBe(
      'RIR (final rep, general model, not a proximity-to-failure read): 3.5',
    );
  });

  it('labels the RIR line "fitted" once the lifter has a fitted RIR-velocity curve (VW-310)', async () => {
    calibrateRirBaseline(store);
    fitRirVelocityRow(store, { interceptMps: 0.3, slopeMpsPerRir: 0.15 });
    await seedTrainingDay(store, {
      kind: 'training',
      id: 'sess-1',
      startedAt: '2026-09-08T12:00:00.000Z',
      endedAt: '2026-09-08T12:30:00.000Z',
    });
    await store.putSet(makeSet({ id: 's1' }));

    const report = await buildWeeklyReport(makeState(store), {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-15T00:00:00.000Z',
    });

    // Final rep peaks at 0.6 m/s: (0.6 - 0.3) / 0.15 = 2.
    expect(report.sessions[0]?.exercises[0]?.rir).toBe('RIR (final rep, fitted): 2.0');
  });

  it('reads the fitted curve with the final rep mean velocity, not its peak (VW-483)', async () => {
    calibrateRirBaseline(store);
    fitRirVelocityRow(store, { interceptMps: 0.3, slopeMpsPerRir: 0.15 });
    await seedTrainingDay(store, {
      kind: 'training',
      id: 'sess-1',
      startedAt: '2026-09-08T12:00:00.000Z',
      endedAt: '2026-09-08T12:30:00.000Z',
    });
    const reps = [0, 1].map((i) => makeRep('s1', i, { peakVelocity: 0.6, meanVelocity: 0.45 }));
    await store.putSet(makeSet({ id: 's1', reps }));

    const report = await buildWeeklyReport(makeState(store), {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-15T00:00:00.000Z',
    });

    // The peak would read (0.6 - 0.3) / 0.15 = 2; the mean reads 1.
    expect(report.sessions[0]?.exercises[0]?.rir).toBe('RIR (final rep, fitted): 1.0');
  });

  it('clusters repeated check-in text and surfaces repeated off-code muscle groups', async () => {
    insertSelfReport(store, {
      id: 'r1',
      muscleGroup: 'quads',
      questionCode: 'off',
      valueText: 'still sore',
      recordedAt: '2026-09-08T08:00:00.000Z',
    });
    insertSelfReport(store, {
      id: 'r2',
      muscleGroup: 'quads',
      questionCode: 'off',
      valueText: 'still sore',
      recordedAt: '2026-09-10T08:00:00.000Z',
    });
    insertSelfReport(store, {
      id: 'r3',
      muscleGroup: 'shoulders',
      questionCode: 'rpe',
      valueText: 'felt great',
      recordedAt: '2026-09-11T08:00:00.000Z',
    });

    const report = await buildWeeklyReport(makeState(store), {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-15T00:00:00.000Z',
    });

    expect(report.checkIn?.source).toBe('self_reports');
    expect(report.checkIn?.themes).toContainEqual({ text: 'still sore', count: 2 });
    expect(report.checkIn?.repeatedOffMuscleGroups).toEqual(['quads']);
  });

  it('falls back to input.notes as a lifter note when no self_reports rows exist', async () => {
    const report = await buildWeeklyReport(makeState(store), {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-15T00:00:00.000Z',
      notes: 'knee felt tight on squats',
    });

    expect(report.checkIn).toEqual({
      source: 'notes',
      entries: [],
      themes: [],
      repeatedOffMuscleGroups: [],
      notes: 'knee felt tight on squats',
    });
  });

  it('omits the check-in section entirely when there are no rows and no notes', async () => {
    const report = await buildWeeklyReport(makeState(store), {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-15T00:00:00.000Z',
    });

    expect(report.checkIn).toBeNull();
  });

  it('lists preSessionCarbs on the session entry, and omits it when absent (VW-307)', async () => {
    await seedTrainingDay(store, {
      kind: 'training',
      id: 'sess-carbs',
      startedAt: '2026-09-08T12:00:00.000Z',
      endedAt: '2026-09-08T12:30:00.000Z',
      preSessionCarbs: { level: 'low', hoursSinceLastMeal: 4 },
    });
    await seedTrainingDay(store, {
      kind: 'training',
      id: 'sess-no-carbs',
      startedAt: '2026-09-09T12:00:00.000Z',
      endedAt: '2026-09-09T12:30:00.000Z',
    });

    const report = await buildWeeklyReport(makeState(store), {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-15T00:00:00.000Z',
    });

    const withCarbs = report.sessions.find((s) => s.sessionId === 'sess-carbs');
    expect(withCarbs?.preSessionCarbs).toEqual({ level: 'low', hoursSinceLastMeal: 4 });
    const withoutCarbs = report.sessions.find((s) => s.sessionId === 'sess-no-carbs');
    expect(withoutCarbs?.preSessionCarbs).toBeUndefined();

    const markdown = renderWeeklyMarkdown(report);
    expect(markdown).toContain('Pre-session carbs: low (4h since last meal)');
  });

  it('renders markdown that is paste-safe: no HTML tags, no emoji, no wide tables', async () => {
    await seedTrainingDay(store, {
      kind: 'training',
      id: 'sess-1',
      startedAt: '2026-09-08T12:00:00.000Z',
      endedAt: '2026-09-08T12:30:00.000Z',
    });
    await store.putSet(makeSet({ id: 's1' }));
    insertSelfReport(store, {
      id: 'r1',
      muscleGroup: 'quads',
      questionCode: 'off',
      valueText: 'sore',
      recordedAt: '2026-09-08T08:00:00.000Z',
    });

    const report = await buildWeeklyReport(makeState(store), {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-15T00:00:00.000Z',
    });
    const markdown = renderWeeklyMarkdown(report);

    expect(markdown).not.toMatch(/<[a-zA-Z][^>]*>/);
    expect(markdown).not.toMatch(/\p{Extended_Pictographic}/u);
    for (const line of markdown.split('\n')) {
      const columns = line.split('|').length - 1;
      expect(columns).toBeLessThanOrEqual(4);
    }
  });

  it('renders every number in markdown identically to the JSON tree (same source)', async () => {
    // Arrange: exercise every numeric field at once — adherence, the two
    // session-level counts, all three live flags, and a check-in theme count —
    // so this test cannot pass by checking only the fields an earlier test
    // happened to cover.
    await store.putTrainingProgram({
      id: 'prog-1',
      name: 'Base',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await store.putTrainingBlock({
      id: 'block-1',
      programId: 'prog-1',
      orderIndex: 0,
      name: 'Block 1',
      weeksCount: 1,
    });
    await store.putTrainingWeek({ id: 'week-1', blockId: 'block-1', orderIndex: 0 });
    await store.putWorkoutTemplate({
      id: 'tpl-1',
      weekId: 'week-1',
      name: 'Upper A',
      orderIndex: 0,
    });
    await store.putWorkoutTemplate({
      id: 'tpl-2',
      weekId: 'week-1',
      name: 'Lower A',
      orderIndex: 1,
    });

    await seedTrainingDay(store, {
      kind: 'training',
      id: 'sess-1',
      startedAt: '2026-09-08T12:00:00.000Z',
      endedAt: '2026-09-08T12:30:00.000Z',
    });
    await store.putProgramAssignment({
      id: 'a1',
      sessionId: 'sess-1',
      workoutTemplateId: 'tpl-1',
      assignedAt: '2026-09-08T12:00:00.000Z',
    });
    // Mismatched header weight (170) vs. a much higher recorded force, an
    // inactivity-timeout close with reps, and a device_native velocity-loss
    // hold — one set per flag, all in the same reported session.
    await store.putSet(
      makeSet({
        id: 'mismatch-1',
        reps: [
          makeRep('mismatch-1', 0, { peakForce: 400 }),
          makeRep('mismatch-1', 1, { peakForce: 400 }),
        ],
      }),
    );
    await store.putSet(
      makeSet({ id: 'timeout-1', partial: true, partialReason: 'inactivity_timeout' }),
    );
    await store.putSet(
      makeSet({
        id: 'hold-1',
        velocityUnits: 'device_native',
        reps: [
          makeRep('hold-1', 0, { peakVelocity: 600 }),
          makeRep('hold-1', 1, { peakVelocity: 350 }),
        ],
      }),
    );

    // A second, unattached session, so adherence sees planned 2 / done 1.
    await seedTrainingDay(store, {
      kind: 'training',
      id: 'sess-2',
      startedAt: '2026-09-09T12:00:00.000Z',
      endedAt: '2026-09-09T12:30:00.000Z',
    });

    insertSelfReport(store, {
      id: 'r1',
      questionCode: 'rpe',
      valueText: 'felt heavy',
      recordedAt: '2026-09-08T08:00:00.000Z',
    });
    insertSelfReport(store, {
      id: 'r2',
      questionCode: 'rpe',
      valueText: 'felt heavy',
      recordedAt: '2026-09-09T08:00:00.000Z',
    });

    const report = await buildWeeklyReport(makeState(store), {
      from: '2026-09-07T00:00:00.000Z',
      to: '2026-09-11T00:00:00.000Z',
    });
    const markdown = renderWeeklyMarkdown(report);

    // Sanity: this fixture actually exercises every field being compared.
    expect(report.flags.weightImpliedMismatch).toHaveLength(1);
    expect(report.flags.inactivityTimeout).toHaveLength(1);
    expect(report.flags.velocityLossHold).toHaveLength(1);
    expect(report.checkIn?.themes).toHaveLength(1);

    expect(markdown).toContain(`Training days: ${report.header.trainingDaysCompleted}`);
    expect(markdown).toContain(
      `Last 28 days: ${report.header.rolling28DayTrainingDays} training days`,
    );
    const adherence = report.header.adherence!;
    expect(markdown).toContain(
      `Adherence: planned ${adherence.planned} / done ${adherence.done} (trend: ${adherence.trend})`,
    );
    expect(markdown).toContain(
      `- weight_implied_mismatch: ${report.flags.weightImpliedMismatch.length} set(s)`,
    );
    expect(markdown).toContain(
      `- inactivity_timeout with reps recorded: ${report.flags.inactivityTimeout.length} set(s)`,
    );
    expect(markdown).toContain(
      `- velocity-loss holds: ${report.flags.velocityLossHold.length} set(s)`,
    );
    const theme = report.checkIn!.themes[0]!;
    expect(markdown).toContain(`- ${theme.text} (${theme.count})`);
    for (const session of report.sessions) {
      for (const exercise of session.exercises) {
        expect(markdown).toContain(exercise.result);
      }
    }
  });
});
