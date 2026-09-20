// A store with at least one row in EVERY table, for the export/import/verify
// round trip (VW-534).
//
// Written through the store's own port methods wherever one exists, so the rows
// are shaped the way the server shapes them rather than the way a test author
// guesses. EIGHT TABLES HAVE NO WRITER ANYWHERE IN `src/` — `cue_state`,
// `device_bindings`, `device_events`, `disruption_windows`,
// `exercise_substitutions`, `learned_rest`, `limitations` and
// `rir_velocity_models` (whose only writer refuses to insert without a real
// velocity corpus). Those eight are seeded with direct inserts, marked below.
//
// `everyTableIsPopulated` is the guard: a table added by a later migration and
// not seeded here fails the round-trip test loudly instead of quietly exporting
// as an empty file that always round-trips.

import { DatabaseSync } from 'node:sqlite';
import type { Phase } from '@voltras/workout-analytics';

import { LOCAL_USER_ID, SqliteSessionStore } from '../../sqlite-store.js';
import type { StoredRep, StoredSession, StoredSet } from '../../types.js';

export const FIXTURE_EXERCISE_ID = 'ex-back-squat';
export const FIXTURE_SESSION_ID = 'sess-round-trip';
export const FIXTURE_SET_ID = 'set-round-trip';

const AT = '2026-03-02T17:00:00.000Z';

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

function rep(index: number): StoredRep {
  return {
    id: `${FIXTURE_SET_ID}-rep-${index}`,
    setId: FIXTURE_SET_ID,
    index,
    repNumber: index + 1,
    concentric: { ...EMPTY_PHASE, peakVelocity: 0.5 - index * 0.02 },
    eccentric: { ...EMPTY_PHASE, peakVelocity: 0.3 },
  };
}

const SESSION: StoredSession = {
  id: FIXTURE_SESSION_ID,
  startedAt: AT,
  endedAt: '2026-03-02T18:00:00.000Z',
  exerciseId: FIXTURE_EXERCISE_ID,
  exerciseName: 'Back Squat',
  notes: 'round-trip fixture',
  kind: 'training',
};

const SET: StoredSet = {
  id: FIXTURE_SET_ID,
  sessionId: FIXTURE_SESSION_ID,
  startedAt: AT,
  endedAt: '2026-03-02T17:02:00.000Z',
  partial: false,
  trainingMode: 'WeightTraining',
  weightLbs: 225,
  setPurpose: 'working',
  exerciseId: FIXTURE_EXERCISE_ID,
  side: 'left',
  deviceId: 'dev-left',
  slot: 'left',
  setIndexInSession: 1,
  reps: [rep(0), rep(1), rep(2)],
};

/** Builds a store at `path` holding at least one row in every table, and closes it. */
export async function seedEveryTable(path: string): Promise<void> {
  const store = SqliteSessionStore.open(path);
  try {
    await seedTraining(store);
    await seedPlanTree(store);
    await seedProfileAndGoals(store);
    await seedAudit(store);
  } finally {
    await store.close();
  }
  seedTablesWithNoWriter(path);
}

async function seedTraining(store: SqliteSessionStore): Promise<void> {
  await store.putSession(SESSION);
  await store.putSet(SET);
  await store.putSelfReport({
    id: 'self-1',
    userId: LOCAL_USER_ID,
    sessionId: FIXTURE_SESSION_ID,
    setId: FIXTURE_SET_ID,
    muscleGroup: 'quads',
    kind: 'rir',
    valueNum: 2,
    recordedAt: AT,
  });
  await store.putIdleRep({
    id: 'idle-1',
    userId: LOCAL_USER_ID,
    sessionId: FIXTURE_SESSION_ID,
    deviceId: 'dev-left',
    slot: 'left',
    side: 'left',
    observedAt: AT,
    weightLbs: 45,
    rep: rep(0),
  });
  await store.putIsometricMeasurement({
    id: 'iso-1',
    measuredAt: AT,
    analysisVersion: 1,
    durationMs: 5000,
    trialsRequested: 3,
    restMs: 30000,
    userId: LOCAL_USER_ID,
    exerciseId: FIXTURE_EXERCISE_ID,
    sessionId: FIXTURE_SESSION_ID,
    sides: [
      {
        side: 'left',
        deviceId: 'dev-left',
        trials: [
          {
            id: 'iso-trial-1',
            index: 1,
            peakForceLbs: 180,
            plateauForceLbs: 170,
            plateauStartMs: 1000,
            plateauEndMs: 4000,
            valid: true,
          },
        ],
      },
    ],
  });
  await store.putFailureAnchor({
    id: 'anchor-1',
    userId: LOCAL_USER_ID,
    setId: FIXTURE_SET_ID,
    exerciseId: FIXTURE_EXERCISE_ID,
    side: 'left',
    observedAt: AT,
    source: 'harvested',
    terminalVelocityMps: 0.21,
    loadLbs: 225,
    repCount: 3,
    filterInputs: { lastRepVelocity: 0.21 },
    filterVerdict: 'failure',
    filterVersion: 'test@1',
  });
  await store.recalcBaseline({ userId: LOCAL_USER_ID, exerciseId: FIXTURE_EXERCISE_ID });
  await store.putExerciseSetup({
    id: 'setup-1',
    userId: LOCAL_USER_ID,
    exerciseId: FIXTURE_EXERCISE_ID,
    label: 'Setup 1',
    detectedAt: AT,
    confirmedAt: AT,
    clusterVersion: 'setup@1',
  });
  await store.markExerciseChapter({
    userId: LOCAL_USER_ID,
    exerciseId: FIXTURE_EXERCISE_ID,
    startedAt: AT,
    declaredAt: AT,
    reason: 'technique reform',
  });
}

async function seedPlanTree(store: SqliteSessionStore): Promise<void> {
  await store.putTrainingProgram({ id: 'prog-1', name: 'Base', createdAt: AT });
  await store.putTrainingBlock({
    id: 'block-1',
    programId: 'prog-1',
    orderIndex: 0,
    name: 'Accumulation',
    weeksCount: 4,
  });
  await store.putTrainingWeek({
    id: 'week-1',
    blockId: 'block-1',
    orderIndex: 0,
    name: 'Week 1',
    isDeload: false,
    weekIndex: 1,
  });
  await store.putWorkoutTemplate({
    id: 'tmpl-1',
    weekId: 'week-1',
    name: 'Lower A',
    orderIndex: 0,
    dayLabel: 'Mon',
  });
  await store.putPlannedExercise({
    id: 'pex-1',
    workoutTemplateId: 'tmpl-1',
    exerciseId: FIXTURE_EXERCISE_ID,
    orderIndex: 0,
    targetSets: 3,
    targetRepsLow: 5,
    targetRepsHigh: 8,
  });
  await store.putProgramAssignment({
    id: 'assign-1',
    sessionId: FIXTURE_SESSION_ID,
    plannedExerciseId: 'pex-1',
    workoutTemplateId: 'tmpl-1',
    assignedAt: AT,
  });
  await store.appendBlockSchedule({
    blockId: 'block-1',
    startsOn: '2026-03-02',
    weeksCount: 4,
    skips: [],
    kind: 'planned',
    changedBy: 'user',
    declaredAt: AT,
  });
}

async function seedProfileAndGoals(store: SqliteSessionStore): Promise<void> {
  await store.putTrainingProfile({
    userId: LOCAL_USER_ID,
    declaredTier: 'intermediate',
    declaredAt: AT,
    yearsTraining: 6,
    goal: 'strength',
    updatedAt: AT,
  });
  await store.putAccountabilityState({
    userId: LOCAL_USER_ID,
    state: 'planned',
    enteredAt: AT,
    consecutiveMisses: 0,
    ghostSends: [],
    lastInboundAt: null,
    proactiveSends: [],
    holdingUntil: null,
  });
  await store.declareDietPhase({
    userId: LOCAL_USER_ID,
    phase: 'maintenance',
    startedAt: AT,
    declaredAt: AT,
  });
  await store.declareCommitment({
    userId: LOCAL_USER_ID,
    effectiveFrom: '2026-03-02',
    days: [{ day: 'monday', fallbackDay: 'tuesday' }],
    ifThen: 'If Monday breaks, I lift Tuesday.',
    wording: 'Three lifts a week.',
    declaredAt: AT,
  });
  await store.putBodyMetric({ userId: LOCAL_USER_ID, measuredAt: AT, bodyweightLbs: 183.4 });
  await store.putPriority({
    id: 'pri-1',
    userId: LOCAL_USER_ID,
    horizonWeeks: 12,
    kind: 'lift',
    ref: FIXTURE_EXERCISE_ID,
    level: 'specialize',
    declaredAt: AT,
    mesosHeld: 0,
  });
  await store.putGoalTarget({
    id: 'tgt-1',
    priorityId: 'pri-1',
    metric: 'top_load_at_reps',
    startValue: 225,
    startMeasuredAt: AT,
    bandLowPctPerWeek: 0.5,
    bandHighPctPerWeek: 1.5,
    committedValue: 245,
    stretchValue: 255,
    basis: 'rp_ramp',
    infoLevel: 'ramp',
    tierUsed: 'intermediate',
    tierProvisional: false,
    dietPhaseAtDerivation: 'maintenance',
    acknowledgedStretch: false,
    derivedAt: AT,
    endsAt: '2026-05-25T17:00:00.000Z',
  });
}

async function seedAudit(store: SqliteSessionStore): Promise<void> {
  await store.putAdvisoryDecision({
    userId: LOCAL_USER_ID,
    sessionId: FIXTURE_SESSION_ID,
    code: 'goal_fat_loss_specialize_downgrade',
    issuedAt: AT,
    inputs: { weeks: 4 },
    thresholds: { weeks: 3 },
    algorithmVersion: 'advisory@1',
    verdict: 'downgrade',
    userResponse: 'accepted',
    respondedAt: AT,
  });
  await store.claimUiAction({
    actionId: 'uia-1',
    actionName: 'goal.accept_target',
    actor: 'user',
    surface: 'wall',
    deviceId: 'wall-kitchen',
    inputHash: 'hash-1',
    createdAt: AT,
  });
  await store.completeUiAction({
    actionId: 'uia-1',
    resultStatus: 'ok',
    result: { accepted: true },
    completedAt: AT,
  });
}

/**
 * The eight tables no code in `src/` writes. Seeded with direct inserts so the
 * round trip covers them; the moment one of them grows a port method this block
 * should shrink.
 */
function seedTablesWithNoWriter(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    seedDeviceRows(db);
    seedDeclaredRows(db);
    seedDerivedRows(db);
  } finally {
    db.close();
  }
}

function seedDeviceRows(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO device_bindings (user_id, device_id, side, bound_at, last_seen)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(LOCAL_USER_ID, 'dev-left', 'left', AT, AT);
  db.prepare(
    `INSERT INTO device_events (id, user_id, session_id, device_id, slot, kind, at, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('devt-1', LOCAL_USER_ID, FIXTURE_SESSION_ID, 'dev-left', 'left', 'connected', AT, '{}');
  db.prepare(
    `INSERT INTO cue_state
       (id, user_id, exercise_id, fault_code, escalation_rung, sessions_persisted,
        first_seen_at, last_seen_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('cue-1', LOCAL_USER_ID, FIXTURE_EXERCISE_ID, 'depth', 1, 2, AT, AT, null);
}

function seedDeclaredRows(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO limitations
       (id, user_id, kind, body_region, pain_class, severity, declared_at, loosens_at,
        resolved_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('lim-1', LOCAL_USER_ID, 'pain', 'knee', 'joint', 'mild', AT, null, null, 'right knee');
  db.prepare(
    `INSERT INTO disruption_windows
       (id, user_id, kind, started_at, ended_at, declared_at, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('disr-1', LOCAL_USER_ID, 'travel', AT, null, AT, 'two weeks away');
  db.prepare(
    `INSERT INTO exercise_substitutions
       (id, user_id, from_exercise_id, to_exercise_id, reason_code, rationale_text,
        proposed_by, accepted, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'sub-1',
    LOCAL_USER_ID,
    FIXTURE_EXERCISE_ID,
    'ex-front-squat',
    'pain',
    'knee',
    'user',
    1,
    AT,
  );
}

function seedDerivedRows(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO rir_velocity_models
       (user_id, exercise_id, model_json, fitted_at, sample_size, fit_quality)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(LOCAL_USER_ID, FIXTURE_EXERCISE_ID, '{"slope":-0.02}', AT, 12, 0.87);
  db.prepare(
    `INSERT INTO learned_rest
       (user_id, exercise_id, intent, context, value_sec, state, base_sec, base_source,
        plan_base_sec, run_started_on, last_evaluated_on, last_step_on, days_evaluated,
        informative_pairs, history_json, policy_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    LOCAL_USER_ID,
    FIXTURE_EXERCISE_ID,
    'hypertrophy',
    'straight',
    165,
    'calibrating',
    150,
    'intent_default',
    null,
    '2026-03-02',
    '2026-03-02',
    null,
    3,
    2,
    '[]',
    'rest@1',
    AT,
  );
}
