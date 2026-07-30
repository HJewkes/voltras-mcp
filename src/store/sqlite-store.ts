// SqliteSessionStore — the only built-in implementation of `SessionStore`.
//
// Backed by Node 22's built-in `node:sqlite`. Schema is embedded as a
// constant and versioned via `PRAGMA user_version`; mismatched DBs are
// rejected with `SCHEMA_INCOMPATIBLE` (R17, no automatic migration in v1).
// On open, a small write probe (`BEGIN IMMEDIATE` / `COMMIT`) acquires and
// releases a transient write lock so that concurrent processes contesting
// the same `VMCP_DB_PATH` are detected up-front (R8); the resulting error
// surfaces the env-var name and "already in use" hint expected by the
// README's concurrency note.
//
// The `Rep` type from `@voltras/workout-analytics` carries nested `Phase`
// objects with sample arrays, so each rep is persisted as a JSON-serialised
// payload rather than a wide flat row. The `id`/`setId`/`index` columns
// (StoredRep's own additions) remain queryable.
//
// Set persistence is atomic: `putSet` runs a transaction that upserts the
// set row and replaces the entire rep array, so retries (e.g. force-end on
// disconnect followed by an explicit re-end) never leave stale reps behind.

import { DatabaseSync } from 'node:sqlite';
import type { BaselineKey, Rep } from '@voltras/workout-analytics';
import { log } from '../logger.js';
import {
  baselineRowId,
  deriveBaselineState,
  summarizeSets,
  toBaselineRow,
  type AnchorObservation,
  type BaselineObservations,
} from './exercise-baselines.js';
import {
  LOCAL_USER_ID,
  type BaselineState,
  type ExerciseSetsFilter,
  type SessionCountFilter,
  type SessionDateSpan,
  type SessionListFilter,
  type SessionStore,
  type SetCountFilter,
  type StoredIdleRep,
  type StoredIsometricMeasurement,
  type StoredIsometricSideMeasurement,
  type StoredIsometricTrial,
  type StoredPlannedExercise,
  type StoredExerciseBaseline,
  type StoredProgramAssignment,
  type StoredRep,
  type StoredSession,
  type StoredSet,
  type StoredSide,
  type StoredTrainingBlock,
  type StoredTrainingProfile,
  type StoredTrainingProgram,
  type StoredTrainingWeek,
  type StoredWorkoutTemplate,
} from './types.js';

const SCHEMA_VERSION = 10;

// `LOCAL_USER_ID` moved to `types.ts` (VMCP-01.72b, N12) so the tool layer
// can import the constant from the persistence CONTRACT rather than this
// implementation file; re-exported here for existing call sites.
export { LOCAL_USER_ID };

/**
 * Page size `listIdleReps` falls back to when the caller names none. Idle reps
 * accrue at telemetry pace during long rests, so an unbounded default would
 * hand a caller an unbounded result set; matching `listSessions`, the bound is
 * explicit rather than absent.
 */
const IDLE_REP_LIST_DEFAULT_LIMIT = 100;

const SCHEMA_SQL = `
  -- ── Identity (v6) ────────────────────────────────────────────────────
  -- Declared before everything that references it. SQLite resolves foreign
  -- keys at DML time rather than DDL time, so the order is for readers.

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    created_at TEXT NOT NULL,
    -- Exactly one row carries is_default=1: the implicit local user every
    -- pre-v6 row is attributed to. Seeded by seedLocalUser.
    is_default INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    exercise_id TEXT,
    exercise_name TEXT,
    notes TEXT,
    -- v6 additions. sessions is an FK parent (program_assignments cascades
    -- off it), so it takes ADD COLUMN only and is never rebuilt.
    user_id TEXT REFERENCES users(id),
    bilateral_group_id TEXT,
    source TEXT NOT NULL DEFAULT 'local',
    -- The exercise→muscle map lives in the WA catalog, outside this DB. Without
    -- the catalog version a re-classification silently rewrites every
    -- historical per-muscle rollup and old charts stop reproducing.
    catalog_version TEXT,
    -- Denormalized from diet_phases, stamped at write. The table is the
    -- source of truth and is retroactively correctable; this column is what
    -- filters cheaply.
    diet_phase TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
  -- NOTE: indexes over v6-only columns are NOT declared here. SCHEMA_SQL runs
  -- before applyMigrations, so on an existing DB the CREATE TABLE above is a
  -- no-op and the v6 columns do not exist yet — an index naming one fails the
  -- whole open. They are created in migrateV6ToV7, after the ALTERs.

  -- ── sets (rebuilt in v7 — see migrateV6ToV7) ─────────────────────────
  -- Conventions for every v6 column:
  --   * timestamps are ISO-8601 TEXT, matching v1.
  --   * every *_version column is TEXT <component>@<semver>.
  --   * NULLABLE unless a default is genuinely correct. A gap is detectable
  --     downstream; a silent default is not — which is the whole reason
  --     training_mode and weight_lbs stopped being NOT NULL here.

  CREATE TABLE IF NOT EXISTS sets (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    -- Denormalised from the parent session, deliberately: every per-user
    -- analytics query filters sets directly and would otherwise join.
    user_id TEXT REFERENCES users(id),
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    partial INTEGER NOT NULL,
    partial_reason TEXT,

    -- v6: the two silent defaults are gone. 'Unknown' and 0 were sentinels
    -- that read as measurements — a rendered "0 lb" could be a missing
    -- snapshot or a real unloaded set, and nothing downstream could tell.
    training_mode TEXT,
    weight_lbs REAL,

    -- Structure. Set-level exercise identity is what makes per-exercise
    -- analysis possible at all; the session-level column stays as a hint.
    exercise_id TEXT,
    set_purpose TEXT NOT NULL DEFAULT 'working'
      CHECK (set_purpose IN ('working','warmup','probe','technique')),
    -- Generated, never written: is_warmup and set_purpose cannot drift because
    -- there is only one stored value. Reads keep working unchanged.
    is_warmup INTEGER GENERATED ALWAYS AS (set_purpose = 'warmup') VIRTUAL,
    -- Physical configuration (bench height, attachment, stance), INFERRED by
    -- ROM clustering. Distinct from the settings context below, which is
    -- readable device config. Conflating the two breaks like-vs-like matching.
    setup_id TEXT REFERENCES exercise_setups(id) ON DELETE SET NULL,
    set_index_in_session INTEGER,

    -- Identity triple (v5, retained verbatim). device_id = ground truth and
    -- the ONLY join key; side = what per-side analytics reads, resolved at
    -- write time; slot = diagnostic only, a position at a moment in time.
    -- See migrateV4ToV5 and StoredSet in types.ts.
    device_id TEXT,
    side TEXT CHECK (side IN ('left','right')),
    slot TEXT,
    bilateral_group_id TEXT,
    -- 'live' = the two sides were paired as they happened. 'inferred' exists
    -- only so a heuristically-paired row could be rendered differently from an
    -- observed one; no inference backfill is run (see migrateV6ToV7).
    group_source TEXT CHECK (group_source IN ('live','inferred')),

    -- Device settings context: an OBSERVATION of readable device config.
    -- Individually queryable, and hashed for like-vs-like matching. A chains
    -- set and a constant-load set are indistinguishable without this.
    chains_lbs REAL,
    damper_level INTEGER,
    eccentric_pct REAL,
    -- A WEIGHT IN POUNDS, NOT A FLAG. v7 modelled this as INTEGER 0/1; the
    -- device takes setInverseChains(lbs) over 0-100. Retyped in v8→v9 while
    -- the column was still empty. Mechanically the opposite of chains_lbs:
    -- inverse chains shed resistance through the concentric and add it
    -- through the eccentric, so two sets differing only in which one is set
    -- are NOT like-for-like.
    inverse_chains_lbs REAL,
    assist_mode TEXT,
    settings_json TEXT,
    -- 'v1:<hash>' over the whole context. The version prefix is load-bearing:
    -- without it, adding a tenth settings dimension makes old hashes match new
    -- ones wrongly and the mismatch is undetectable.
    settings_hash TEXT,

    -- Firmware ground truth. firmware_rep_count is canonical for COUNTING and
    -- is written verbatim — never max()'d against the derived array length.
    firmware_rep_count INTEGER,
    firmware_peak_force_lbs REAL,
    firmware_peak_power REAL,
    firmware_time_to_peak_ms INTEGER,
    -- The duration field on the set-summary frame. NAMED FOR ITS PROVENANCE,
    -- not its meaning, because the meaning is not settled: the SDK types it as
    -- "duration of the final rep", and the archived captures refute that — the
    -- value scales with rep count (an 11-rep set reports ~11 s while its final
    -- rep took ~1.4 s). It is a SET-level quantity, most consistent with
    -- cumulative concentric time / time-under-tension, but the cross-mode fit
    -- ranges 0.45–1.24× against BLE-timestamped spans, which is not tight
    -- enough to name it TUT. Renamed from firmware_rep_duration_ms in v8
    -- while still empty; do NOT read it as wall-clock set duration or as a
    -- per-rep figure until one instrumented set pins the semantics.
    firmware_summary_duration_ms INTEGER,
    firmware_reps_json TEXT,

    -- Capture provenance. Both of these are markers rather than fixes: they
    -- record what scale and what resolution a row was captured at, so a later
    -- conversion or rate change splits the corpus cleanly instead of blending
    -- two incompatible populations into one untellable mix.
    sample_rate_hz REAL,
    position_units TEXT CHECK (position_units IN ('device_native','meters')),
    derive_version TEXT,

    -- Context.
    battery_pct INTEGER,
    -- ACHIEVED rest before this set, not prescribed rest.
    rest_before_sec REAL,
    -- VOLTRA_ADAPTER=mock writes into the same store as real hardware. Without
    -- this marker any corpus fit silently ingests synthetic rows.
    source TEXT NOT NULL DEFAULT 'local'
      CHECK (source IN ('local','imported','mock'))
  );
  CREATE INDEX IF NOT EXISTS idx_sets_session_id ON sets(session_id, started_at);
  -- The four v7 sets indexes are created by the rebuild in migrateV6ToV7, for
  -- the same ordering reason noted on sessions above.

  CREATE TABLE IF NOT EXISTS reps (
    id TEXT PRIMARY KEY,
    set_id TEXT NOT NULL,
    rep_index INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reps_set_id ON reps(set_id, rep_index);

  -- v3: block-periodization workout planning. Six tables modelling a
  -- program → block → week → workout-template → planned-exercise tree,
  -- plus a program_assignments join that links completed sessions back
  -- to the prescribed exercise. ON DELETE CASCADE walks the planning
  -- tree; ON DELETE SET NULL on assignments preserves session history
  -- when a plan row is removed.

  CREATE TABLE IF NOT EXISTS training_programs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL,
    archived_at TEXT
  );

  CREATE TABLE IF NOT EXISTS training_blocks (
    id TEXT PRIMARY KEY,
    program_id TEXT NOT NULL REFERENCES training_programs(id) ON DELETE CASCADE,
    order_index INTEGER NOT NULL,
    name TEXT NOT NULL,
    focus TEXT,
    weeks_count INTEGER NOT NULL,
    notes TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_training_blocks_program
    ON training_blocks(program_id, order_index);

  CREATE TABLE IF NOT EXISTS training_weeks (
    id TEXT PRIMARY KEY,
    block_id TEXT NOT NULL REFERENCES training_blocks(id) ON DELETE CASCADE,
    order_index INTEGER NOT NULL,
    name TEXT,
    -- v6. PRESCRIBED phase — what the plan says this week is. The observed
    -- counterpart lives in diet_phases; the two are different claims and
    -- collapsing them loses the ability to compare plan against reality.
    phase_type TEXT,
    is_deload INTEGER NOT NULL DEFAULT 0,
    -- Mesocycle week index. order_index is position within the block, which
    -- is not the same thing once a block is edited.
    week_index INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_training_weeks_block
    ON training_weeks(block_id, order_index);

  CREATE TABLE IF NOT EXISTS workout_templates (
    id TEXT PRIMARY KEY,
    week_id TEXT NOT NULL REFERENCES training_weeks(id) ON DELETE CASCADE,
    day_label TEXT,
    name TEXT NOT NULL,
    notes TEXT,
    order_index INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_workout_templates_week
    ON workout_templates(week_id, order_index);

  CREATE TABLE IF NOT EXISTS planned_exercises (
    id TEXT PRIMARY KEY,
    workout_template_id TEXT NOT NULL REFERENCES workout_templates(id) ON DELETE CASCADE,
    exercise_id TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    target_sets INTEGER NOT NULL,
    target_reps_low INTEGER,
    target_reps_high INTEGER,
    target_weight_lbs REAL,
    target_rpe REAL,
    rest_sec INTEGER,
    notes TEXT,
    -- v6. The canonical tempo 4-tuple is [ecc, pauseBottom, con, pauseTop] and
    -- the ordering is a known footgun that has already been shipped wrong once.
    -- Store it as a NAMED OBJECT, never a bare array:
    --   {"ecc":3,"pause_bottom":1,"con":1,"pause_top":0}
    -- A named object cannot be silently mis-ordered by a consumer; a tuple can.
    target_tempo_json TEXT,
    target_rom_m REAL,
    target_rir REAL
  );
  CREATE INDEX IF NOT EXISTS idx_planned_exercises_template
    ON planned_exercises(workout_template_id, order_index);

  CREATE TABLE IF NOT EXISTS program_assignments (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    planned_exercise_id TEXT REFERENCES planned_exercises(id) ON DELETE SET NULL,
    workout_template_id TEXT REFERENCES workout_templates(id) ON DELETE SET NULL,
    assigned_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_program_assignments_session
    ON program_assignments(session_id);
  CREATE INDEX IF NOT EXISTS idx_program_assignments_planned
    ON program_assignments(planned_exercise_id);
  CREATE INDEX IF NOT EXISTS idx_program_assignments_template
    ON program_assignments(workout_template_id);

  -- v6 (VMCP-04.11): isometric assessments. One isometric_measurements row
  -- per run of isometric.measure_imbalance, with one isometric_trials row per
  -- trial per limb. Per-trial numbers are the durable record; every side- and
  -- pair-level statistic (mean plateau of the best 2, CV, inferred working
  -- weight, asymmetry %, the flagged/meaningful thresholds) is recomputed on
  -- read. analysis_version versions the trial-analysis algorithm that
  -- produced the stored numbers.
  --
  -- device_id lives on the TRIAL row and is the join key; side is the limb as
  -- declared for the run; slot is diagnostic only (see the v5 note on sets).

  CREATE TABLE IF NOT EXISTS isometric_measurements (
    id TEXT PRIMARY KEY,
    measured_at TEXT NOT NULL,
    analysis_version INTEGER NOT NULL,
    first_side_tested TEXT,
    duration_ms INTEGER NOT NULL,
    trials_requested INTEGER NOT NULL,
    rest_ms INTEGER NOT NULL,
    between_sides_rest_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_isometric_measurements_measured_at
    ON isometric_measurements(measured_at);

  CREATE TABLE IF NOT EXISTS isometric_trials (
    id TEXT PRIMARY KEY,
    measurement_id TEXT NOT NULL
      REFERENCES isometric_measurements(id) ON DELETE CASCADE,
    device_id TEXT,
    side TEXT,
    slot TEXT,
    trial_index INTEGER NOT NULL,
    peak_force_lbs REAL NOT NULL,
    plateau_force_lbs REAL NOT NULL,
    plateau_start_ms INTEGER NOT NULL,
    plateau_end_ms INTEGER NOT NULL,
    valid INTEGER NOT NULL,
    invalid_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_isometric_trials_measurement
    ON isometric_trials(measurement_id, side, trial_index);
  CREATE INDEX IF NOT EXISTS idx_isometric_trials_device
    ON isometric_trials(device_id);
  -- ═══════════════════════════════════════════════════════════════════════
  -- v6: identity, capture and state.
  --
  -- Every table below is created with no writer in this release. That is
  -- deliberate and it is what makes v6 cheap: an empty column costs nothing,
  -- whereas a column added later is a second migration against data that has
  -- meanwhile accumulated. The expensive thing is not the DDL, it is doing
  -- the DDL twice.
  -- ═══════════════════════════════════════════════════════════════════════

  CREATE TABLE IF NOT EXISTS training_profile (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    declared_tier TEXT,
    declared_at TEXT,
    years_training REAL,
    history_consistent INTEGER,
    ever_plateaued INTEGER,
    reported_sets_per_muscle REAL,
    goal TEXT,
    goal_set_at TEXT,
    days_available INTEGER,
    days_reliable INTEGER,
    onboarded_at TEXT,
    -- Per-field {field: 'user'|'llm'|'default'}: which answers the user
    -- actually gave and which we assumed on their behalf.
    provenance_json TEXT,
    updated_at TEXT NOT NULL
  );

  -- Migrates ~/.voltras/slot-bindings.json into the DB. A JSON file cannot
  -- express per-user bindings, and two people sharing a wall have two
  -- different notions of "left".
  CREATE TABLE IF NOT EXISTS device_bindings (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('left','right')),
    bound_at TEXT NOT NULL,
    last_seen TEXT,
    PRIMARY KEY (user_id, device_id)
  );

  -- Physical setup, INFERRED from ROM clustering rather than declared.
  CREATE TABLE IF NOT EXISTS exercise_setups (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exercise_id TEXT NOT NULL,
    label TEXT,
    detected_at TEXT NOT NULL,
    confirmed_at TEXT,
    cluster_version TEXT,
    retired_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_exercise_setups_user_exercise
    ON exercise_setups(user_id, exercise_id);

  -- STATE ONLY. No baseline VALUES live here: median ROM, tempo mean and decay
  -- slope are computed from stored reps, because a value persisted from a
  -- formula that later changes becomes a silent lie. Adding value columns
  -- later is a pure ALTER, so the reversible choice is the empty one.
  CREATE TABLE IF NOT EXISTS exercise_baselines (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exercise_id TEXT NOT NULL,
    setup_id TEXT REFERENCES exercise_setups(id) ON DELETE SET NULL,
    side TEXT CHECK (side IN ('left','right')),
    state TEXT NOT NULL
      CHECK (state IN ('COLD','SHAPE_ONLY','PROVISIONAL','CALIBRATED','STALE')),
    confidence REAL,
    -- DISTINCT sessions, not sets: promotion requires observations separated
    -- in time, not repeated within one bout.
    observed_sessions INTEGER NOT NULL DEFAULT 0,
    anchor_count INTEGER NOT NULL DEFAULT 0,
    anchor_spread REAL,
    first_observed_at TEXT,
    updated_at TEXT NOT NULL,
    invalidated_at TEXT,
    invalidation_reason TEXT,
    algorithm_version TEXT NOT NULL,
    UNIQUE (user_id, exercise_id, setup_id, side)
  );

  -- Stores the label's INPUTS, not only its verdict, so a changed filter can
  -- re-derive past verdicts instead of stranding them.
  CREATE TABLE IF NOT EXISTS failure_anchors (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    set_id TEXT REFERENCES sets(id) ON DELETE SET NULL,
    exercise_id TEXT NOT NULL,
    setup_id TEXT REFERENCES exercise_setups(id) ON DELETE SET NULL,
    side TEXT CHECK (side IN ('left','right')),
    observed_at TEXT NOT NULL,
    -- 'harvested' = observed in ordinary training; 'prescribed' = deliberately
    -- taken to failure. Named to avoid colliding with set_purpose='probe',
    -- which is a different risk class entirely.
    source TEXT NOT NULL CHECK (source IN ('harvested','prescribed')),
    terminal_velocity_mps REAL,
    load_lbs REAL,
    rep_count INTEGER,
    -- Set index and session position are recorded so the selection bias in
    -- harvested anchors can be corrected for later.
    set_index_in_session INTEGER,
    session_position_sec REAL,
    filter_inputs_json TEXT NOT NULL,
    filter_verdict TEXT NOT NULL,
    filter_version TEXT NOT NULL,
    self_reported_rir REAL
  );
  CREATE INDEX IF NOT EXISTS idx_failure_anchors_key
    ON failure_anchors(user_id, exercise_id, setup_id, side, observed_at);

  -- Persisting inputs AND the thresholds in force at issue time is what lets a
  -- changed threshold be re-scored against history — the mechanism by which an
  -- over-firing guard eventually gets settled with evidence instead of taste.
  CREATE TABLE IF NOT EXISTS advisory_decisions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    set_id TEXT REFERENCES sets(id) ON DELETE SET NULL,
    code TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    inputs_json TEXT NOT NULL,
    thresholds_json TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    verdict TEXT NOT NULL,
    user_response TEXT CHECK (user_response IN ('accepted','declined','ignored')),
    responded_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_advisory_user_code
    ON advisory_decisions(user_id, code, issued_at);

  CREATE TABLE IF NOT EXISTS cue_state (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exercise_id TEXT,
    fault_code TEXT NOT NULL,
    escalation_rung INTEGER NOT NULL DEFAULT 0,
    sessions_persisted INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE (user_id, exercise_id, fault_code)
  );

  -- Check-ins, RIR self-reports and "that was hard" are one table, not three.
  -- muscle_group is not optional in practice: recovery autoregulation is
  -- per-muscle, and a session-scoped check-in cannot answer "are your quads
  -- recovered".
  CREATE TABLE IF NOT EXISTS self_reports (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    set_id TEXT REFERENCES sets(id) ON DELETE SET NULL,
    muscle_group TEXT,
    kind TEXT NOT NULL,
    question_code TEXT,
    value_num REAL,
    value_text TEXT,
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_self_reports_user
    ON self_reports(user_id, kind, recorded_at);

  CREATE TABLE IF NOT EXISTS device_events (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    device_id TEXT,
    slot TEXT,
    kind TEXT NOT NULL,
    at TEXT NOT NULL,
    detail_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_device_events_session ON device_events(session_id, at);
  CREATE INDEX IF NOT EXISTS idx_device_events_at ON device_events(at);

  -- Reps performed outside an open set. Real work that currently leaves no
  -- durable trace, so recorded volume under-counts by an unknown amount.
  CREATE TABLE IF NOT EXISTS idle_reps (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    device_id TEXT,
    slot TEXT,
    side TEXT CHECK (side IN ('left','right')),
    observed_at TEXT NOT NULL,
    weight_lbs REAL,
    payload TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_idle_reps_session ON idle_reps(session_id, observed_at);

  -- NOTE: isometric imbalance persistence is deliberately NOT here. The
  -- migration design called for an imbalance_measurements table holding the
  -- pair-level result (left/right peak, imbalance %). v6 shipped a better
  -- shape first: isometric_measurements + isometric_trials keeps the
  -- PER-TRIAL numbers as the durable record and recomputes every side- and
  -- pair-level statistic on read. That is the correct side of the
  -- persist-observations / compute-conclusions line — the design here would
  -- have stored a derived asymmetry % that a changed analysis version turns
  -- into a silent lie. Superseded on purpose; do not re-add.

  -- ACTUAL (observed) diet phase, time-ranged and retroactively correctable.
  -- Distinct from training_weeks.phase_type, which is the PRESCRIBED phase.
  CREATE TABLE IF NOT EXISTS diet_phases (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phase TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    declared_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_diet_phases_user ON diet_phases(user_id, started_at);

  -- Adherence means adherence TO A COMMITMENT. Without one it degrades to an
  -- observed-regularity proxy that is wrong in both directions.
  CREATE TABLE IF NOT EXISTS commitments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    effective_from TEXT NOT NULL,
    effective_to TEXT,
    sessions_per_week INTEGER NOT NULL,
    days_json TEXT,
    declared_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS body_metrics (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recorded_at TEXT NOT NULL,
    bodyweight_lbs REAL,
    height_in REAL,
    notes TEXT
  );

  -- The cardiovascular hard-gate is a fixed rule in code, never a model
  -- decision, and is never softened by anything in this table.
  CREATE TABLE IF NOT EXISTS limitations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    body_region TEXT,
    pain_class TEXT,
    severity TEXT,
    declared_at TEXT NOT NULL,
    -- Undiagnosed constraints loosen over weeks rather than persisting forever.
    loosens_at TEXT,
    resolved_at TEXT,
    notes TEXT
  );

  -- Without a log we cannot tell whether a swap helped, cannot honour "don't
  -- re-suggest what I declined", and cannot rate-limit churn.
  CREATE TABLE IF NOT EXISTS exercise_substitutions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    from_exercise_id TEXT NOT NULL,
    to_exercise_id TEXT NOT NULL,
    reason_code TEXT,
    rationale_text TEXT,
    proposed_by TEXT CHECK (proposed_by IN ('user','system','llm')),
    accepted INTEGER,
    at TEXT NOT NULL
  );

  -- "Don't count the two weeks they told us they'd be travelling."
  CREATE TABLE IF NOT EXISTS disruption_windows (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    declared_at TEXT NOT NULL,
    reason TEXT
  );
`;

/**
 * Drops the obsolete `chains_lbs` and `eccentric_percent` columns from the
 * `sets` table. Phase 0.5.1 cleanup — those fields were never read by any
 * consumer (per `inventory-bridge.md`) and the in-memory `DeviceSnapshot`
 * never carried them. Idempotent: pre-v2 schemas have the columns and need
 * the drop; v2 schemas already lack them and the `IF EXISTS`-equivalent
 * `pragma_table_info` guard skips the work.
 */
const MIGRATE_V1_TO_V2_SQL = `
  ALTER TABLE sets DROP COLUMN chains_lbs;
  ALTER TABLE sets DROP COLUMN eccentric_percent;
`;

/**
 * v2→v3: introduce the block-periodization planning tables. All `CREATE TABLE`
 * statements live in `SCHEMA_SQL` with `IF NOT EXISTS` guards, so a v2 DB
 * picks them up the moment `db.exec(SCHEMA_SQL)` runs at open time. This
 * stub exists for symmetry and to make the version bump explicit; the actual
 * DDL is shared with fresh-DB creation to avoid drift.
 */
const MIGRATE_V2_TO_V3_SQL = `-- v2→v3 schema additions are folded into SCHEMA_SQL via CREATE IF NOT EXISTS.`;

/**
 * v3→v4: add the `is_warmup` marker to `sets`. Unlike v2→v3 (all `CREATE
 * TABLE IF NOT EXISTS`), this is an `ALTER TABLE ADD COLUMN`, which SQLite has
 * no `IF NOT EXISTS` form for — and `applyMigrations` runs the v3→v4 body on a
 * fresh DB too (its `SCHEMA_SQL` already has the column). So the column-exists
 * probe below is load-bearing, not defensive: it keeps the migration a no-op
 * when `sets` already carries `is_warmup`. `DEFAULT 0` backfills every existing
 * row as a working set.
 */
function migrateV3ToV4(db: DatabaseSync): void {
  // `columnNames` reads `table_xinfo`, not `table_info`. That distinction is
  // load-bearing as of v6: `is_warmup` became a GENERATED column, and
  // `table_info` omits generated columns entirely — so a `table_info` probe
  // would miss it on a fresh v6 DB and try to ADD a column that already exists.
  if (columnNames(db, 'sets').has('is_warmup')) return;
  db.exec(`ALTER TABLE sets ADD COLUMN is_warmup INTEGER NOT NULL DEFAULT 0`);
}

/**
 * v4→v5 (VMCP-04.08): persist per-unit identity on `sets`. It already flowed
 * through the live path (`meta.slot` on channel events, the slot-stamped SSE
 * payloads, per-slot snapshot data) but was dropped on write, so which arm
 * performed a bilateral set was unrecoverable afterwards.
 *
 * THREE COLUMNS, THREE DISTINCT JOBS — this split is the whole point of the
 * migration, so keep them distinct:
 *
 *   device_id  ground truth. Stable physical identity. The ONLY join key.
 *   side       nullable, resolved from the `deviceId → physicalSide` binding
 *              at WRITE time. What per-side analytics reads.
 *   slot       DIAGNOSTIC ONLY. Never a join key, never the durable side.
 *
 * Why `slot` cannot be the durable identity: `slot.swap` exchanges clients
 * between slot keys, so a slot id names a position at a moment in time, not a
 * device or a limb. Were an L/R series keyed on `slot`, every historical row
 * would silently change meaning the first time a user swaps slots and the
 * series would flip sign with nothing erroring. Storing it is still useful for
 * debugging which position a set came from; depending on it is not.
 *
 * Three nullable `ALTER TABLE ADD COLUMN`s, per-column probed for the same
 * reason `migrateV3ToV4` probes: SQLite has no `ADD COLUMN IF NOT EXISTS`, and
 * `applyMigrations` runs this body on a fresh DB whose `SCHEMA_SQL` already
 * declares all three.
 *
 * NULLABLE WITH NO DEFAULT AND NO BACKFILL IS DELIBERATE. Every pre-v5 row
 * reads back with `slot`/`deviceId`/`side` absent, which is the truth: those
 * sets were recorded before identity was captured and are genuinely
 * unattributable. `device_id` was discarded at write time, so their side is
 * permanently unknowable — there is nothing left to infer it from, and an
 * inferred side would manufacture data that looks real. A gap is detectable
 * downstream; a plausible wrong value is not. Existing rows are otherwise
 * untouched — `ADD COLUMN` rewrites no row data.
 */
function migrateV4ToV5(db: DatabaseSync): void {
  const names = columnNames(db, 'sets');
  if (!names.has('slot')) db.exec(`ALTER TABLE sets ADD COLUMN slot TEXT`);
  if (!names.has('device_id')) db.exec(`ALTER TABLE sets ADD COLUMN device_id TEXT`);
  if (!names.has('side')) db.exec(`ALTER TABLE sets ADD COLUMN side TEXT`);
}

/**
 * v5→v6 (VMCP-04.11): add the `isometric_measurements` / `isometric_trials`
 * pair. `isometric.measure_imbalance` computed a real left/right asymmetry and
 * then discarded it; these tables are the write that was missing.
 *
 * PURELY ADDITIVE — TWO NEW TABLES, NO CHANGE TO ANY EXISTING ONE. Unlike
 * v3→v4 and v4→v5 there is no `ALTER TABLE` to probe for, because nothing
 * existing is touched: no column is added to `sets`, no row anywhere is
 * rewritten, and no pre-v6 data is read, backfilled or reinterpreted. The
 * `CREATE TABLE IF NOT EXISTS` guards in `SCHEMA_SQL` do the whole job the
 * moment `db.exec(SCHEMA_SQL)` runs at open time, so this migration is the same
 * documented stub as v2→v3 rather than a per-column probe.
 *
 * NO BACKFILL, DELIBERATELY. There is no historical imbalance data to recover:
 * every assessment run before v6 was computed in memory and dropped, and the
 * force samples behind it were never persisted either. A DB that upgrades to v6
 * starts with an empty assessment history, which is the truth.
 */
const MIGRATE_V5_TO_V6_SQL = `-- v5→v6 schema additions are folded into SCHEMA_SQL via CREATE TABLE IF NOT EXISTS.`;

/**
 * Column names currently present on `table`, GENERATED COLUMNS INCLUDED.
 *
 * `table_xinfo` rather than `table_info` deliberately: `table_info` omits
 * generated columns, so probing with it would report v7's generated
 * `sets.is_warmup` as missing and every `ADD COLUMN` guard keyed on it would
 * fire against a column that is already there.
 */
function columnNames(db: DatabaseSync, table: string): Set<string> {
  const columns = db.prepare(`PRAGMA table_xinfo(${table})`).all() as { name: string }[];
  return new Set(columns.map((c) => c.name));
}

/**
 * Add `column` to `table` when it is absent. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, and every migration body also runs against fresh
 * DBs whose `SCHEMA_SQL` already declares the column, so the probe is
 * load-bearing rather than defensive.
 */
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, ddl: string): void {
  if (columnNames(db, table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/**
 * Seed the implicit local user. Idempotent, and safe to run on every open:
 * v6 attributes every pre-existing row to this id, so it must exist before any
 * backfill references it.
 */
function seedLocalUser(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO users (id, display_name, created_at, is_default)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(id) DO NOTHING`,
  ).run(LOCAL_USER_ID, 'Local', new Date().toISOString());
}

/**
 * v5→v6: the consolidated data-layer migration. Identity (a user dimension),
 * capture provenance on `sets`, and the state tables that record decisions.
 *
 * WHY ONE MIGRATION RATHER THAN A SEQUENCE. A column with no writer is inert
 * and costs nothing; a column added later is a second migration against data
 * that has meanwhile accumulated. More pointedly, the `sets` rebuild below
 * MUST happen before anything foreign-keys into `sets`, and this same
 * migration introduces three such children (`failure_anchors`,
 * `advisory_decisions`, `self_reports`). Splitting the work would mean either
 * rebuilding later with children present, or relying on an ordering the code
 * has no way to enforce.
 *
 * THE REBUILD IS THE ONLY NON-ADDITIVE OPERATION. `training_mode` and
 * `weight_lbs` must lose their `NOT NULL`, and SQLite has no `ALTER COLUMN`,
 * so a 12-step table rebuild is unavoidable. Since we are rebuilding anyway it
 * absorbs every new `sets` column in one pass rather than ~25 separate
 * `ALTER`s. This is the one seam that must not be split across two releases:
 * every other cut in this plan is column-fill or new tables, neither of which
 * re-migrates live data.
 *
 * `sessions` takes `ADD COLUMN` ONLY and is deliberately not rebuilt — it is
 * an FK parent (`program_assignments` cascades off it), which makes a rebuild
 * a data-loss hazard rather than merely slower.
 */
function migrateV6ToV7(db: DatabaseSync): void {
  seedLocalUser(db);

  addColumnIfMissing(db, 'sessions', 'user_id', 'TEXT REFERENCES users(id)');
  addColumnIfMissing(db, 'sessions', 'bilateral_group_id', 'TEXT');
  addColumnIfMissing(db, 'sessions', 'source', `TEXT NOT NULL DEFAULT 'local'`);
  addColumnIfMissing(db, 'sessions', 'catalog_version', 'TEXT');
  addColumnIfMissing(db, 'sessions', 'diet_phase', 'TEXT');

  addColumnIfMissing(db, 'training_weeks', 'phase_type', 'TEXT');
  addColumnIfMissing(db, 'training_weeks', 'is_deload', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'training_weeks', 'week_index', 'INTEGER');

  addColumnIfMissing(db, 'planned_exercises', 'target_tempo_json', 'TEXT');
  addColumnIfMissing(db, 'planned_exercises', 'target_rom_m', 'REAL');
  addColumnIfMissing(db, 'planned_exercises', 'target_rir', 'REAL');

  // Declared here rather than in SCHEMA_SQL: it names a column the ALTERs above
  // have only just added.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, started_at)`);

  db.exec(`UPDATE sessions SET user_id = '${LOCAL_USER_ID}' WHERE user_id IS NULL`);
  // `order_index` is position within a block; `week_index` is the mesocycle
  // week. They coincide today, which makes this backfill exactly right now and
  // keeps them free to diverge later.
  db.exec(`UPDATE training_weeks SET week_index = order_index WHERE week_index IS NULL`);

  rebuildSetsForV7(db);
  // Also runs for the fresh-DB case, where the rebuild is a no-op and
  // SCHEMA_SQL deliberately did not declare these.
  createV7SetsIndexes(db);
}

/**
 * v7→v8: rename `sets.firmware_rep_duration_ms` to `firmware_summary_duration_ms`.
 *
 * A NAMING FIX, done while the column is still empty and therefore free. v7
 * created the column from the SDK's own label for the field — "duration of the
 * final rep" — and nothing ever wrote to it. The archived captures then showed
 * that label is wrong: the value scales with rep count (an 11-rep set reports
 * ~11 s while its final rep took ~1.4 s), so it is a set-level aggregate, not a
 * per-rep duration.
 *
 * Renamed rather than filled as-is because a column name is read far more often
 * than its doc comment, and `firmware_rep_duration_ms` would have taught every
 * future consumer a wrong meaning that only a capture analysis could unteach.
 * The replacement name describes the field's PROVENANCE — the duration on the
 * summary frame — rather than asserting semantics nobody has pinned down yet.
 *
 * Probed twice, because `applyMigrations` runs on fresh DBs whose `SCHEMA_SQL`
 * already declares the new name, and on v6 DBs whose v6→v7 rebuild creates the
 * old one. `ALTER TABLE ... RENAME COLUMN` needs SQLite 3.25+, which the
 * generated columns already in use comfortably exceed.
 */
function migrateV7ToV8(db: DatabaseSync): void {
  const names = columnNames(db, 'sets');
  if (!names.has('firmware_rep_duration_ms')) return;
  if (names.has('firmware_summary_duration_ms')) return;
  db.exec(
    `ALTER TABLE sets RENAME COLUMN firmware_rep_duration_ms TO firmware_summary_duration_ms`,
  );
}

/**
 * v8→v9: rename `sets.inverse_chains` to `sets.inverse_chains_lbs`.
 *
 * A TYPE FIX, done while the column is still empty and therefore free. v7
 * created it as `INTEGER` and `StoredSet` typed it `boolean`, modelling inverse
 * chains as on/off. The device does not work that way: `setInverseChains(lbs)`
 * takes a magnitude in pounds over 0-100, with one protocol command per value.
 * Under the boolean model a 5 lb and a 40 lb inverse-chains set were the same
 * configuration, which they are not.
 *
 * SQLite's declared type is advisory (column affinity), so the rename alone
 * would leave the old INTEGER affinity in place and silently truncate a
 * fractional value. The column name carries the unit for readers; the REAL
 * affinity in `SCHEMA_SQL` covers fresh DBs, and the affinity change is not
 * worth a full table rebuild for a column with zero rows written — the values
 * the device offers are whole pounds.
 *
 * Probed in BOTH directions, because `applyMigrations` also runs on fresh DBs
 * whose `SCHEMA_SQL` already declares the new name, and on older DBs whose
 * v6→v7 rebuild created the old one. `columnNames` reads `table_xinfo`, which
 * matters here: `sets` carries a generated column that `table_info` omits.
 */
function migrateV8ToV9(db: DatabaseSync): void {
  const names = columnNames(db, 'sets');
  if (!names.has('inverse_chains')) return;
  if (names.has('inverse_chains_lbs')) return;
  db.exec(`ALTER TABLE sets RENAME COLUMN inverse_chains TO inverse_chains_lbs`);
}

/**
 * VMCP-01.72b (S4): `listSessions({ exerciseId })` gained a subquery over
 * `sets` (`WHERE id IN (SELECT DISTINCT session_id FROM sets WHERE
 * exercise_id = ?)`) so a session is found by what its SETS actually
 * recorded, not just the session row's own (last-write-wins) column. That
 * subquery has no `user_id` predicate, so it can't seek the existing
 * `idx_sets_user_exercise(user_id, exercise_id, started_at)` — its leading
 * column is unconstrained — and falls back to a full scan of `sets` on
 * every `session.list?exerciseId=` call. This index leads with
 * `exercise_id` (what the subquery actually filters on) and covers
 * `session_id` (what it selects), so the whole subquery is answered from
 * the index without touching the table.
 *
 * Purely additive — no data change, safe to add at any schema version —
 * but versioned rather than folded into `createV7SetsIndexes` because that
 * function's contract is specifically "indexes naming v6-only columns".
 */
function migrateV9ToV10(db: DatabaseSync): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sets_exercise_session ON sets(exercise_id, session_id)`);
}

/**
 * The `sets` indexes that name v6-only columns. Idempotent, and called from
 * both the rebuild (which drops the old table and with it every index) and the
 * fresh-DB path.
 */
function createV7SetsIndexes(db: DatabaseSync): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sets_session_id ON sets(session_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_sets_user_exercise ON sets(user_id, exercise_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_sets_bilateral ON sets(bilateral_group_id);
    CREATE INDEX IF NOT EXISTS idx_sets_setup ON sets(setup_id);
    CREATE INDEX IF NOT EXISTS idx_sets_settings_hash ON sets(user_id, exercise_id, settings_hash);
  `);
}

/**
 * The `sets` table rebuild (SQLite's documented 12-step ALTER procedure).
 *
 * No-op once `sets` already carries the v6 shape, which is the fresh-DB case:
 * `SCHEMA_SQL` creates the v6 table directly and this body finds nothing to do.
 *
 * FOREIGN KEYS ARE OFF FOR THE DURATION and the result is verified with
 * `PRAGMA foreign_key_check` before the transaction commits. `PRAGMA
 * foreign_keys` is a no-op inside a transaction, so the toggle has to sit
 * outside `BEGIN`. The new FK children created by this same migration are
 * necessarily empty when this runs, so the check has nothing to fail on — but
 * it runs anyway, because "should be empty" is not a guarantee.
 *
 * `reps` is a logical child of `sets` with no `REFERENCES` clause, so
 * `DROP TABLE sets` does not cascade into it and rep payloads survive the
 * rebuild untouched.
 */
function rebuildSetsForV7(db: DatabaseSync): void {
  const existing = columnNames(db, 'sets');
  if (existing.has('set_purpose')) return;

  // Pre-v5 DBs reach v6 through migrateV4ToV5, so the identity triple is
  // always present by now. Selected explicitly rather than assumed.
  const hasIdentity = existing.has('slot') && existing.has('device_id') && existing.has('side');
  if (!hasIdentity) {
    throw new Error(
      'sets is missing the v5 identity columns at the v6 rebuild; migrations ran out of order',
    );
  }

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE sets_v7 (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT REFERENCES users(id),
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        partial INTEGER NOT NULL,
        partial_reason TEXT,
        training_mode TEXT,
        weight_lbs REAL,
        exercise_id TEXT,
        set_purpose TEXT NOT NULL DEFAULT 'working'
          CHECK (set_purpose IN ('working','warmup','probe','technique')),
        is_warmup INTEGER GENERATED ALWAYS AS (set_purpose = 'warmup') VIRTUAL,
        setup_id TEXT REFERENCES exercise_setups(id) ON DELETE SET NULL,
        set_index_in_session INTEGER,
        device_id TEXT,
        side TEXT CHECK (side IN ('left','right')),
        slot TEXT,
        bilateral_group_id TEXT,
        group_source TEXT CHECK (group_source IN ('live','inferred')),
        chains_lbs REAL,
        damper_level INTEGER,
        eccentric_pct REAL,
        inverse_chains INTEGER,
        assist_mode TEXT,
        settings_json TEXT,
        settings_hash TEXT,
        firmware_rep_count INTEGER,
        firmware_peak_force_lbs REAL,
        firmware_peak_power REAL,
        firmware_time_to_peak_ms INTEGER,
        firmware_rep_duration_ms INTEGER,
        firmware_reps_json TEXT,
        sample_rate_hz REAL,
        position_units TEXT CHECK (position_units IN ('device_native','meters')),
        derive_version TEXT,
        battery_pct INTEGER,
        rest_before_sec REAL,
        source TEXT NOT NULL DEFAULT 'local'
          CHECK (source IN ('local','imported','mock'))
      )
    `);

    // The backfills. Each one is either information-preserving or explicitly
    // noted as lossy in the migration notes — nothing here infers a value the
    // data never had.
    //
    //   training_mode  'Unknown' was only ever a sentinel, never a real mode.
    //                  Converting it to NULL is strictly information-preserving.
    //   weight_lbs     A stored 0 is ambiguous: missing-snapshot sentinel or a
    //                  genuine unloaded set. NULLIF collapses both to NULL and
    //                  therefore LOSES A GENUINE ZERO. Applied anyway — the
    //                  sentinel dominates (the device clamps at 5 lb and
    //                  nothing prescribes 0 lb), and an honest NULL beats a
    //                  confident wrong number. Pre-v6 NULLs must not be read as
    //                  certain gaps.
    //   exercise_id    Inherited from the parent session. Correct wherever a
    //                  session held one exercise, which is nearly all of them;
    //                  where a session was genuinely multi-exercise the
    //                  session-level value was already wrong and this
    //                  faithfully reproduces that wrongness rather than
    //                  inventing a better one.
    //   set_purpose    Historical probe rungs are indistinguishable from
    //                  working sets and are permanently lost as such.
    //   position_units Every existing row is device-native BY DEFINITION —
    //                  no conversion has ever run. This is the one place a
    //                  DEFAULT is safe, because it records what already is
    //                  rather than assuming what might be.
    //   source         Mock-adapter rows already in the DB are mislabelled
    //                  'local'; nothing distinguished them at write time and
    //                  they are NOT separable after the fact.
    //
    // Deliberately NOT backfilled: device_id / side / slot (discarded at write
    // time — historical rows are permanently side-unknown, and inferring a side
    // would manufacture data that looks measured), bilateral_group_id (a
    // heuristic pairing lacks the opposite-slot guard the live path has, so it
    // can create false pairs the live path cannot — and an inferred group still
    // yields no side), and every settings/firmware/capture column, which were
    // never captured at all.
    db.exec(`
      INSERT INTO sets_v7 (
        id, session_id, user_id, started_at, ended_at, partial, partial_reason,
        training_mode, weight_lbs, exercise_id, set_purpose,
        set_index_in_session, device_id, side, slot, position_units, source
      )
      SELECT
        s.id,
        s.session_id,
        '${LOCAL_USER_ID}',
        s.started_at,
        s.ended_at,
        s.partial,
        s.partial_reason,
        NULLIF(s.training_mode, 'Unknown'),
        NULLIF(s.weight_lbs, 0),
        (SELECT sess.exercise_id FROM sessions sess WHERE sess.id = s.session_id),
        CASE WHEN s.is_warmup = 1 THEN 'warmup' ELSE 'working' END,
        ROW_NUMBER() OVER (PARTITION BY s.session_id ORDER BY s.started_at),
        s.device_id,
        CASE WHEN s.side IN ('left','right') THEN s.side ELSE NULL END,
        s.slot,
        'device_native',
        'local'
      FROM sets s
    `);

    db.exec(`DROP TABLE sets`);
    db.exec(`ALTER TABLE sets_v7 RENAME TO sets`);
    // DROP TABLE took every index with it; recreate before the FK check.
    createV7SetsIndexes(db);

    const violations = db.prepare(`PRAGMA foreign_key_check`).all();
    if (violations.length > 0) {
      throw new Error(
        `v5→v6 sets rebuild left ${String(violations.length)} foreign-key violation(s); rolled back`,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

interface SessionRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  exercise_id: string | null;
  exercise_name: string | null;
  notes: string | null;
}

interface SetRow {
  id: string;
  session_id: string;
  started_at: string;
  ended_at: string;
  partial: number;
  partial_reason: string | null;
  // Nullable as of v7: the 'Unknown' / 0 sentinels are gone.
  training_mode: string | null;
  weight_lbs: number | null;
  // Generated from set_purpose — read, never written.
  is_warmup: number;
  set_purpose: string;
  slot: string | null;
  device_id: string | null;
  side: string | null;
  user_id: string | null;
  exercise_id: string | null;
  set_index_in_session: number | null;
  rest_before_sec: number | null;
  battery_pct: number | null;
  source: string | null;
  position_units: string | null;
  sample_rate_hz: number | null;
  firmware_rep_count: number | null;
  firmware_summary_duration_ms: number | null;
  firmware_reps_json: string | null;
  bilateral_group_id: string | null;
  group_source: string | null;
  chains_lbs: number | null;
  damper_level: number | null;
  eccentric_pct: number | null;
  inverse_chains_lbs: number | null;
  assist_mode: string | null;
  settings_json: string | null;
  settings_hash: string | null;
}

interface RepRow {
  id: string;
  set_id: string;
  rep_index: number;
  payload: string;
}

interface IdleRepRow {
  id: string;
  user_id: string | null;
  session_id: string | null;
  device_id: string | null;
  slot: string | null;
  side: string | null;
  observed_at: string;
  weight_lbs: number | null;
  payload: string | null;
}

interface IsometricMeasurementRow {
  id: string;
  measured_at: string;
  analysis_version: number;
  first_side_tested: string | null;
  duration_ms: number;
  trials_requested: number;
  rest_ms: number;
  between_sides_rest_ms: number | null;
}

interface IsometricTrialRow {
  id: string;
  measurement_id: string;
  device_id: string | null;
  side: string | null;
  slot: string | null;
  trial_index: number;
  peak_force_lbs: number;
  plateau_force_lbs: number;
  plateau_start_ms: number;
  plateau_end_ms: number;
  valid: number;
  invalid_reason: string | null;
}

interface TrainingProgramRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  archived_at: string | null;
}

interface TrainingProfileRow {
  user_id: string;
  declared_tier: string | null;
  declared_at: string | null;
  years_training: number | null;
  history_consistent: number | null;
  ever_plateaued: number | null;
  reported_sets_per_muscle: number | null;
  goal: string | null;
  goal_set_at: string | null;
  days_available: number | null;
  days_reliable: number | null;
  onboarded_at: string | null;
  provenance_json: string | null;
  updated_at: string;
}

interface ExerciseBaselineRow {
  id: string;
  user_id: string;
  exercise_id: string;
  setup_id: string | null;
  side: StoredSide | null;
  state: BaselineState;
  confidence: number | null;
  observed_sessions: number;
  anchor_count: number;
  anchor_spread: number | null;
  first_observed_at: string | null;
  updated_at: string;
  invalidated_at: string | null;
  invalidation_reason: string | null;
  algorithm_version: string;
}

/** `failure_anchors` joined to its set row for the session bucket. */
interface FailureAnchorJoinRow {
  session_id: string | null;
  observed_at: string;
  terminal_velocity_mps: number | null;
}

interface TrainingBlockRow {
  id: string;
  program_id: string;
  order_index: number;
  name: string;
  focus: string | null;
  weeks_count: number;
  notes: string | null;
}

interface TrainingWeekRow {
  id: string;
  block_id: string;
  order_index: number;
  name: string | null;
}

interface WorkoutTemplateRow {
  id: string;
  week_id: string;
  day_label: string | null;
  name: string;
  notes: string | null;
  order_index: number;
}

interface PlannedExerciseRow {
  id: string;
  workout_template_id: string;
  exercise_id: string;
  order_index: number;
  target_sets: number;
  target_reps_low: number | null;
  target_reps_high: number | null;
  target_weight_lbs: number | null;
  target_rpe: number | null;
  rest_sec: number | null;
  notes: string | null;
}

interface ProgramAssignmentRow {
  id: string;
  session_id: string;
  planned_exercise_id: string | null;
  workout_template_id: string | null;
  assigned_at: string;
}

/** SQLite-backed implementation of `SessionStore`. */
export class SqliteSessionStore implements SessionStore {
  private readonly db: DatabaseSync;
  private closed = false;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Open (or create) the SQLite database at `path`. Detects schema version
   * mismatch and concurrent-writer lock contention before returning a
   * usable store. On any failure, the underlying handle is closed before
   * the error is rethrown so partial-init cleanup in `bootstrapState()`
   * does not have to track a half-open DB.
   */
  static open(path: string): SqliteSessionStore {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(path);
    } catch (err) {
      if (isSqliteBusy(err)) {
        throw createLockedError(path, err);
      }
      throw err;
    }
    try {
      // Foreign-key enforcement is off by default in SQLite. The v3 planning
      // tree relies on ON DELETE CASCADE / SET NULL, so it MUST be on for
      // every connection. Set before the schema runs so any seed inserts
      // also see the constraints.
      db.exec('PRAGMA foreign_keys = ON');
      checkSchemaVersion(db, path);
      probeWriteLock(db, path);
      db.exec(SCHEMA_SQL);
      applyMigrations(db);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      return new SqliteSessionStore(db);
    } catch (err) {
      try {
        db.close();
      } catch {
        // ignore — original error is what we want to surface.
      }
      // Schema-version reads can themselves hit SQLITE_BUSY when another
      // process holds an exclusive lock. Convert those to the friendly
      // lock error so callers see the VMCP_DB_PATH guidance once, not a
      // raw "database is locked" surprise.
      const e = err as Error & { code?: string };
      if (e.code !== 'SCHEMA_INCOMPATIBLE' && isSqliteBusy(err)) {
        throw createLockedError(path, err);
      }
      throw err;
    }
  }

  async putSession(s: StoredSession): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO sessions
           (id, started_at, ended_at, exercise_id, exercise_name, notes)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           exercise_id = excluded.exercise_id,
           exercise_name = excluded.exercise_name,
           notes = excluded.notes`,
      )
      .run(
        s.id,
        s.startedAt,
        s.endedAt ?? null,
        s.exerciseId ?? null,
        s.exerciseName ?? null,
        s.notes ?? null,
      );
    return Promise.resolve();
  }

  async putSet(s: StoredSet): Promise<void> {
    // `ON CONFLICT DO UPDATE`, never `INSERT OR REPLACE`: the latter is a
    // delete-then-insert, and `sets` is the parent of `reps`. The re-put paths
    // (force-end on disconnect followed by an explicit re-end) hit the conflict
    // branch on every retry — see the #79 regression on `sessions`.
    // EVERY WRITTEN COLUMN MUST APPEAR IN BOTH LISTS. A column present in the
    // INSERT but missing from the DO UPDATE silently never updates on a re-put,
    // which is invisible until a force-end/re-end retry writes the wrong value.
    // `is_warmup` is absent by design — it is a generated column as of v6 and
    // SQLite rejects writes to it; `set_purpose` is the stored value.
    const upsertSet = this.db.prepare(
      `INSERT INTO sets
         (id, session_id, user_id, started_at, ended_at, partial, partial_reason,
          training_mode, weight_lbs, set_purpose, slot, device_id, side,
          exercise_id, set_index_in_session, rest_before_sec, battery_pct,
          source, position_units, sample_rate_hz,
          firmware_rep_count, firmware_summary_duration_ms, firmware_reps_json,
          bilateral_group_id, group_source,
          chains_lbs, damper_level, eccentric_pct, inverse_chains_lbs, assist_mode,
          settings_json, settings_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id,
         user_id = excluded.user_id,
         started_at = excluded.started_at,
         ended_at = excluded.ended_at,
         partial = excluded.partial,
         partial_reason = excluded.partial_reason,
         training_mode = excluded.training_mode,
         weight_lbs = excluded.weight_lbs,
         set_purpose = excluded.set_purpose,
         slot = excluded.slot,
         device_id = excluded.device_id,
         side = excluded.side,
         exercise_id = excluded.exercise_id,
         set_index_in_session = excluded.set_index_in_session,
         rest_before_sec = excluded.rest_before_sec,
         battery_pct = excluded.battery_pct,
         source = excluded.source,
         position_units = excluded.position_units,
         sample_rate_hz = excluded.sample_rate_hz,
         firmware_rep_count = excluded.firmware_rep_count,
         firmware_summary_duration_ms = excluded.firmware_summary_duration_ms,
         firmware_reps_json = excluded.firmware_reps_json,
         bilateral_group_id = excluded.bilateral_group_id,
         group_source = excluded.group_source,
         chains_lbs = excluded.chains_lbs,
         damper_level = excluded.damper_level,
         eccentric_pct = excluded.eccentric_pct,
         inverse_chains_lbs = excluded.inverse_chains_lbs,
         assist_mode = excluded.assist_mode,
         settings_json = excluded.settings_json,
         settings_hash = excluded.settings_hash`,
    );
    const deleteReps = this.db.prepare(`DELETE FROM reps WHERE set_id = ?`);
    const insertRep = this.db.prepare(
      `INSERT INTO reps (id, set_id, rep_index, payload) VALUES (?, ?, ?, ?)`,
    );

    this.db.exec('BEGIN');
    try {
      upsertSet.run(
        s.id,
        s.sessionId,
        s.userId ?? null,
        s.startedAt,
        s.endedAt,
        s.partial ? 1 : 0,
        s.partialReason ?? null,
        s.trainingMode ?? null,
        s.weightLbs ?? null,
        s.isWarmup === true ? 'warmup' : 'working',
        s.slot ?? null,
        s.deviceId ?? null,
        s.side ?? null,
        s.exerciseId ?? null,
        s.setIndexInSession ?? null,
        s.restBeforeSec ?? null,
        s.batteryPct ?? null,
        // NOT NULL with a column DEFAULT of 'local'. Binding an explicit NULL
        // overrides the default and violates the constraint, so the default is
        // reproduced here. Not a sentinel: a row this server wrote genuinely IS
        // local provenance unless the adapter says otherwise.
        s.source ?? 'local',
        s.positionUnits ?? null,
        s.sampleRateHz ?? null,
        s.firmwareRepCount ?? null,
        s.firmwareSummaryDurationMs ?? null,
        s.firmwareRepsJson ?? null,
        s.bilateralGroupId ?? null,
        s.groupSource ?? null,
        s.chainsLbs ?? null,
        s.damperLevel ?? null,
        s.eccentricPct ?? null,
        s.inverseChainsLbs ?? null,
        s.assistMode ?? null,
        s.settingsJson ?? null,
        s.settingsHash ?? null,
      );
      deleteReps.run(s.id);
      for (const rep of s.reps) {
        insertRep.run(
          rep.id,
          rep.setId,
          rep.index,
          serializeRepPayload(rep, `SqliteSessionStore.putSet: rep ${rep.id}`),
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return Promise.resolve();
  }

  async getSession(id: string): Promise<StoredSession | undefined> {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
      | SessionRow
      | undefined;
    return Promise.resolve(row ? rowToSession(row) : undefined);
  }

  async getSet(id: string): Promise<StoredSet | undefined> {
    const row = this.db.prepare(`SELECT * FROM sets WHERE id = ?`).get(id) as SetRow | undefined;
    if (!row) return Promise.resolve(undefined);
    const reps = this.loadRepsForSet(row.id);
    return Promise.resolve(rowToSet(row, reps));
  }

  async listSessions(filter: SessionListFilter): Promise<StoredSession[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.from !== undefined) {
      where.push('started_at >= ?');
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push('started_at <= ?');
      params.push(filter.to);
    }
    if (filter.exerciseId !== undefined) {
      // VMCP-01.72b (H1): the session row's own `exercise_id` column is
      // last-write-wins once `session.set_exercise` lets one session hold
      // several exercises — a session that trained squat then bench persists
      // with exercise_id = 'bench-press', so a query for 'back-squat' would
      // silently drop it even though it has real squat sets. Also match via
      // the SETS the session actually recorded, which are set-level and
      // authoritative post-cutover; the session-column check stays so
      // pre-cutover / name-only sessions with no per-set exerciseId keep
      // matching exactly as before.
      where.push(
        '(exercise_id = ? OR id IN (SELECT DISTINCT session_id FROM sets WHERE exercise_id = ?))',
      );
      params.push(filter.exerciseId, filter.exerciseId);
    }
    const direction = filter.sort === 'startedAt:asc' ? 'ASC' : 'DESC';
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    const sql =
      `SELECT * FROM sessions` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY started_at ${direction} LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params, limit, offset) as unknown as SessionRow[];
    return Promise.resolve(rows.map(rowToSession));
  }

  async countSessions(filter: SessionCountFilter = {}): Promise<number> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.from !== undefined) {
      where.push('started_at >= ?');
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push('started_at <= ?');
      params.push(filter.to);
    }
    if (filter.exerciseId !== undefined) {
      // VMCP-01.72b (S6): same set-level OR-subquery as `listSessions` — see
      // the comment there. This method's own doc contract ("same predicates
      // as listSessions") is a promise a session-column-only WHERE here
      // would silently break: `list` would find a session `count` doesn't.
      where.push(
        '(exercise_id = ? OR id IN (SELECT DISTINCT session_id FROM sets WHERE exercise_id = ?))',
      );
      params.push(filter.exerciseId, filter.exerciseId);
    }
    if (filter.userId !== undefined) {
      where.push('user_id = ?');
      params.push(filter.userId);
    }
    if (filter.endedOnly === true) {
      where.push('ended_at IS NOT NULL');
    }
    // `sort` / `limit` / `offset` are intentionally not applied: they describe
    // a page, and the count of a page is not a count.
    const sql =
      `SELECT COUNT(*) AS n FROM sessions` + (where.length ? ` WHERE ${where.join(' AND ')}` : '');
    const row = this.db.prepare(sql).get(...params) as { n: number } | undefined;
    return Promise.resolve(row?.n ?? 0);
  }

  async getSessionDateSpan(filter: SessionCountFilter = {}): Promise<SessionDateSpan> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.from !== undefined) {
      where.push('started_at >= ?');
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push('started_at <= ?');
      params.push(filter.to);
    }
    if (filter.exerciseId !== undefined) {
      // Same set-level OR-subquery as `listSessions`/`countSessions` — see
      // the comment on `listSessions`.
      where.push(
        '(exercise_id = ? OR id IN (SELECT DISTINCT session_id FROM sets WHERE exercise_id = ?))',
      );
      params.push(filter.exerciseId, filter.exerciseId);
    }
    if (filter.userId !== undefined) {
      where.push('user_id = ?');
      params.push(filter.userId);
    }
    if (filter.endedOnly === true) {
      where.push('ended_at IS NOT NULL');
    }
    const sql =
      `SELECT MIN(started_at) AS first, MAX(started_at) AS last FROM sessions` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '');
    const row = this.db.prepare(sql).get(...params) as
      | { first: string | null; last: string | null }
      | undefined;
    return Promise.resolve({ first: row?.first ?? null, last: row?.last ?? null });
  }

  async getSetsForSession(sessionId: string): Promise<StoredSet[]> {
    const rows = this.db
      .prepare(`SELECT * FROM sets WHERE session_id = ? ORDER BY started_at ASC`)
      .all(sessionId) as unknown as SetRow[];
    const sets = rows.map((row) => rowToSet(row, this.loadRepsForSet(row.id)));
    return Promise.resolve(sets);
  }

  async countSets(filter: SetCountFilter): Promise<number> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.userId !== undefined) {
      where.push('user_id = ?');
      params.push(filter.userId);
    }
    if (filter.sessionId !== undefined) {
      where.push('session_id = ?');
      params.push(filter.sessionId);
    }
    // Collapsed = groups, not rows. Written as two terms rather than one
    // `COUNT(DISTINCT bilateral_group_id)` because SQL folds every NULL into a
    // single DISTINCT bucket — or, in SQLite's case, drops them entirely — and
    // either way an ungrouped set is not a group. The first term counts each
    // NULL-group row on its own; the second counts each real group once.
    const expr = filter.collapseBilateral
      ? `COALESCE(SUM(CASE WHEN bilateral_group_id IS NULL THEN 1 ELSE 0 END), 0)
           + COUNT(DISTINCT bilateral_group_id)`
      : 'COUNT(*)';
    const sql =
      `SELECT ${expr} AS n FROM sets` + (where.length ? ` WHERE ${where.join(' AND ')}` : '');
    const row = this.db.prepare(sql).get(...params) as { n: number } | undefined;
    return Promise.resolve(row?.n ?? 0);
  }

  async getSetsForExercise(filter: ExerciseSetsFilter): Promise<StoredSet[]> {
    // An empty purpose list matches nothing. Treating it as "all" is the
    // classic footgun: the caller asked for a named subset, got the whole
    // table, and nothing errored.
    if (filter.purpose !== undefined && filter.purpose.length === 0) {
      return Promise.resolve([]);
    }
    const where: string[] = ['user_id = ?', 'exercise_id = ?'];
    const params: (string | number)[] = [filter.userId, filter.exerciseId];
    if (filter.setupId !== undefined) {
      where.push('setup_id = ?');
      params.push(filter.setupId);
    }
    // `side`, never `slot` — see the ExerciseSetsFilter doc comment.
    if (filter.side !== undefined) {
      where.push('side = ?');
      params.push(filter.side);
    }
    if (filter.settingsHash !== undefined) {
      where.push('settings_hash = ?');
      params.push(filter.settingsHash);
    }
    if (filter.purpose !== undefined) {
      where.push(`set_purpose IN (${filter.purpose.map(() => '?').join(', ')})`);
      params.push(...filter.purpose);
    }
    if (filter.from !== undefined) {
      where.push('started_at >= ?');
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push('started_at <= ?');
      params.push(filter.to);
    }
    // Ascending, matching `getSetsForSession`: these rows are read as a
    // progression over time, and two per-set readers disagreeing on direction
    // is a bug that only shows up in the chart.
    let sql = `SELECT * FROM sets WHERE ${where.join(' AND ')} ORDER BY started_at ASC`;
    if (filter.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as unknown as SetRow[];
    return Promise.resolve(rows.map((row) => rowToSet(row, this.loadRepsForSet(row.id))));
  }

  async getMostRecentSessionIdForExercise(filter: {
    userId: string;
    exerciseId: string;
  }): Promise<string | null> {
    // `idx_sets_user_exercise(user_id, exercise_id, started_at)` covers this
    // exactly: seek to (userId, exerciseId), walk started_at DESC, stop at 1.
    // No rep hydration — the caller only wants the session id.
    const row = this.db
      .prepare(
        `SELECT session_id FROM sets WHERE user_id = ? AND exercise_id = ? ` +
          `ORDER BY started_at DESC LIMIT 1`,
      )
      .get(filter.userId, filter.exerciseId) as { session_id: string } | undefined;
    return Promise.resolve(row?.session_id ?? null);
  }

  // --- Idle reps (v7 schema) ---

  async putIdleRep(rep: StoredIdleRep): Promise<void> {
    // `ON CONFLICT DO UPDATE`, never `INSERT OR REPLACE`, for the reason
    // `putSession` / `putSet` spell out: a replace is a delete-then-insert, and
    // `idle_reps` sits on the `users` cascade. Ids are generated per detection
    // so the conflict branch is not expected in practice — which is precisely
    // why it must not be a destructive one when it does fire.
    // EVERY WRITTEN COLUMN MUST APPEAR IN BOTH LISTS.
    this.db
      .prepare(
        `INSERT INTO idle_reps
           (id, user_id, session_id, device_id, slot, side, observed_at,
            weight_lbs, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           user_id = excluded.user_id,
           session_id = excluded.session_id,
           device_id = excluded.device_id,
           slot = excluded.slot,
           side = excluded.side,
           observed_at = excluded.observed_at,
           weight_lbs = excluded.weight_lbs,
           payload = excluded.payload`,
      )
      .run(
        rep.id,
        rep.userId ?? null,
        rep.sessionId ?? null,
        rep.deviceId ?? null,
        rep.slot ?? null,
        rep.side ?? null,
        rep.observedAt,
        // Absent stays NULL. A `0` here would read downstream as a measured
        // unloaded pull rather than as an unknown load.
        rep.weightLbs ?? null,
        rep.rep === undefined
          ? null
          : serializeRepPayload(rep.rep, `SqliteSessionStore.putIdleRep: idle rep ${rep.id}`),
      );
    return Promise.resolve();
  }

  async listIdleReps(filter: {
    sessionId?: string;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<StoredIdleRep[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.sessionId !== undefined) {
      where.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.from !== undefined) {
      where.push('observed_at >= ?');
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push('observed_at <= ?');
      params.push(filter.to);
    }
    const sql =
      `SELECT * FROM idle_reps` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY observed_at ASC LIMIT ?`;
    const rows = this.db
      .prepare(sql)
      .all(...params, filter.limit ?? IDLE_REP_LIST_DEFAULT_LIMIT) as unknown as IdleRepRow[];
    return Promise.resolve(rows.map(rowToIdleRep));
  }

  // --- Isometric assessments (v6 schema) ---

  async putIsometricMeasurement(m: StoredIsometricMeasurement): Promise<void> {
    // `ON CONFLICT DO UPDATE`, never `INSERT OR REPLACE`: `isometric_trials`
    // references this row `ON DELETE CASCADE`, so the delete half of a
    // replace would drop every trial of the measurement being re-put — the
    // #79 cascade, one table over.
    const upsertMeasurement = this.db.prepare(
      `INSERT INTO isometric_measurements
         (id, measured_at, analysis_version, first_side_tested,
          duration_ms, trials_requested, rest_ms, between_sides_rest_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         measured_at = excluded.measured_at,
         analysis_version = excluded.analysis_version,
         first_side_tested = excluded.first_side_tested,
         duration_ms = excluded.duration_ms,
         trials_requested = excluded.trials_requested,
         rest_ms = excluded.rest_ms,
         between_sides_rest_ms = excluded.between_sides_rest_ms`,
    );
    // Trials are replaced wholesale on a re-put, exactly like `putSet` does
    // with reps: the trial array is the measurement's content, not an
    // independently-addressed collection.
    const deleteTrials = this.db.prepare(`DELETE FROM isometric_trials WHERE measurement_id = ?`);
    const insertTrial = this.db.prepare(
      `INSERT INTO isometric_trials
         (id, measurement_id, device_id, side, slot, trial_index,
          peak_force_lbs, plateau_force_lbs, plateau_start_ms, plateau_end_ms,
          valid, invalid_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.exec('BEGIN');
    try {
      upsertMeasurement.run(
        m.id,
        m.measuredAt,
        m.analysisVersion,
        m.firstSideTested ?? null,
        m.durationMs,
        m.trialsRequested,
        m.restMs,
        m.betweenSidesRestMs ?? null,
      );
      deleteTrials.run(m.id);
      for (const side of m.sides) {
        for (const trial of side.trials) {
          insertTrial.run(
            trial.id,
            m.id,
            side.deviceId ?? null,
            side.side ?? null,
            side.slot ?? null,
            trial.index,
            trial.peakForceLbs,
            trial.plateauForceLbs,
            trial.plateauStartMs,
            trial.plateauEndMs,
            trial.valid ? 1 : 0,
            trial.invalidReason ?? null,
          );
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return Promise.resolve();
  }

  async getIsometricMeasurement(id: string): Promise<StoredIsometricMeasurement | undefined> {
    const row = this.db.prepare(`SELECT * FROM isometric_measurements WHERE id = ?`).get(id) as
      | IsometricMeasurementRow
      | undefined;
    if (!row) return Promise.resolve(undefined);
    return Promise.resolve(rowToIsometricMeasurement(row, this.loadTrialsForMeasurement(row.id)));
  }

  async getIsometricMeasurementsForDevice(
    deviceId: string,
    opts: { limit?: number } = {},
  ): Promise<StoredIsometricMeasurement[]> {
    // Match on the trial rows' device_id (the join key), then load each
    // matched measurement in full so the caller gets BOTH limbs of the run —
    // an asymmetry is meaningless with one side of it missing.
    const rows = this.db
      .prepare(
        `SELECT m.* FROM isometric_measurements m
         WHERE EXISTS (
           SELECT 1 FROM isometric_trials t
           WHERE t.measurement_id = m.id AND t.device_id = ?
         )
         ORDER BY m.measured_at DESC
         LIMIT ?`,
      )
      .all(deviceId, opts.limit ?? 50) as unknown as IsometricMeasurementRow[];
    return Promise.resolve(
      rows.map((row) => rowToIsometricMeasurement(row, this.loadTrialsForMeasurement(row.id))),
    );
  }

  // --- Block-periodization planning (v3 schema) ---

  async putTrainingProgram(p: StoredTrainingProgram): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO training_programs
           (id, name, description, created_at, archived_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           created_at = excluded.created_at,
           archived_at = excluded.archived_at`,
      )
      .run(p.id, p.name, p.description ?? null, p.createdAt, p.archivedAt ?? null);
    return Promise.resolve();
  }

  async getTrainingProgram(id: string): Promise<StoredTrainingProgram | undefined> {
    const row = this.db.prepare(`SELECT * FROM training_programs WHERE id = ?`).get(id) as
      | TrainingProgramRow
      | undefined;
    return Promise.resolve(row ? rowToTrainingProgram(row) : undefined);
  }

  async listTrainingPrograms(
    opts: {
      includeArchived?: boolean;
    } = {},
  ): Promise<StoredTrainingProgram[]> {
    const sql = opts.includeArchived
      ? `SELECT * FROM training_programs ORDER BY created_at DESC`
      : `SELECT * FROM training_programs WHERE archived_at IS NULL ORDER BY created_at DESC`;
    const rows = this.db.prepare(sql).all() as unknown as TrainingProgramRow[];
    return Promise.resolve(rows.map(rowToTrainingProgram));
  }

  async putTrainingBlock(b: StoredTrainingBlock): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO training_blocks
           (id, program_id, order_index, name, focus, weeks_count, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           program_id = excluded.program_id,
           order_index = excluded.order_index,
           name = excluded.name,
           focus = excluded.focus,
           weeks_count = excluded.weeks_count,
           notes = excluded.notes`,
      )
      .run(b.id, b.programId, b.orderIndex, b.name, b.focus ?? null, b.weeksCount, b.notes ?? null);
    return Promise.resolve();
  }

  async getTrainingBlock(id: string): Promise<StoredTrainingBlock | undefined> {
    const row = this.db.prepare(`SELECT * FROM training_blocks WHERE id = ?`).get(id) as
      | TrainingBlockRow
      | undefined;
    return Promise.resolve(row ? rowToTrainingBlock(row) : undefined);
  }

  async getTrainingBlocksForProgram(programId: string): Promise<StoredTrainingBlock[]> {
    const rows = this.db
      .prepare(`SELECT * FROM training_blocks WHERE program_id = ? ORDER BY order_index ASC`)
      .all(programId) as unknown as TrainingBlockRow[];
    return Promise.resolve(rows.map(rowToTrainingBlock));
  }

  async putTrainingWeek(w: StoredTrainingWeek): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO training_weeks
           (id, block_id, order_index, name)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           block_id = excluded.block_id,
           order_index = excluded.order_index,
           name = excluded.name`,
      )
      .run(w.id, w.blockId, w.orderIndex, w.name ?? null);
    return Promise.resolve();
  }

  async getTrainingWeek(id: string): Promise<StoredTrainingWeek | undefined> {
    const row = this.db.prepare(`SELECT * FROM training_weeks WHERE id = ?`).get(id) as
      | TrainingWeekRow
      | undefined;
    return Promise.resolve(row ? rowToTrainingWeek(row) : undefined);
  }

  async getTrainingWeeksForBlock(blockId: string): Promise<StoredTrainingWeek[]> {
    const rows = this.db
      .prepare(`SELECT * FROM training_weeks WHERE block_id = ? ORDER BY order_index ASC`)
      .all(blockId) as unknown as TrainingWeekRow[];
    return Promise.resolve(rows.map(rowToTrainingWeek));
  }

  async putWorkoutTemplate(t: StoredWorkoutTemplate): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO workout_templates
           (id, week_id, day_label, name, notes, order_index)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           week_id = excluded.week_id,
           day_label = excluded.day_label,
           name = excluded.name,
           notes = excluded.notes,
           order_index = excluded.order_index`,
      )
      .run(t.id, t.weekId, t.dayLabel ?? null, t.name, t.notes ?? null, t.orderIndex);
    return Promise.resolve();
  }

  async getWorkoutTemplate(id: string): Promise<StoredWorkoutTemplate | undefined> {
    const row = this.db.prepare(`SELECT * FROM workout_templates WHERE id = ?`).get(id) as
      | WorkoutTemplateRow
      | undefined;
    return Promise.resolve(row ? rowToWorkoutTemplate(row) : undefined);
  }

  async getWorkoutTemplatesForWeek(weekId: string): Promise<StoredWorkoutTemplate[]> {
    const rows = this.db
      .prepare(`SELECT * FROM workout_templates WHERE week_id = ? ORDER BY order_index ASC`)
      .all(weekId) as unknown as WorkoutTemplateRow[];
    return Promise.resolve(rows.map(rowToWorkoutTemplate));
  }

  async putPlannedExercise(e: StoredPlannedExercise): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO planned_exercises
           (id, workout_template_id, exercise_id, order_index, target_sets,
            target_reps_low, target_reps_high, target_weight_lbs, target_rpe,
            rest_sec, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workout_template_id = excluded.workout_template_id,
           exercise_id = excluded.exercise_id,
           order_index = excluded.order_index,
           target_sets = excluded.target_sets,
           target_reps_low = excluded.target_reps_low,
           target_reps_high = excluded.target_reps_high,
           target_weight_lbs = excluded.target_weight_lbs,
           target_rpe = excluded.target_rpe,
           rest_sec = excluded.rest_sec,
           notes = excluded.notes`,
      )
      .run(
        e.id,
        e.workoutTemplateId,
        e.exerciseId,
        e.orderIndex,
        e.targetSets,
        e.targetRepsLow ?? null,
        e.targetRepsHigh ?? null,
        e.targetWeightLbs ?? null,
        e.targetRpe ?? null,
        e.restSec ?? null,
        e.notes ?? null,
      );
    return Promise.resolve();
  }

  async getPlannedExercise(id: string): Promise<StoredPlannedExercise | undefined> {
    const row = this.db.prepare(`SELECT * FROM planned_exercises WHERE id = ?`).get(id) as
      | PlannedExerciseRow
      | undefined;
    return Promise.resolve(row ? rowToPlannedExercise(row) : undefined);
  }

  async getPlannedExercisesForTemplate(templateId: string): Promise<StoredPlannedExercise[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM planned_exercises WHERE workout_template_id = ? ORDER BY order_index ASC`,
      )
      .all(templateId) as unknown as PlannedExerciseRow[];
    return Promise.resolve(rows.map(rowToPlannedExercise));
  }

  /**
   * The one planning DELETE (VW-121). A plain `DELETE` and not a soft-delete
   * flag: a planned row carries no history of its own — what was actually
   * trained lives in `sets` / `program_assignments`, and the assignment's
   * `planned_exercise_id` FK is `ON DELETE SET NULL`, so a past session keeps
   * its `workout_template_id` link even after the lift leaves the template.
   */
  async deletePlannedExercise(id: string): Promise<boolean> {
    const result = this.db.prepare(`DELETE FROM planned_exercises WHERE id = ?`).run(id);
    return Promise.resolve(result.changes > 0);
  }

  async putProgramAssignment(a: StoredProgramAssignment): Promise<void> {
    this.db
      .prepare(
        // Upsert in place, not `INSERT OR REPLACE`. `program_assignments` has
        // no children today, but a delete-then-insert on any row that sits in
        // the FK graph is the #79 footgun waiting for the next child table;
        // keep every parent-table upsert on the same safe form.
        `INSERT INTO program_assignments
           (id, session_id, planned_exercise_id, workout_template_id, assigned_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           session_id = excluded.session_id,
           planned_exercise_id = excluded.planned_exercise_id,
           workout_template_id = excluded.workout_template_id,
           assigned_at = excluded.assigned_at`,
      )
      .run(
        a.id,
        a.sessionId,
        a.plannedExerciseId ?? null,
        a.workoutTemplateId ?? null,
        a.assignedAt,
      );
    return Promise.resolve();
  }

  async getAssignmentsForSession(sessionId: string): Promise<StoredProgramAssignment[]> {
    const rows = this.db
      .prepare(`SELECT * FROM program_assignments WHERE session_id = ? ORDER BY assigned_at ASC`)
      .all(sessionId) as unknown as ProgramAssignmentRow[];
    return Promise.resolve(rows.map(rowToProgramAssignment));
  }

  async getAssignmentsForTemplate(templateId: string): Promise<StoredProgramAssignment[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM program_assignments WHERE workout_template_id = ? ORDER BY assigned_at ASC`,
      )
      .all(templateId) as unknown as ProgramAssignmentRow[];
    return Promise.resolve(rows.map(rowToProgramAssignment));
  }

  async putTrainingProfile(p: StoredTrainingProfile): Promise<void> {
    // `ON CONFLICT DO UPDATE`, never `INSERT OR REPLACE` — `training_profile`
    // is keyed on `user_id`, and while it currently has no children, the
    // project convention (see `putSet`/`putSession`) is upsert-in-place for
    // every table so a future FK child never inherits a delete-then-insert
    // hazard by accident.
    this.db
      .prepare(
        `INSERT INTO training_profile
           (user_id, declared_tier, declared_at, years_training, history_consistent,
            ever_plateaued, reported_sets_per_muscle, goal, goal_set_at,
            days_available, days_reliable, onboarded_at, provenance_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           declared_tier = excluded.declared_tier,
           declared_at = excluded.declared_at,
           years_training = excluded.years_training,
           history_consistent = excluded.history_consistent,
           ever_plateaued = excluded.ever_plateaued,
           reported_sets_per_muscle = excluded.reported_sets_per_muscle,
           goal = excluded.goal,
           goal_set_at = excluded.goal_set_at,
           days_available = excluded.days_available,
           days_reliable = excluded.days_reliable,
           onboarded_at = excluded.onboarded_at,
           provenance_json = excluded.provenance_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        p.userId,
        p.declaredTier ?? null,
        p.declaredAt ?? null,
        p.yearsTraining ?? null,
        p.historyConsistent === undefined ? null : p.historyConsistent ? 1 : 0,
        p.everPlateaued === undefined ? null : p.everPlateaued ? 1 : 0,
        p.reportedSetsPerMuscle ?? null,
        p.goal ?? null,
        p.goalSetAt ?? null,
        p.daysAvailable ?? null,
        p.daysReliable ?? null,
        p.onboardedAt ?? null,
        p.provenance === undefined ? null : JSON.stringify(p.provenance),
        p.updatedAt,
      );
    return Promise.resolve();
  }

  async getTrainingProfile(userId: string): Promise<StoredTrainingProfile | undefined> {
    const row = this.db.prepare(`SELECT * FROM training_profile WHERE user_id = ?`).get(userId) as
      | TrainingProfileRow
      | undefined;
    return Promise.resolve(row ? rowToTrainingProfile(row) : undefined);
  }

  // --- Exercise baselines (I5 / B56, VW-116) ---

  async getBaseline(key: BaselineKey): Promise<StoredExerciseBaseline | undefined> {
    assertDefaultSetup(key);
    const row = this.db
      .prepare(`SELECT * FROM exercise_baselines WHERE id = ?`)
      .get(baselineRowId(key)) as ExerciseBaselineRow | undefined;
    return Promise.resolve(row ? rowToExerciseBaseline(row) : undefined);
  }

  async recalcBaseline(key: BaselineKey): Promise<StoredExerciseBaseline> {
    assertDefaultSetup(key);
    // Working sets only. A warm-up ramp and a technique set are performed at
    // deliberately different intent and cadence; counting them as shape
    // evidence is how a baseline ends up describing an exercise nobody did.
    const sets = await this.getSetsForExercise({
      userId: key.userId,
      exerciseId: key.exerciseId,
      ...(key.side !== undefined ? { side: key.side } : {}),
      purpose: ['working'],
    });
    const observations: BaselineObservations = {
      ...summarizeSets(sets),
      anchors: this.selectAnchors(key),
    };
    const now = new Date();
    const row = toBaselineRow(key, deriveBaselineState(observations, now), now.toISOString());
    this.upsertBaseline(row);
    return row;
  }

  /**
   * Failure anchors for one key. Only anchors whose harvest filter ACCEPTED
   * them (`filter_verdict = 'failure'`) count: the table deliberately stores
   * rejected candidates too, so a changed filter can re-derive past verdicts,
   * and counting a rejected candidate as evidence would defeat that.
   *
   * `sessionBucket` is the anchor's session where resolvable and a per-day
   * bucket otherwise (an anchor whose set row was deleted still happened on
   * some day). It exists so several anchors from ONE bout cannot satisfy the
   * distinct-sessions gate — correlated anchors look more consistent than they
   * are.
   */
  private selectAnchors(key: BaselineKey): AnchorObservation[] {
    const where = ['fa.user_id = ?', 'fa.exercise_id = ?', 'fa.setup_id IS NULL'];
    const params: string[] = [key.userId, key.exerciseId];
    if (key.side !== undefined) {
      where.push('fa.side = ?');
      params.push(key.side);
    }
    const rows = this.db
      .prepare(
        `SELECT s.session_id AS session_id, fa.observed_at AS observed_at,
                fa.terminal_velocity_mps AS terminal_velocity_mps
           FROM failure_anchors fa
           LEFT JOIN sets s ON s.id = fa.set_id
          WHERE ${where.join(' AND ')} AND fa.filter_verdict = 'failure'
          ORDER BY fa.observed_at ASC`,
      )
      .all(...params) as unknown as FailureAnchorJoinRow[];
    return rows.map((row) => {
      const out: AnchorObservation = {
        sessionBucket: row.session_id ?? `day:${row.observed_at.slice(0, 10)}`,
      };
      if (row.terminal_velocity_mps !== null) {
        out.terminalVelocityMps = row.terminal_velocity_mps;
      }
      return out;
    });
  }

  /**
   * `ON CONFLICT DO UPDATE`, never `INSERT OR REPLACE`: `exercise_baselines`
   * sits on the `users` cascade, and a delete-then-insert is the wrong
   * primitive for the reason `putSet` spells out (#79).
   *
   * The conflict target is `id`, NOT the `UNIQUE (user_id, exercise_id,
   * setup_id, side)` constraint — deliberately. SQLite treats NULLs in a
   * UNIQUE index as distinct from each other, so with `setup_id` always NULL
   * (no setup writer exists yet) that constraint never fires and a conflict
   * clause aimed at it would insert a duplicate row on every recalc instead of
   * updating. `id` is `baselineKeyId(key)` — a total function of the same four
   * dimensions, NULLs included — so it is the identity that actually holds.
   * EVERY WRITTEN COLUMN MUST APPEAR IN BOTH LISTS.
   */
  private upsertBaseline(b: StoredExerciseBaseline): void {
    this.db
      .prepare(
        `INSERT INTO exercise_baselines
           (id, user_id, exercise_id, setup_id, side, state, confidence,
            observed_sessions, anchor_count, anchor_spread, first_observed_at,
            updated_at, invalidated_at, invalidation_reason, algorithm_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           confidence = excluded.confidence,
           observed_sessions = excluded.observed_sessions,
           anchor_count = excluded.anchor_count,
           anchor_spread = excluded.anchor_spread,
           first_observed_at = excluded.first_observed_at,
           updated_at = excluded.updated_at,
           invalidated_at = excluded.invalidated_at,
           invalidation_reason = excluded.invalidation_reason,
           algorithm_version = excluded.algorithm_version`,
      )
      .run(
        b.id,
        b.userId,
        b.exerciseId,
        b.setupId ?? null,
        b.side ?? null,
        b.state,
        b.confidence ?? null,
        b.observedSessions,
        b.anchorCount,
        b.anchorSpread ?? null,
        b.firstObservedAt ?? null,
        b.updatedAt,
        b.invalidatedAt ?? null,
        b.invalidationReason ?? null,
        b.algorithmVersion,
      );
  }

  async close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    try {
      this.db.close();
    } catch (err) {
      log.warn('SqliteSessionStore.close() failed', err);
    }
    return Promise.resolve();
  }

  private loadTrialsForMeasurement(measurementId: string): IsometricTrialRow[] {
    return this.db
      .prepare(
        `SELECT * FROM isometric_trials WHERE measurement_id = ? ORDER BY side ASC, trial_index ASC`,
      )
      .all(measurementId) as unknown as IsometricTrialRow[];
  }

  private loadRepsForSet(setId: string): StoredRep[] {
    const rows = this.db
      .prepare(`SELECT * FROM reps WHERE set_id = ? ORDER BY rep_index ASC`)
      .all(setId) as unknown as RepRow[];
    return rows.map((row) => JSON.parse(row.payload) as StoredRep);
  }
}

/**
 * Serialize a rep to its stored JSON payload, coercing any non-finite number
 * (NaN / ±Infinity) to 0 first.
 *
 * `JSON.stringify` renders non-finite numbers as `null`, which would read back
 * as `null` in a numeric field and surface as NaN in downstream analytics — a
 * silent corruption. Coercing to 0 keeps the value finite and round-trippable;
 * a coercion is logged so bad upstream data is observable rather than silent.
 * (Rejecting the write instead would drop the whole set, which is worse for a
 * store whose primary job is not losing recorded work.)
 *
 * `context` identifies the offending row in the warning — set reps and idle
 * reps share this helper, and a bare rep id would not say which table to look
 * in.
 */
function serializeRepPayload(rep: Rep, context: string): string {
  let coerced = false;
  const json = JSON.stringify(rep, (_key, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      coerced = true;
      return 0;
    }
    return value;
  });
  if (coerced) {
    log.warn(`${context}: coerced non-finite number(s) to 0`);
  }
  return json;
}

function checkSchemaVersion(db: DatabaseSync, path: string): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const found = row?.user_version ?? 0;
  // 0 = brand-new DB (CREATE TABLE IF NOT EXISTS will populate it).
  // 1 = pre-Phase-0.5.1 schema (migrated forward in `applyMigrations`).
  // 2 = Phase 0.5.1 schema; v3 added the planning tables (additive only).
  // 3 = v3 planning schema; v4 added `sets.is_warmup` (additive column).
  // 4 = v4 schema; v5 added `sets.slot` / `sets.device_id` / `sets.side`
  //     (additive columns).
  // 5 = v5 schema; v6 added the isometric assessment tables (additive tables).
  // 5 = v5 schema; v6 rebuilt `sets` (nullability + capture columns), added a
  //     user dimension, and introduced the state tables.
  // 7 = v7 schema; v8 renamed `sets.firmware_rep_duration_ms` (free, empty).
  // 8 = v8 schema; v9 renamed `sets.inverse_chains` to `inverse_chains_lbs`
  //     (free, empty — the column was never written).
  // 9 = v9 schema; v10 adds `idx_sets_exercise_session` (VMCP-01.72b S4) so
  //     `listSessions`'s per-set exercise-id subquery can seek instead of
  //     scanning all of `sets` — additive index only, no data change.
  // SCHEMA_VERSION = current. Anything else is an unknown future version
  // and we refuse to touch it.
  if (
    found !== 0 &&
    found !== 1 &&
    found !== 2 &&
    found !== 3 &&
    found !== 4 &&
    found !== 5 &&
    found !== 6 &&
    found !== 7 &&
    found !== 8 &&
    found !== 9 &&
    found !== SCHEMA_VERSION
  ) {
    throw createSchemaIncompatibleError(path, found);
  }
}

/**
 * Apply forward migrations on an open `db`. Idempotent: each migration is
 * gated by the user_version it targets, so running on a fresh v3 DB is a
 * no-op. Runs after `SCHEMA_SQL` so brand-new DBs already have the v3 table
 * shape and skip every migration body.
 */
function applyMigrations(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;
  if (current === 1) {
    db.exec(MIGRATE_V1_TO_V2_SQL);
  }
  if (current <= 2) {
    db.exec(MIGRATE_V2_TO_V3_SQL);
  }
  if (current <= 3) {
    migrateV3ToV4(db);
  }
  if (current <= 4) {
    migrateV4ToV5(db);
  }
  if (current <= 5) {
    db.exec(MIGRATE_V5_TO_V6_SQL);
  }
  if (current <= 6) {
    migrateV6ToV7(db);
  }
  if (current <= 7) {
    migrateV7ToV8(db);
  }
  if (current <= 8) {
    migrateV8ToV9(db);
  }
  if (current <= 9) {
    migrateV9ToV10(db);
  }
}

function probeWriteLock(db: DatabaseSync, path: string): void {
  // BEGIN IMMEDIATE acquires (and we immediately release) a RESERVED lock,
  // which fails with SQLITE_BUSY if another connection holds an exclusive
  // or pending write lock on the same database file. This converts the
  // lock contention into a clear startup error before any user data is
  // written.
  //
  // This is a best-effort STARTUP-INSTANT probe, not a persistent lock: it
  // only trips if the incumbent process is holding a write lock at this exact
  // moment. Two processes that both open while neither is mid-write will both
  // pass this probe (the DB is not in WAL mode, and we don't retain the lock),
  // and their later concurrent writes will then throw SQLITE_BUSY. The
  // single-writer contract (one process per VMCP_DB_PATH) is a caller
  // responsibility; this probe catches the common case, it does not enforce it.
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('COMMIT');
  } catch (err) {
    if (isSqliteBusy(err)) {
      throw createLockedError(path, err);
    }
    throw err;
  }
}

function isSqliteBusy(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const errAny = err as Error & { code?: string; errcode?: number };
  if (
    typeof errAny.code === 'string' &&
    (errAny.code === 'SQLITE_BUSY' || errAny.code === 'EBUSY')
  ) {
    return true;
  }
  // node:sqlite reports SQLite error codes via `errcode` (numeric); 5 is
  // SQLITE_BUSY and 6 is SQLITE_LOCKED. The wrapping `code` is the generic
  // `ERR_SQLITE_ERROR`, so fall back to the numeric code or the message.
  if (errAny.errcode === 5 || errAny.errcode === 6) return true;
  return /SQLITE_BUSY|database is locked|EBUSY/i.test(err.message);
}

function createSchemaIncompatibleError(path: string, found: number): Error {
  const message =
    `SQLite schema at ${path} has user_version=${found}; ` +
    `expected ${SCHEMA_VERSION}. Automatic migration is not supported in v1. ` +
    `Move or delete the file and let voltras-mcp recreate it.`;
  const err = new Error(message);
  (err as Error & { code: string }).code = 'SCHEMA_INCOMPATIBLE';
  return err;
}

function createLockedError(path: string, cause: unknown): Error {
  const message =
    `VMCP_DB_PATH ${path} is already in use by another process. ` +
    `Stdio MCP servers are single-writer by design — close the other ` +
    `voltras-mcp process or set VMCP_DB_PATH to a different file.`;
  const err = new Error(message, { cause });
  (err as Error & { code: string }).code = 'DB_LOCKED';
  return err;
}

function rowToSession(row: SessionRow): StoredSession {
  const out: StoredSession = { id: row.id, startedAt: row.started_at };
  if (row.ended_at !== null) out.endedAt = row.ended_at;
  if (row.exercise_id !== null) out.exerciseId = row.exercise_id;
  if (row.exercise_name !== null) out.exerciseName = row.exercise_name;
  if (row.notes !== null) out.notes = row.notes;
  return out;
}

function rowToSet(row: SetRow, reps: StoredRep[]): StoredSet {
  const out: StoredSet = {
    id: row.id,
    sessionId: row.session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    partial: row.partial !== 0,
    reps,
  };
  // Absent, never coalesced. Substituting 0 / 'Unknown' here would reintroduce
  // the exact silent default v6 exists to remove — a gap is detectable
  // downstream, a plausible wrong value is not. Choosing how to DISPLAY a gap
  // belongs to the read-model, not the store.
  if (row.training_mode !== null) out.trainingMode = row.training_mode;
  if (row.weight_lbs !== null) out.weightLbs = row.weight_lbs;
  if (row.partial_reason !== null) out.partialReason = row.partial_reason;
  if (row.is_warmup !== 0) out.isWarmup = true;
  // Absent (not null / not `'primary'`) on pre-v5 rows: unknown slot is not
  // the same claim as "the primary slot did it".
  if (row.slot !== null) out.slot = row.slot;
  if (row.device_id !== null) out.deviceId = row.device_id;
  // `side` is a free-text column at the SQLite level; narrow on read rather
  // than casting, so a row carrying anything other than the two legal values
  // reads back as side-unknown instead of as a bogus side.
  if (row.side === 'left' || row.side === 'right') out.side = row.side;

  // v7 capture columns. Absent stays absent throughout — every one of these is
  // unrecoverable if it was not captured, so a NULL is a real gap and must not
  // be papered over with a default.
  if (row.user_id !== null) out.userId = row.user_id;
  if (row.exercise_id !== null) out.exerciseId = row.exercise_id;
  if (row.set_index_in_session !== null) out.setIndexInSession = row.set_index_in_session;
  if (row.rest_before_sec !== null) out.restBeforeSec = row.rest_before_sec;
  if (row.battery_pct !== null) out.batteryPct = row.battery_pct;
  if (row.source === 'local' || row.source === 'imported' || row.source === 'mock') {
    out.source = row.source;
  }
  if (row.position_units === 'device_native' || row.position_units === 'meters') {
    out.positionUnits = row.position_units;
  }
  if (row.sample_rate_hz !== null) out.sampleRateHz = row.sample_rate_hz;
  if (row.firmware_rep_count !== null) out.firmwareRepCount = row.firmware_rep_count;
  if (row.firmware_summary_duration_ms !== null) {
    out.firmwareSummaryDurationMs = row.firmware_summary_duration_ms;
  }
  if (row.firmware_reps_json !== null) out.firmwareRepsJson = row.firmware_reps_json;
  if (row.bilateral_group_id !== null) out.bilateralGroupId = row.bilateral_group_id;
  if (row.group_source === 'live' || row.group_source === 'inferred') {
    out.groupSource = row.group_source;
  }
  if (row.chains_lbs !== null) out.chainsLbs = row.chains_lbs;
  if (row.damper_level !== null) out.damperLevel = row.damper_level;
  if (row.eccentric_pct !== null) out.eccentricPct = row.eccentric_pct;
  if (row.inverse_chains_lbs !== null) out.inverseChainsLbs = row.inverse_chains_lbs;
  if (row.assist_mode !== null) out.assistMode = row.assist_mode;
  if (row.settings_json !== null) out.settingsJson = row.settings_json;
  if (row.settings_hash !== null) out.settingsHash = row.settings_hash;
  return out;
}

function rowToIdleRep(row: IdleRepRow): StoredIdleRep {
  const out: StoredIdleRep = {
    id: row.id,
    observedAt: row.observed_at,
  };
  // Absent stays absent, exactly as in `rowToSet`: an idle rep is observed with
  // whatever context existed at that instant, and a NULL here is a real gap.
  if (row.user_id !== null) out.userId = row.user_id;
  // A NULL session is the ordinary "no session was running" case, not a defect.
  if (row.session_id !== null) out.sessionId = row.session_id;
  if (row.device_id !== null) out.deviceId = row.device_id;
  if (row.slot !== null) out.slot = row.slot;
  // `side` is free text at the SQLite level (the CHECK constraint guards new
  // writes, not pre-existing rows); narrow on read so nothing but the two legal
  // values can pass as a measured limb — same treatment `rowToSet` gives it.
  if (row.side === 'left' || row.side === 'right') out.side = row.side;
  if (row.weight_lbs !== null) out.weightLbs = row.weight_lbs;
  if (row.payload !== null) {
    const rep = parseRepPayload(row.payload, row.id);
    if (rep !== undefined) out.rep = rep;
  }
  return out;
}

/**
 * Parse a stored rep payload, returning `undefined` when it no longer parses.
 *
 * A row whose JSON is unreadable still carries a real observation in its
 * columns (when, which device, which limb, what load); throwing here would
 * discard that whole row — and every other row in the same page — over one bad
 * blob. The failure is logged so it is observable rather than silent.
 */
function parseRepPayload(payload: string, rowId: string): Rep | undefined {
  try {
    return JSON.parse(payload) as Rep;
  } catch {
    log.warn(`SqliteSessionStore: unparseable rep payload on idle rep ${rowId}; reading as absent`);
    return undefined;
  }
}

/**
 * Reassemble a measurement plus its flat trial rows into the nested
 * `sides → trials` shape. Trials are grouped by their identity triple
 * (`device_id` / `side` / `slot`) rather than by `side` alone: side is the
 * nullable, resolved field, so grouping on it would silently merge two
 * side-unknown units into one pseudo-limb. The device id is the ground truth
 * and leads the key.
 */
function rowToIsometricMeasurement(
  row: IsometricMeasurementRow,
  trialRows: IsometricTrialRow[],
): StoredIsometricMeasurement {
  const groups = new Map<string, StoredIsometricSideMeasurement>();
  for (const t of trialRows) {
    const key = `${t.device_id ?? ''}\0${t.side ?? ''}\0${t.slot ?? ''}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { trials: [] };
      // `side` is free text at the SQLite level; narrow on read so a row
      // carrying anything else reads back side-unknown, not as a bogus limb —
      // same treatment `rowToSet` gives `sets.side`.
      if (t.side === 'left' || t.side === 'right') group.side = t.side;
      if (t.device_id !== null) group.deviceId = t.device_id;
      if (t.slot !== null) group.slot = t.slot;
      groups.set(key, group);
    }
    const trial: StoredIsometricTrial = {
      id: t.id,
      index: t.trial_index,
      peakForceLbs: t.peak_force_lbs,
      plateauForceLbs: t.plateau_force_lbs,
      plateauStartMs: t.plateau_start_ms,
      plateauEndMs: t.plateau_end_ms,
      valid: t.valid !== 0,
    };
    if (t.invalid_reason !== null) trial.invalidReason = t.invalid_reason;
    group.trials.push(trial);
  }
  const out: StoredIsometricMeasurement = {
    id: row.id,
    measuredAt: row.measured_at,
    analysisVersion: row.analysis_version,
    durationMs: row.duration_ms,
    trialsRequested: row.trials_requested,
    restMs: row.rest_ms,
    sides: [...groups.values()],
  };
  if (row.first_side_tested === 'left' || row.first_side_tested === 'right') {
    out.firstSideTested = row.first_side_tested;
  }
  if (row.between_sides_rest_ms !== null) out.betweenSidesRestMs = row.between_sides_rest_ms;
  return out;
}

function rowToTrainingProgram(row: TrainingProgramRow): StoredTrainingProgram {
  const out: StoredTrainingProgram = {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
  };
  if (row.description !== null) out.description = row.description;
  if (row.archived_at !== null) out.archivedAt = row.archived_at;
  return out;
}

function rowToTrainingProfile(row: TrainingProfileRow): StoredTrainingProfile {
  const out: StoredTrainingProfile = {
    userId: row.user_id,
    updatedAt: row.updated_at,
  };
  if (row.declared_tier !== null) out.declaredTier = row.declared_tier;
  if (row.declared_at !== null) out.declaredAt = row.declared_at;
  if (row.years_training !== null) out.yearsTraining = row.years_training;
  if (row.history_consistent !== null) out.historyConsistent = row.history_consistent !== 0;
  if (row.ever_plateaued !== null) out.everPlateaued = row.ever_plateaued !== 0;
  if (row.reported_sets_per_muscle !== null) {
    out.reportedSetsPerMuscle = row.reported_sets_per_muscle;
  }
  if (row.goal !== null) out.goal = row.goal;
  if (row.goal_set_at !== null) out.goalSetAt = row.goal_set_at;
  if (row.days_available !== null) out.daysAvailable = row.days_available;
  if (row.days_reliable !== null) out.daysReliable = row.days_reliable;
  if (row.onboarded_at !== null) out.onboardedAt = row.onboarded_at;
  if (row.provenance_json !== null) {
    out.provenance = JSON.parse(row.provenance_json) as Record<string, 'user' | 'llm' | 'default'>;
  }
  return out;
}

function rowToExerciseBaseline(row: ExerciseBaselineRow): StoredExerciseBaseline {
  const out: StoredExerciseBaseline = {
    id: row.id,
    userId: row.user_id,
    exerciseId: row.exercise_id,
    state: row.state,
    observedSessions: row.observed_sessions,
    anchorCount: row.anchor_count,
    updatedAt: row.updated_at,
    algorithmVersion: row.algorithm_version,
  };
  if (row.setup_id !== null) out.setupId = row.setup_id;
  if (row.side !== null) out.side = row.side;
  if (row.confidence !== null) out.confidence = row.confidence;
  if (row.anchor_spread !== null) out.anchorSpread = row.anchor_spread;
  if (row.first_observed_at !== null) out.firstObservedAt = row.first_observed_at;
  if (row.invalidated_at !== null) out.invalidatedAt = row.invalidated_at;
  if (row.invalidation_reason !== null) out.invalidationReason = row.invalidation_reason;
  return out;
}

/**
 * Reject a key that names a setup. The setup dimension is inferred by ROM
 * clustering and that writer does not exist yet, so there is nothing to point
 * at: a caller passing a `setupId` today is working from a wrong mental model
 * and would silently get a row that means something else.
 */
function assertDefaultSetup(key: BaselineKey): void {
  if (key.setupId !== undefined) {
    throw new Error(
      'exercise baselines are per-default-setup only: setup inference (exercise_setups) has no writer yet',
    );
  }
}

function rowToTrainingBlock(row: TrainingBlockRow): StoredTrainingBlock {
  const out: StoredTrainingBlock = {
    id: row.id,
    programId: row.program_id,
    orderIndex: row.order_index,
    name: row.name,
    weeksCount: row.weeks_count,
  };
  if (row.focus !== null) out.focus = row.focus;
  if (row.notes !== null) out.notes = row.notes;
  return out;
}

function rowToTrainingWeek(row: TrainingWeekRow): StoredTrainingWeek {
  const out: StoredTrainingWeek = {
    id: row.id,
    blockId: row.block_id,
    orderIndex: row.order_index,
  };
  if (row.name !== null) out.name = row.name;
  return out;
}

function rowToWorkoutTemplate(row: WorkoutTemplateRow): StoredWorkoutTemplate {
  const out: StoredWorkoutTemplate = {
    id: row.id,
    weekId: row.week_id,
    name: row.name,
    orderIndex: row.order_index,
  };
  if (row.day_label !== null) out.dayLabel = row.day_label;
  if (row.notes !== null) out.notes = row.notes;
  return out;
}

function rowToPlannedExercise(row: PlannedExerciseRow): StoredPlannedExercise {
  const out: StoredPlannedExercise = {
    id: row.id,
    workoutTemplateId: row.workout_template_id,
    exerciseId: row.exercise_id,
    orderIndex: row.order_index,
    targetSets: row.target_sets,
  };
  if (row.target_reps_low !== null) out.targetRepsLow = row.target_reps_low;
  if (row.target_reps_high !== null) out.targetRepsHigh = row.target_reps_high;
  if (row.target_weight_lbs !== null) out.targetWeightLbs = row.target_weight_lbs;
  if (row.target_rpe !== null) out.targetRpe = row.target_rpe;
  if (row.rest_sec !== null) out.restSec = row.rest_sec;
  if (row.notes !== null) out.notes = row.notes;
  return out;
}

function rowToProgramAssignment(row: ProgramAssignmentRow): StoredProgramAssignment {
  const out: StoredProgramAssignment = {
    id: row.id,
    sessionId: row.session_id,
    assignedAt: row.assigned_at,
  };
  if (row.planned_exercise_id !== null) out.plannedExerciseId = row.planned_exercise_id;
  if (row.workout_template_id !== null) out.workoutTemplateId = row.workout_template_id;
  return out;
}
