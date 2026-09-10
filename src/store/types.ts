// Persistence contracts for voltras-mcp.
//
// Mirrors the WA-04 target schema (analytics plan `622c5d67`) so the SQLite
// implementation in `src/store/sqlite-store.ts` can be swapped for a thin
// adapter over `@voltras/workout-analytics` storage once that package ships.
//
// `StoredRep extends Rep` together with the `_STORED_REP_SHAPE_CHECK`
// compile-time `satisfies` assertion locks our stored shape to the upstream
// analytics `Rep` interface.
// If `@voltras/workout-analytics` changes the `Rep` shape, this file fails to
// compile and the schema drift surfaces in CI rather than at runtime.
//
// Designed in tandem with PR 1 of plan `a9cb1cb7`. The accompanying
// `src/store/sqlite-store.ts` (Task 07) provides the only built-in
// implementation of `SessionStore`.
//
// NOTE: `TrainingModeName` is defined here as a string alias rather than
// imported from `src/schemas/common.ts` because schemas land in a parallel
// task; the alias will be unified once both branches merge.
import type { BaselineKey, Rep } from '@voltras/workout-analytics';

import type { FailureVerdict } from './failure-harvest.js';

/** String form of the SDK's `TrainingMode` enum (e.g. `"WeightTraining"`). */
export type TrainingModeName = string;

/**
 * The implicit local user (VMCP-01.72b, N12). Declared here rather than in
 * `sqlite-store.ts` so the tool layer can depend on the persistence
 * CONTRACT for this constant instead of reaching into the store's SQLite
 * implementation for it — `sqlite-store.ts` re-exports it for backward
 * compatibility with existing call sites. v6 introduces a user dimension
 * across the whole schema; a single-user history is modelled as one row
 * rather than as a special case, so multi-user does not require
 * retrofitting every query later.
 */
export const LOCAL_USER_ID = 'local';

/**
 * Physical limb a set was performed with. Mirrors `PhysicalSide` in
 * `state/slot-bindings.ts`, declared locally so the persistence contracts stay
 * free of runtime-layer imports (same reasoning as `TrainingModeName` above).
 */
export type StoredSide = 'left' | 'right';

/**
 * Per-phase slice of the persisted derived VBT block. Velocities are m/s and
 * times are ms, and these read identically to the `set_ended` channel event.
 *
 * ALREADY m/s ON EVERY ROW EVER WRITTEN, including rows whose raw reps are
 * device-native (see {@link StoredSet.velocityUnits}): the derivation boundary
 * applied the mm/s→m/s conversion before the bridge took it over (VW-160). So
 * `normaliseVelocityToMps` deliberately leaves this block alone.
 */
export interface StoredRepPhaseVbt {
  peak_velocity: number;
  mean_velocity: number;
  time_to_peak_velocity_ms: number;
  velocity_drop_pct: number;
  velocity_envelope_mps: [number, number, number, number];
}

/**
 * VMCP-02.64: the per-rep derived VBT block persisted alongside each rep so
 * cross-session VBT trending reads the finalized (corrected) values directly
 * instead of recomputing from raw samples — a recompute that would otherwise
 * reproduce any pre-correction segmentation artifact. Mirrors the `set_ended`
 * payload's per-rep shape one-for-one.
 */
export interface StoredRepVbt {
  rep_number: number;
  concentric: StoredRepPhaseVbt;
  eccentric: StoredRepPhaseVbt;
  rom_m: number | null;
  impulse_lb_s: number | null;
  mean_power_lb_mps: number | null;
  tempo_ratio: number;
  hold_top_ms: number;
}

/**
 * A persisted rep row. Intersected with the upstream analytics `Rep` so that
 * stored reps can be passed straight back into `@voltras/workout-analytics`
 * functions without translation.
 *
 * Modelled as a type intersection rather than `interface … extends Rep`
 * because TypeScript silently drops Rep's fields when an interface extends
 * the type-only re-export chain shipped from `@voltras/workout-analytics`
 * (root → models → rep). The intersection form preserves field visibility.
 *
 * `derived` carries the VMCP-02.64 per-rep VBT block. Optional so historical
 * rows persisted before this field shipped still parse; every row written
 * through `finalizeSet` now populates it.
 */
export type StoredRep = Rep & {
  id: string;
  setId: string;
  index: number;
  derived?: StoredRepVbt;
};

/**
 * Compile-time shape guard: `StoredRep` must remain assignment-compatible
 * with `Rep`. If the upstream `Rep` interface gains or renames a field, the
 * `satisfies` clause below breaks the build — fail loudly at compile time,
 * never silently at runtime.
 */
export const _STORED_REP_SHAPE_CHECK = null as unknown as StoredRep satisfies Rep;

/**
 * A persisted set row. `partial` is true when the set ended for any reason
 * other than an explicit `set.end` call; `partialReason` carries the cause.
 */
export interface StoredSet {
  id: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  partial: boolean;
  partialReason?: string;
  /**
   * Training mode the set was performed in.
   *
   * OPTIONAL AS OF SCHEMA v6. It was previously `NOT NULL` with an `'Unknown'`
   * sentinel written whenever the device snapshot had no mode — a value that
   * read as a measurement but was not one. Absent now means absent: no
   * snapshot, a mid-disconnect close, or a pre-v6 row that carried the
   * sentinel. Do NOT coalesce it back to `'Unknown'`; how a gap is rendered is
   * a display decision and belongs at the display boundary.
   */
  trainingMode?: TrainingModeName;
  /**
   * Header weight for the set, in pounds.
   *
   * OPTIONAL AS OF SCHEMA v6, for the same reason as {@link trainingMode}: the
   * old `NOT NULL` column defaulted to `0`, which is indistinguishable from a
   * genuine unloaded set. Pre-v6 rows storing `0` were migrated to absent, so
   * a gap on historical data means "sentinel or real zero, unknowable which"
   * rather than a certain gap.
   */
  weightLbs?: number;
  /**
   * Why this set was performed (VMCP-02.84). Stated at `set.start`; the
   * column backing it has admitted all four values since v6, so widening the
   * tool surface to write them needed no migration. Absent ⇒ `'working'`,
   * which keeps every pre-enum row and fixture behaving exactly as before.
   *
   * `selectWorkingSets` scores `'working'` only, so a probe or technique rung
   * is neither scored against the planned rep band nor discarded as a warm-up.
   */
  setPurpose?: SetPurpose;
  /**
   * DERIVED from {@link setPurpose} — `true` exactly when it is `'warmup'`,
   * never written independently (see `set-purpose.ts`, and the GENERATED
   * `sets.is_warmup` column it mirrors). Kept because the channel payloads,
   * the dashboard read-models and the failure harvest all read it.
   */
  isWarmup?: boolean;
  /**
   * Which server path opened this set, when no `set.start` call did (VW-180).
   * `'guided_load'` is the Phase 1g bootstrap's set; `'idle_rep'` is the
   * VW-164 auto-arm, opened because the lifter started working with a session
   * open and no set armed. Absent ⇒ an explicit `set.start`.
   *
   * Recorded because it changes how the row should be read: an auto-created
   * set carries whatever intent the server could infer, not what a coach
   * stated. Analytics that weight stated intent (warm-up filtering, planned
   * rep targets) can tell the two apart instead of assuming.
   */
  autoCreatedBy?: 'guided_load' | 'idle_rep';
  /**
   * The set was auto-created and then upgraded in place by a later
   * `set.start` (VW-180) — so its `isWarmup` / `exerciseId` DO carry stated
   * intent, unlike an auto-created set nobody claimed. Absent ⇒ never
   * upgraded.
   */
  upgraded?: boolean;
  /**
   * Who performed this set, when it was NOT the owner (VW-169). A short
   * free-text label ('Jordan'), not an identity: there is no per-lifter row,
   * profile or tier, and `userId` stays `LOCAL_USER_ID` on a guest's set.
   *
   * ABSENT MEANS THE OWNER. Every owner-scoped read (`getSetsForExercise`,
   * `listSessions`, the baseline recalc and the anchor harvest) filters
   * `lifter IS NULL` by default, so a guest working in never contributes to
   * the owner's baselines, anchors, progression or history. Nothing is
   * back-filled: a row written before v14 was the owner's.
   */
  lifter?: string;
  /**
   * GROUND TRUTH for per-unit identity. BLE device id of the unit that
   * performed the set, captured from the slot's connected client. The device
   * id is the stable physical identity and the only one of the three identity
   * columns that is safe to join on.
   *
   * Absent on pre-v5 rows and whenever the slot had no connected device id
   * (mock adapter, mid-disconnect close).
   */
  deviceId?: string;
  /**
   * Physical limb the set was performed with, RESOLVED AT WRITE TIME from the
   * persisted `deviceId → physicalSide` binding. This is what per-side
   * analytics reads — never `slot`.
   *
   * Resolved once, at write, and frozen: the binding is mutable (`slot.bind`
   * can be re-run) and slot assignment is mutable (`slot.swap`), so a side
   * derived on read would silently change the meaning of historical rows. The
   * value recorded here is what the binding said when the reps happened.
   *
   * Absent — never defaulted — whenever the side could not be resolved: pre-v5
   * rows, an unbound device, or a close with no connected device id. Historical
   * rows are permanently side-unknown because `deviceId` was discarded at write
   * time; inferring a side for them would manufacture data that looks real. A
   * gap is detectable downstream, a plausible wrong value is not.
   */
  side?: StoredSide;
  /**
   * DIAGNOSTIC ONLY — never a join key, never the durable side identity.
   *
   * Originating Voltra slot (`'primary'` for single-Voltra/bench, `'left'` /
   * `'right'` for a bilateral pair), mirroring the `meta.slot` stamp VW-48 put
   * on every channel event. Useful for debugging which position a set came
   * from at record time.
   *
   * A slot id names a POSITION AT A MOMENT IN TIME, not a device or a limb:
   * `slot.swap` exchanges clients between slot keys, so the same slot id can
   * refer to a different physical unit before and after a swap. Grouping an
   * L/R series by `slot` therefore flips sign across a swap with nothing
   * erroring. Join on `deviceId`; read sidedness from `side`.
   *
   * Optional because every row written before schema v5 has no slot recorded
   * (the column reads back absent). Every write through `finalizeSet`
   * populates it.
   */
  slot?: string;

  // ── v7 capture (Wave 1) ────────────────────────────────────────────────
  // Everything below was observable at set close and discarded. None of it is
  // recoverable after the fact, which is why the columns exist before every
  // writer does.

  /** Owning user. `'local'` under the single-user model. */
  userId?: string;
  /**
   * Exercise this set was performed for, stamped from the active session at
   * close. Set-level rather than session-level because a session is routinely
   * multi-exercise, and per-exercise analysis has no key without it.
   */
  exerciseId?: string;
  /**
   * Inferred physical configuration — bench height, attachment, stance (VW-119).
   * Distinct from the settings context below, which is readable device config.
   *
   * NOT written by `putSet`. It is stamped by `stampSetSetup` after the set is
   * persisted, from the ROM clustering in `store/exercise-setups.ts`, so a
   * re-put of the same row (a force-end followed by an explicit re-end) leaves
   * the stamp alone rather than clearing it. Absent means the set has not been
   * clustered yet — never "the default setup".
   */
  setupId?: string;
  /** Ordinal within the owning session, 1-based, in start-time order. */
  setIndexInSession?: number;
  /**
   * ACHIEVED rest before this set, in seconds — measured from the previous
   * set's close on the same slot. Not the prescribed rest, which is a plan
   * value and lives on `planned_exercises`.
   *
   * Absent for the first set of a slot's run and across a server restart: the
   * previous close time is in-memory, and a gap is the honest answer.
   */
  restBeforeSec?: number;
  /** Battery percentage reported by the unit at close. */
  batteryPct?: number;
  /**
   * Provenance of the row. `VOLTRA_ADAPTER=mock` writes into the same store as
   * real hardware, so without this any corpus fit silently ingests synthetic
   * sets. `'imported'` is reserved for a future import path.
   */
  source?: 'local' | 'imported' | 'mock';
  /**
   * Scale of `WorkoutSample.position` on this set's reps. A MARKER, not a
   * conversion: it records which scale the samples are already in so existing
   * rows stay interpretable when the bridge conversion lands, rather than
   * being silently rescaled.
   *
   * Read through `normalisePositionsToMetres` rather than branching on this
   * field at each call site (VW-203), exactly as {@link velocityUnits} is read
   * through `normaliseVelocityToMps`. Absent reads as the current scale.
   */
  positionUnits?: 'device_native' | 'meters';
  /**
   * Scale of `WorkoutSample.velocity` on this set's reps (VW-160). The same
   * kind of MARKER as {@link positionUnits}, and for the same reason: rows
   * written before the bridge started converting carry device-native mm/s,
   * roughly 1000× the m/s the field is documented as, and rescaling them on
   * disk would destroy the evidence of which scale they were captured at.
   *
   * Read through `normaliseVelocityToMps` rather than branching on this field
   * at each call site. Absent means "never round-tripped through the store" —
   * the v10→v11 migration stamps every pre-existing row, and every write since
   * carries the current value — so an absent marker reads as current.
   */
  velocityUnits?: 'device_native' | 'meters_per_second';
  /**
   * Telemetry sample rate for this set, in Hz, MEASURED from the sample
   * timestamps rather than assumed. There is no configured rate to read: the
   * rate is emergent from the device stream. Recording it now means a later
   * rate change splits the corpus cleanly instead of blending two resolutions
   * into one untellable mix.
   */
  sampleRateHz?: number;
  /**
   * Device rep count as the firmware reported it, VERBATIM. Canonical for
   * counting — never reconciled against the derived rep array length, and
   * never `max()`'d with it. The device counts; we only enrich.
   */
  firmwareRepCount?: number;
  /**
   * The duration field carried on the device's set-summary frame, in ms.
   *
   * NAMED FOR ITS PROVENANCE, NOT ITS MEANING. The SDK types this field as
   * "duration of the final rep"; archived captures refute that — the value
   * scales with rep count (an 11-rep set reports ~11 s while its final rep took
   * ~1.4 s), so it is a SET-level aggregate. It is most consistent with
   * cumulative concentric time / time-under-tension, but the cross-mode fit
   * spans 0.45–1.24× against BLE-timestamped spans, which is not tight enough
   * to name it that.
   *
   * Do NOT read it as wall-clock set duration, and do NOT read it as a per-rep
   * figure, until an instrumented set pins the semantics. Stored because it is
   * firmware ground truth we would otherwise discard; interpreted only once we
   * know what it is.
   */
  firmwareSummaryDurationMs?: number;
  /**
   * Peak force over the set as the firmware reported it, in POUNDS (the frame
   * carries tenths; the /10 is applied on the way in).
   *
   * Corroborated across nine archived capture sessions — it reads at or just
   * above the set's target weight in every weight-mode capture and takes
   * untargeted values in band / damper / isokinetic — but NOT vendor-confirmed.
   * Stored for cross-checking; do NOT substitute it for the peak force
   * workout-analytics computes from telemetry.
   */
  firmwarePeakForceLbs?: number;
  /**
   * Peak power over the set as the firmware reported it, RAW and in the
   * device's own scale.
   *
   * UNITS UNVERIFIED. The value scales with rep speed the way power should,
   * but its magnitude has never been checked against an instrumented
   * reference, so it may be watts, centiwatts or another scaling. Treat it as
   * a relative quantity and never label or convert it as watts until a bench
   * measurement pins the unit.
   */
  firmwarePeakPower?: number;
  /** Per-rep firmware boundaries as JSON, for cross-checking segmentation. */
  firmwareRepsJson?: string;
  /**
   * Groups the two sides of one bilateral effort. Present only when the live
   * path actually paired them (`groupSource: 'live'`); never inferred, because
   * a heuristic pairing lacks the opposite-slot guard the live path has and
   * would create pairs the live path could not.
   */
  bilateralGroupId?: string;
  /** How `bilateralGroupId` was established. Always `'live'` on new writes. */
  groupSource?: 'live' | 'inferred';

  // ── Device settings context (an observation of readable config) ────────
  // Distinct from `setupId`, which is inferred physical configuration. A
  // chains set and a constant-load set are indistinguishable without these.

  /** User's chains setting in lbs, from the settings-update echo. */
  chainsLbs?: number;
  /** Damper resistance level (0-9). */
  damperLevel?: number;
  /** Eccentric overload percentage. */
  eccentricPct?: number;
  /**
   * User's inverse-chains setting in lbs, from the settings-update echo.
   * A MAGNITUDE, NOT A FLAG: the device takes `setInverseChains(lbs)` over
   * 0-100. Mechanically the opposite of `chainsLbs` — inverse chains shed
   * resistance through the concentric and add it through the eccentric.
   */
  inverseChainsLbs?: number;
  /** Assist-mode raw value. */
  assistMode?: string;
  /** Long tail of settings (isokinetic params, band max force) as JSON. */
  settingsJson?: string;
  /**
   * Versioned hash over the whole settings context, `'v1:<hash>'`. The version
   * prefix is load-bearing: without it, adding a tenth settings dimension makes
   * old hashes compare equal to new ones and the mismatch is undetectable.
   */
  settingsHash?: string;

  reps: StoredRep[];
}

/**
 * A rep performed while NO set was armed — between sets, during a warm-up, or
 * while testing a weight on the way to a working load. Real work the user did,
 * which until schema v7 was detected, surfaced live, and then discarded, so
 * recorded volume under-counted by an unknown amount.
 *
 * Written AT DETECTION, never flushed from the live ring buffer
 * (`LiveState.idleReps`): that ring is capped at 20 entries, in-memory, and
 * reset by `session.start`, so a deferred flush loses everything past the cap
 * and everything before a crash. A rep not persisted at the moment it happened
 * is unrecoverable.
 *
 * Every field but `id` and `observedAt` is optional because an idle rep is
 * observed with whatever context happens to exist at that instant — which is
 * routinely less than a set close has. Absent means absent throughout; nothing
 * here is coalesced to a sentinel.
 */
export interface StoredIdleRep {
  id: string;
  /** Owning user. `'local'` under the single-user model. */
  userId?: string;
  /**
   * Session the rep landed inside, when one was active.
   *
   * GENUINELY ABSENT in the normal case: a user can walk up and pull the handle
   * with no session started at all, and that rep is exactly as real as one
   * pulled mid-session. The column is nullable for that reason — never invent a
   * session id to fill it, and never drop the row for want of one.
   */
  sessionId?: string;
  /**
   * BLE device id of the unit that recorded the rep — the stable physical
   * identity and the only one of the three identity fields safe to join on.
   * Absent when the slot had no connected device id (mock adapter, a rep
   * detected mid-disconnect).
   */
  deviceId?: string;
  /**
   * DIAGNOSTIC ONLY — never a join key, never the durable side identity. A slot
   * id names a POSITION AT A MOMENT IN TIME: `slot.swap` reassigns it, so the
   * same id can mean a different physical unit before and after. Join on
   * {@link deviceId}; read sidedness from {@link side}.
   */
  slot?: string;
  /**
   * Physical limb, RESOLVED AT WRITE TIME from the `deviceId → physicalSide`
   * binding, exactly as `StoredSet.side` is. Frozen at write because the
   * binding is mutable: a side derived on read would silently rewrite the
   * meaning of historical rows.
   *
   * Absent — never defaulted — when the device is unbound or there is no
   * connected device id. A gap is detectable downstream; a plausible wrong limb
   * is not.
   */
  side?: StoredSide;
  /** ISO-8601 wall-clock instant the rep boundary was detected. */
  observedAt: string;
  /**
   * Header weight on the device when the rep happened, in pounds. Absent when
   * the device snapshot carries no weight — NOT `0`, which is indistinguishable
   * from a genuine unloaded pull and is the sentinel class schema v6/v7
   * deliberately removed.
   */
  weightLbs?: number;
  /**
   * The full analytics `Rep`, stored as JSON in the `payload` column with the
   * same non-finite coercion `putSet` applies to a set's reps. Keeping the
   * whole rep rather than a velocity/ROM summary is the point: the live channel
   * summary is a coaching surface, and a summarised row could never be
   * re-analysed the way set reps can.
   *
   * Absent when the column is NULL or holds JSON that no longer parses — a
   * corrupt payload reads back as no payload rather than as a bogus rep.
   */
  rep?: Rep;
}

/**
 * One isometric trial as measured (VMCP-04.11). Mirrors `TrialAnalysis` in
 * `state/isometric-protocol.ts` field-for-field so a stored trial can be fed
 * straight back into `aggregateSide` without translation.
 *
 * This is the durable unit of an isometric assessment: the per-trial numbers
 * are persisted, and every side/pair-level statistic (mean plateau of the best
 * 2 valid trials, CV, inferred working weight, asymmetry %, the ≥10 / ≥15
 * flags) is RECOMPUTED on read from these rows. Persist observations, compute
 * conclusions — a stored asymmetry verdict would go stale the moment the
 * thresholds move, and there is no way to tell a stale one from a fresh one.
 */
export interface StoredIsometricTrial {
  /** Row identity. Trials have no natural key; the writer generates a UUID. */
  id: string;
  /** 1-indexed trial number within the side, as run. */
  index: number;
  peakForceLbs: number;
  plateauForceLbs: number;
  plateauStartMs: number;
  plateauEndMs: number;
  /** Whether the trial passed the protocol's validity gates at analysis time. */
  valid: boolean;
  /** Set when `valid === false`; names the gate that failed. */
  invalidReason?: string;
}

/**
 * The trials one limb contributed to an isometric measurement, plus the
 * identity of the unit that recorded them.
 *
 * Identity follows the schema-v5 rules on `sets` exactly (see `StoredSet`):
 *
 *   deviceId  GROUND TRUTH. The only join key. Absent under the mock adapter
 *             or when the slot has no connected device id.
 *   side      The limb, as declared for this assessment. What analytics reads.
 *   slot      DIAGNOSTIC ONLY. `slot.swap` reassigns slot ids between units, so
 *             a slot id names a position at a moment in time — never join on it.
 */
export interface StoredIsometricSideMeasurement {
  /** Absent — never defaulted — when the side could not be established. */
  side?: StoredSide;
  /** Absent when the slot had no connected device id at measurement time. */
  deviceId?: string;
  /** Diagnostic only. Never a join key. */
  slot?: string;
  trials: StoredIsometricTrial[];
}

/**
 * A completed isometric assessment (VMCP-04.11). `isometric.measure_imbalance`
 * writes one row per run with both limbs' trials; the shape is a `sides` array
 * rather than left/right columns so a single-side `measure_max` run can be
 * persisted through the same table later without a schema change.
 *
 * `analysisVersion` is the algorithm-version guard required of any persisted
 * derived value: the per-trial peak/plateau/valid numbers come out of
 * `analyzeTrial`, so a change to the plateau window or the validity gates
 * changes what an identical hold would record. Bump it there and old rows stay
 * identifiable instead of being silently compared against new ones.
 */
export interface StoredIsometricMeasurement {
  id: string;
  /** ISO-8601 instant the assessment finished. */
  measuredAt: string;
  /** Version of the trial-analysis algorithm that produced these numbers. */
  analysisVersion: number;
  /**
   * Which limb was tested first. A protocol fact, not a conclusion: within-
   * session fatigue biases the second side, so any cross-side comparison needs
   * to know the order it was collected in.
   */
  firstSideTested?: StoredSide;
  /** Hold duration per trial, in ms, as configured for this run. */
  durationMs: number;
  /** Trials requested per side. The trials actually recorded are in `sides`. */
  trialsRequested: number;
  /** Rest between trials on the same side, in ms. */
  restMs: number;
  /** Rest between sides, in ms. Absent for a single-side measurement. */
  betweenSidesRestMs?: number;
  sides: StoredIsometricSideMeasurement[];
}

/**
 * A persisted session row. `endedAt` is undefined while the session is still
 * active and is filled in once `session.end` runs.
 */
export interface StoredSession {
  id: string;
  startedAt: string;
  endedAt?: string;
  exerciseId?: string;
  exerciseName?: string;
  notes?: string;
  /**
   * The session's DEFAULT lifter label (VW-169) — the guest a whole session
   * was run for. Sets started on this session inherit it unless `set.start`
   * overrides them. Absent means the owner; see {@link StoredSet.lifter}.
   */
  lifter?: string;
  /**
   * The DENORMALISED observed diet phase (VW-150), stamped by `putSession`
   * from the range covering `startedAt`. It is the cheap filter column, NOT
   * the answer: `diet_phases` is the source of truth and is retroactively
   * correctable, so a stored session can hold a phase the table has since
   * moved. Read {@link SessionStore.getSessionDietPhase} for the resolved
   * value; this member is what the row literally says.
   */
  dietPhase?: string;
}

/**
 * One row of `diet_phases` — the ACTUAL (observed) phase over a time range
 * (VW-149 / VW-150). `endedAt` absent means the range is still open.
 */
export interface StoredDietPhase {
  id: string;
  userId: string;
  phase: string;
  startedAt: string;
  endedAt?: string;
  declaredAt: string;
}

/** Arguments to {@link SessionStore.declareDietPhase}. */
export interface DeclareDietPhaseInput {
  userId: string;
  phase: string;
  /** When the phase began. May be in the past — that is the correction path. */
  startedAt: string;
  declaredAt: string;
}

/**
 * Filter parameters for `listSessions`. `sort` defaults to `'startedAt:desc'`
 * and `limit` defaults to `50` at the implementation layer.
 */
export interface SessionListFilter {
  from?: string;
  to?: string;
  exerciseId?: string;
  sort?: 'startedAt:desc' | 'startedAt:asc';
  limit?: number;
  offset?: number;
  /**
   * Whose sessions to list (VW-169). ABSENT MEANS THE OWNER'S — the query
   * filters `lifter IS NULL` — so a guest's session never shows up in the
   * owner's history unless it is asked for by label.
   */
  lifter?: string;
}

/**
 * Filter parameters for `countSessions`. Mirrors {@link SessionListFilter}'s
 * predicate half plus the user dimension; the pagination and ordering members
 * (`sort` / `limit` / `offset`) are deliberately IGNORED by the count, because
 * the count of a page is not a count.
 */
export type SessionCountFilter = SessionListFilter & {
  userId?: string;
  /**
   * Restrict to sessions that have actually finished (`ended_at IS NOT
   * NULL`). Added for the tier-signal MVP (VW-92), whose `sessionsLogged`
   * count is explicitly defined over completed sessions only — an
   * in-progress session should not count toward graduation evidence.
   */
  endedOnly?: boolean;
};

/**
 * The earliest and latest `started_at` among sessions matching `filter`
 * (same predicates as {@link SessionCountFilter}, pagination fields ignored
 * for the same reason `countSessions` ignores them). Both `null` when no
 * session matches.
 */
export interface SessionDateSpan {
  first: string | null;
  last: string | null;
}

/**
 * Why a set was performed. The four values the `sets.set_purpose` CHECK
 * constraint admits; `'warmup'` is the one `StoredSet.isWarmup` reflects (the
 * `is_warmup` column is GENERATED from this one, so the two cannot drift).
 */
export type SetPurpose = 'working' | 'warmup' | 'probe' | 'technique';

/** Filter parameters for `countSets`. */
export interface SetCountFilter {
  userId?: string;
  sessionId?: string;
  /**
   * Count bilateral GROUPS rather than rows. A two-armed lift is stored as two
   * rows sharing a `bilateral_group_id` — deliberately, since merging them
   * would force picking one of two firmware rep counts — so "how many sets did
   * I do?" has two legitimate answers and the caller picks which one it means.
   *
   * A NULL `bilateral_group_id` is NOT a group: every ungrouped row counts as
   * one on its own. Defaults to `false` (count rows).
   */
  collapseBilateral?: boolean;
}

/**
 * Filter parameters for `getSetsForExercise`. `userId` and `exerciseId` are
 * required because they are the key: a per-exercise history that spans users,
 * or one that has to scan every exercise to find one, is not the query.
 */
export interface ExerciseSetsFilter {
  userId: string;
  exerciseId: string;
  /** Inferred physical configuration (bench height, attachment, stance). */
  setupId?: string;
  /** Physical limb, as resolved at write time. Never `slot`. */
  side?: StoredSide;
  /** Versioned settings-context hash, `'v1:<hash>'`. */
  settingsHash?: string;
  /**
   * Purposes to include. An EMPTY array matches nothing — an empty filter list
   * that silently means "all" is how a caller ends up analysing warm-ups as
   * working sets without ever seeing an error.
   */
  purpose?: SetPurpose[];
  /**
   * Whose sets to read (VW-169). ABSENT MEANS THE OWNER'S — the query filters
   * `lifter IS NULL`. This is the default that keeps a guest's working set out
   * of the owner's baseline recalc, anchor reharvest and progression history
   * without every caller having to remember to exclude it.
   */
  lifter?: string;
  /** Inclusive lower bound on `startedAt`. */
  from?: string;
  /** Inclusive upper bound on `startedAt`. */
  to?: string;
  /** Absent means unbounded, matching `getSetsForSession`. */
  limit?: number;
}

/**
 * Stored telemetry snapshot for a single device read. Reserved for future
 * persistence of device-state samples; not used in Wave 1 transport flows but
 * declared here so the WA-04 alignment is type-checked end to end.
 */
export interface StoredDeviceTelemetry {
  recordedAt: string;
  deviceId: string;
  weightLbs?: number;
  trainingMode?: TrainingModeName;
  batteryPercent?: number;
}

/**
 * Mesocycle focus tag. Open-typed via the `string` member so callers can
 * persist freeform labels (e.g. `'volume-accumulation'`) when the canonical
 * tags aren't a fit.
 */
export type TrainingFocus = 'hypertrophy' | 'strength' | 'peaking' | 'deload' | string;

/** A multi-week training program (the top-level planning container). */
export interface StoredTrainingProgram {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  archivedAt?: string;
}

/** A mesocycle within a program (e.g. a 4-week hypertrophy block). */
export interface StoredTrainingBlock {
  id: string;
  programId: string;
  orderIndex: number;
  name: string;
  focus?: TrainingFocus;
  weeksCount: number;
  notes?: string;
}

/** A single week within a block. */
export interface StoredTrainingWeek {
  id: string;
  blockId: string;
  orderIndex: number;
  name?: string;
}

/** A planned workout within a week (e.g. "Upper A"). */
export interface StoredWorkoutTemplate {
  id: string;
  weekId: string;
  dayLabel?: string;
  name: string;
  notes?: string;
  orderIndex: number;
  /**
   * Stable key from the system that authored this row (`tc:workout:<id>` for a
   * TrueCoach import), UNIQUE where present. Absent on anything created
   * locally, which is what lets a re-import update in place without ever
   * touching a hand-built template.
   */
  externalId?: string;
}

/**
 * Coach-set tempo override on a planned exercise (VW-46), seconds per phase.
 * Canonical order at every MCP/store boundary is `[ecc, pauseBottom, con, pauseTop]`
 * (matching `@voltras/workout-analytics`' `getSetTempoSeconds`) — a NAMED object here
 * so a consumer can never silently transpose it the way a bare tuple could be.
 */
export interface StoredTargetTempo {
  ecc: number;
  pauseBottom: number;
  con: number;
  pauseTop: number;
}

/** A planned exercise within a workout template (sets/reps/weight prescription). */
export interface StoredPlannedExercise {
  id: string;
  workoutTemplateId: string;
  exerciseId: string;
  orderIndex: number;
  targetSets: number;
  targetRepsLow?: number;
  targetRepsHigh?: number;
  targetWeightLbs?: number;
  targetRpe?: number;
  restSec?: number;
  notes?: string;
  /** Coach-set tempo override; absent when the coach left it unset (VW-46). */
  targetTempo?: StoredTargetTempo;
  /** Stable authoring key (`tc:item:<id>`), UNIQUE where present. See `StoredWorkoutTemplate`. */
  externalId?: string;
}

/**
 * One template plus its exercises, as an importer hands them to the store.
 * `templateId` / `id` are absent for a row the importer has not seen before —
 * the store resolves an existing row by `externalId` and only mints a UUID
 * when there is none, which is what keeps a re-import idempotent.
 */
export interface PlanImportTemplate {
  externalId: string;
  weekId: string;
  dayLabel?: string;
  name: string;
  notes?: string;
  orderIndex: number;
  exercises: PlanImportExercise[];
}

export interface PlanImportExercise {
  externalId: string;
  exerciseId: string;
  orderIndex: number;
  targetSets: number;
  targetRepsLow?: number;
  targetRepsHigh?: number;
  targetWeightLbs?: number;
  restSec?: number;
  notes?: string;
  // No targetTempo here (VW-46): the TrueCoach parser is not a source of coach
  // tempo data yet, so an import never carries one.
}

/** Row counts per outcome. `unchanged` is a row whose stored values already matched. */
export interface PlanImportCounts {
  templates: number;
  exercises: number;
}

export interface PlanImportResult {
  imported: PlanImportCounts;
  updated: PlanImportCounts;
  unchanged: PlanImportCounts;
}

/** Links a completed session to a planned exercise / workout template. */
export interface StoredProgramAssignment {
  id: string;
  sessionId: string;
  plannedExerciseId?: string;
  workoutTemplateId?: string;
  assignedAt: string;
}

/**
 * A user's self-reported training background (I4 / VW-96 Wave 3). Storage
 * only — every field here is captured verbatim from what the user declared,
 * with zero derivation or tier-classification. That logic (the tier signal)
 * is a separate, already-scoped effort (VW-92) that reads this row; it does
 * not write it.
 */
/**
 * Willingness to be pushed hard, which RP keeps DISTINCT from both where the
 * lifter is now and where they want to end up (VMCP-06.04 / B39). It moves how
 * aggressively effort is prescribed; it never moves a set count.
 */
export type EffortTolerance = 'low' | 'moderate' | 'high';

/**
 * A self-reported injury or limitation (VW-148 / B42). Verbatim self-report:
 * nothing here is a diagnosis and nothing downstream interprets it clinically.
 */
export interface StoredInjury {
  area: string;
  kind: 'sharp_in_set' | 'lingering_joint' | 'other';
  note?: string;
  /** The hard gate. `true` means defer to a doctor; never interpreted further. */
  cardioLimitation?: boolean;
}

export interface StoredTrainingProfile {
  userId: string;
  /** 'beginner' | 'intermediate' | 'advanced', as declared by the user. */
  declaredTier?: string;
  declaredAt?: string;
  yearsTraining?: number;
  /** The rp-s10 consistency probe. */
  historyConsistent?: boolean;
  /** The rp-s4/s6 plateau probe. */
  everPlateaued?: boolean;
  reportedSetsPerMuscle?: number;
  goal?: string;
  goalSetAt?: string;
  daysAvailable?: number;
  daysReliable?: number;
  /** Where the lifter is NOW, free text. Never merged into `goal`. */
  currentBaseline?: string;
  effortTolerance?: EffortTolerance;
  /** Where the lifter wants to END UP, free text. Never merged into `goal`. */
  target?: string;
  /** Self-reported injuries/limitations (VW-148 / B42). Replaced wholesale. */
  injuries?: StoredInjury[];
  /** The named program `reportedSetsPerMuscle` came from (VW-148 / B36). */
  namedProgramHistory?: string;
  onboardedAt?: string;
  /** Per-field `{field: 'user'|'llm'|'default'}` — which answers the user
   * actually gave and which were assumed on their behalf. */
  provenance?: Record<string, 'user' | 'llm' | 'default'>;
  updatedAt: string;
}

/**
 * A persisted `exercise_setups` row — one inferred physical configuration
 * (bench height, attachment, stance) for one (user, exercise, side) (VW-119).
 *
 * INFERRED, NOT DECLARED. `label` is a neutral generated ordinal ("setup 1")
 * until a human names it through `exercise.confirm_setup`, which is also the
 * only writer of `confirmedAt`. Re-running the inference re-derives which sets
 * belong together and never overwrites either.
 *
 * There is no `side` column, deliberately: the side is one of the dimensions
 * `setupRowId` encodes, so the id IS the key and a row cannot disagree with it.
 */
export interface StoredExerciseSetup {
  /** `setupRowId(key, index)` from `store/exercise-setups.ts` — never hand-rolled. */
  id: string;
  userId: string;
  exerciseId: string;
  /** Generated ordinal, or the name a human confirmed. */
  label?: string;
  /** When this cluster was FIRST inferred, not when the job last ran. */
  detectedAt?: string;
  /** Set only by `exercise.confirm_setup`. Absent ⇒ nobody has vouched for the name. */
  confirmedAt?: string;
  /** Which rule set produced the cluster. A bump re-clusters; see SETUP_CLUSTER_VERSION. */
  clusterVersion?: string;
  /** No longer inferred (a version bump, or its sets moved). Never deleted — it is an FK parent. */
  retiredAt?: string;
}

/** Key for `listExerciseSetups`: the dimensions a setup row is filed under. */
export interface ExerciseSetupFilter {
  userId: string;
  exerciseId: string;
}

/**
 * The slice of the store the ROM-clustering job in `store/exercise-setups.ts`
 * needs. Split out so the job is testable against a fake without standing up
 * the whole {@link SessionStore}.
 */
export interface ExerciseSetupStore {
  getSetsForExercise(filter: ExerciseSetsFilter): Promise<StoredSet[]>;
  getExerciseSetup(id: string): Promise<StoredExerciseSetup | undefined>;
  /** Live rows only — a retired setup is history, not a clustering candidate. */
  listExerciseSetups(filter: ExerciseSetupFilter): Promise<StoredExerciseSetup[]>;
  putExerciseSetup(setup: StoredExerciseSetup): Promise<void>;
  stampSetSetup(setId: string, setupId: string | null): Promise<void>;
}

/**
 * Confidence tier of a per-(user, exercise, setup, side) baseline. See
 * `store/exercise-baselines.ts` for the thresholds each transition needs.
 *
 * The tier describes HOW MUCH and HOW CONSISTENT the observation history is —
 * never the baseline's numbers, which are recomputed from stored reps on every
 * read.
 */
export type BaselineState = 'COLD' | 'SHAPE_ONLY' | 'PROVISIONAL' | 'CALIBRATED' | 'STALE';

/**
 * A persisted `exercise_baselines` row (I5 / B56).
 *
 * STATE ONLY. There is deliberately no `romBaselineM` / `tempoBaselineMs` /
 * `referenceVelocityMps` here: those are computed fresh from stored reps,
 * because a value persisted from a formula that later changes becomes a silent
 * lie (data-layer-migration-plan.md §2 C2). What this row carries is history
 * about our own confidence, which no amount of rep data reproduces.
 *
 * `setupId` is absent unless the caller asked for a setup-keyed row. A baseline
 * with no setup pools every set for the key, which is what "the one default
 * setup for this exercise" means and what every row written before VW-119
 * shipped is.
 */
export interface StoredExerciseBaseline {
  /** `baselineKeyId(key)` from `@voltras/workout-analytics` — never a hand-rolled id. */
  id: string;
  userId: string;
  exerciseId: string;
  /** Inferred physical configuration. Absent ⇒ the pooled, setup-agnostic row. */
  setupId?: string;
  /** Absent means the side-agnostic view, not "unknown side". */
  side?: StoredSide;
  state: BaselineState;
  /** Coarse 0–1 ordering scalar. Not a probability; do not do arithmetic with it. */
  confidence?: number;
  /** DISTINCT sessions contributing qualifying sets, not the set count. */
  observedSessions: number;
  /** Failure anchors backing this baseline. */
  anchorCount: number;
  /** Coefficient of variation of anchor terminal velocity; absent below two anchors. */
  anchorSpread?: number;
  /**
   * When the most recent counting anchor was observed. Absent when the key has
   * none. Answers "how long since we last saw this user fail here", which
   * `anchorCount` alone cannot: three anchors from last spring and three from
   * last week are the same count and different evidence.
   */
  lastAnchorAt?: string;
  firstObservedAt?: string;
  updatedAt: string;
  invalidatedAt?: string;
  invalidationReason?: string;
  /** Which rule set produced `state`. A row is only interpretable against it. */
  algorithmVersion: string;
}

/**
 * A persisted `failure_anchors` row (B59 / VW-174) — one set the harvest
 * filter examined and found to be a candidate.
 *
 * HARVESTED, NEVER PRESCRIBED. `source: 'harvested'` is the only value any
 * writer produces today: the product does not ask anyone to train to failure,
 * it labels a failure that already happened. `'prescribed'` exists in the
 * schema for an opt-in probe that has not been built and may never be.
 *
 * ABORTS ARE STORED TOO, and are what makes the hazard filter auditable: a set
 * cut short by pain looks exactly like a failure to a naive stall test, so it
 * is recorded with `filterVerdict: 'abort'` and its inputs, and never counted.
 * Sets that were never candidates at all (warm-ups, short sets) are not
 * written — a row per closed set would be noise, not history.
 */
export interface StoredFailureAnchor {
  id: string;
  userId: string;
  /** The set this verdict is about. */
  setId: string;
  exerciseId: string;
  /**
   * Inferred physical configuration. STILL ALWAYS ABSENT, even now that
   * `exercise_setups` has a writer (VW-119): stamping a setup here and then
   * filtering `selectAnchors` by it would silently drop every anchor harvested
   * before clustering shipped, demoting CALIBRATED baselines to SHAPE_ONLY.
   * Anchors stay pooled across an exercise's setups until that back-fill is a
   * task of its own.
   */
  setupId?: string;
  side?: StoredSide;
  /**
   * The lifter label of the set this anchor came from (VW-169). Absent means
   * the owner, and `selectAnchors` reads owner anchors only — so a guest's
   * stall can never move the owner's baseline even if a later reharvest pass
   * writes one.
   */
  lifter?: string;
  observedAt: string;
  source: 'harvested' | 'prescribed';
  /** Final-rep concentric mean velocity, m/s. Only anchors that carry one contribute spread. */
  terminalVelocityMps?: number;
  loadLbs?: number;
  repCount?: number;
  /** Recorded so the selection bias in harvested anchors can be corrected later. */
  setIndexInSession?: number;
  /** Seconds from session start to this set's start; same purpose as the index. */
  sessionPositionSec?: number;
  /** The measurements behind the verdict, so a later filter version can re-score it. */
  filterInputs: Record<string, unknown>;
  filterVerdict: 'failure' | 'abort' | 'not_candidate';
  /** Which filter produced `filterVerdict`, thresholds included. */
  filterVersion: string;
  selfReportedRir?: number;
}

/** Verdict tally from a reharvest pass over one key's sets. */
export interface FailureHarvestCounts {
  failure: number;
  abort: number;
  notCandidate: number;
}

/**
 * Persistence boundary for VMCP. The SQLite implementation in
 * `src/store/sqlite-store.ts` opens a `node:sqlite` database; consumers depend
 * only on this interface.
 */
export interface SessionStore extends ExerciseSetupStore {
  /**
   * Upsert via `ON CONFLICT(id) DO UPDATE` (see the SqliteSessionStore
   * implementation). Called twice per session — once at `session.start`
   * (no `endedAt`), once at `session.end` (with `endedAt`) — so the second
   * call MUST update the existing row in place; a naive `INSERT` fails on it.
   *
   * DO NOT implement this as `INSERT OR REPLACE`. `sessions` is a foreign-key
   * cascade parent: `program_assignments.session_id REFERENCES sessions(id)
   * ON DELETE CASCADE`. `INSERT OR REPLACE` deletes the conflicting row before
   * re-inserting, and that delete cascades — every `session.end` re-put would
   * wipe the session's `program_assignment` links (the data-loss regression
   * fixed in #79). Update the row in place instead.
   */
  putSession(s: StoredSession): Promise<void>;

  /**
   * Persist a completed (or partial) set together with its rep array.
   *
   * Same `INSERT OR REPLACE` prohibition as `putSession`: the set row is
   * re-put on retry paths (force-end on disconnect followed by an explicit
   * re-end), and a delete-then-insert would take the set's `reps` with it on
   * any schema where that edge is declared. Upsert in place.
   */
  putSet(s: StoredSet): Promise<void>;

  /** Look up a session by id; returns `undefined` when no row matches. */
  getSession(id: string): Promise<StoredSession | undefined>;

  /**
   * Look up a set by id; returns `undefined` when no row matches. Required by
   * set-level metrics pipelines (`vbt.set`, `quality.rep`, `fatigue.set`)
   * which receive a bare `setId` with no surrounding `sessionId`.
   */
  getSet(id: string): Promise<StoredSet | undefined>;

  /** Filtered/paginated session listing. */
  listSessions(filter: SessionListFilter): Promise<StoredSession[]>;

  /**
   * Number of sessions matching `filter`. Same predicates as `listSessions`
   * plus `userId`, and it counts the whole match rather than a page — asking
   * "how many sessions have I recorded" through `listSessions` means listing
   * every row and counting them in JS, which is both wasteful and silently
   * wrong the moment the default limit clips the result.
   */
  countSessions(filter?: SessionCountFilter): Promise<number>;

  /**
   * Earliest and latest `started_at` among sessions matching `filter`. Added
   * for the tier-signal MVP (VW-92), which needs the calendar span a user's
   * logged sessions cover without pulling every row into memory just to take
   * `Math.min`/`Math.max` in JS.
   */
  getSessionDateSpan(filter?: SessionCountFilter): Promise<SessionDateSpan>;

  /** Return every set persisted for the given session, oldest-first. */
  getSetsForSession(sessionId: string): Promise<StoredSet[]>;

  /**
   * Number of sets matching `filter`, optionally collapsing bilateral pairs
   * into one — see {@link SetCountFilter.collapseBilateral}.
   */
  countSets(filter: SetCountFilter): Promise<number>;

  /**
   * Every set a user performed for one exercise, oldest-first (ascending on
   * `startedAt`, matching `getSetsForSession`), reps loaded.
   *
   * The per-exercise query had no key until schema v7 put `exercise_id` on the
   * set row: before that, "show me my last ten bench sets" could only be
   * answered by walking sessions and hoping each held one exercise. Every
   * optional member narrows further and they COMPOSE (AND).
   *
   * Filters on `side`, never `slot`: a slot id names a position at a moment in
   * time and `slot.swap` reassigns it, so a per-side series keyed on slot flips
   * sign across a swap with nothing erroring.
   */
  getSetsForExercise(filter: ExerciseSetsFilter): Promise<StoredSet[]>;

  /**
   * The session id of the MOST RECENT set a user performed for one
   * exercise, or `null` if none exists (VMCP-01.72b S5). A narrow,
   * SQL-level `ORDER BY started_at DESC LIMIT 1` — deliberately its own
   * method rather than a `sort`/`limit` option on `getSetsForExercise`
   * (which stays ascending-only, matching `getSetsForSession`), and
   * deliberately NOT built on `getSetsForExercise` at all: that method
   * hydrates every rep of every matching set, which is the wrong shape for
   * "I only need the session id of the last one" — `resolveBasisSession`
   * used to pull a user's ENTIRE set history for an exercise, reps
   * included, just to read `.at(-1)?.sessionId`.
   */
  getMostRecentSessionIdForExercise(filter: {
    userId: string;
    exerciseId: string;
  }): Promise<string | null>;

  // --- Idle reps (v7 schema) ---

  /**
   * Persist one rep performed outside any armed set.
   *
   * Called from the per-frame detection path, which is synchronous and runs at
   * telemetry rate: callers MUST NOT await this on the hot path, and a
   * rejection must be caught and logged rather than allowed to disturb live
   * telemetry. Idle-rep capture is additive — the channel events and the live
   * ring buffer behave identically whether or not this write succeeds.
   *
   * Same `INSERT OR REPLACE` prohibition as `putSession` / `putSet`: `idle_reps`
   * hangs off `users` (`ON DELETE CASCADE`) and `sessions` (`ON DELETE SET
   * NULL`), and a delete-then-insert is the wrong primitive for a table whose
   * whole purpose is not losing recorded work (#79). Upsert in place.
   */
  putIdleRep(rep: StoredIdleRep): Promise<void>;

  /**
   * List idle reps, oldest-first, filtered by session and/or `observedAt`
   * window. A `sessionId` filter matches only reps recorded inside that
   * session; reps observed with no session (a normal case — see
   * {@link StoredIdleRep.sessionId}) are reachable only through an unfiltered
   * or time-windowed query.
   */
  listIdleReps(filter: {
    sessionId?: string;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<StoredIdleRep[]>;

  // --- Isometric assessments (v6 schema) ---

  /**
   * Persist a completed isometric assessment together with every trial both
   * limbs contributed.
   *
   * Same `INSERT OR REPLACE` prohibition as `putSession` / `putSet`:
   * `isometric_measurements` is the FK parent of `isometric_trials` with
   * `ON DELETE CASCADE`, so a delete-then-insert on a re-put would take the
   * trials with it (#79). Upsert the parent in place.
   */
  putIsometricMeasurement(m: StoredIsometricMeasurement): Promise<void>;

  /** Look up an isometric measurement by id; `undefined` when no row matches. */
  getIsometricMeasurement(id: string): Promise<StoredIsometricMeasurement | undefined>;

  /**
   * Return every isometric measurement in which `deviceId` recorded trials,
   * most recent first. Keyed on the device id because that is the only stable
   * identity: `side` is resolved per-run and `slot` is a position, not a unit.
   * Each returned measurement carries all of its sides, not just the matched
   * one, so the caller can compute the asymmetry for that run.
   */
  getIsometricMeasurementsForDevice(
    deviceId: string,
    opts?: { limit?: number },
  ): Promise<StoredIsometricMeasurement[]>;

  // --- Block-periodization planning (v3 schema) ---

  /** Upsert a training program (top-level planning container). */
  putTrainingProgram(p: StoredTrainingProgram): Promise<void>;
  /** Look up a training program by id. */
  getTrainingProgram(id: string): Promise<StoredTrainingProgram | undefined>;
  /** List training programs; archived rows are excluded by default. */
  listTrainingPrograms(opts?: { includeArchived?: boolean }): Promise<StoredTrainingProgram[]>;

  /** Upsert a block (mesocycle) within a program. */
  putTrainingBlock(b: StoredTrainingBlock): Promise<void>;
  /**
   * Look up a block by id. One of the three by-id getters that make the
   * planning tree walkable UPWARD (set → planned exercise → template → week →
   * block → program); without them the only way from a leaf back to its
   * ancestors is to enumerate every program and scan.
   */
  getTrainingBlock(id: string): Promise<StoredTrainingBlock | undefined>;
  /** Return every block in a program, ordered by `orderIndex` ascending. */
  getTrainingBlocksForProgram(programId: string): Promise<StoredTrainingBlock[]>;

  /** Upsert a week within a block. */
  putTrainingWeek(w: StoredTrainingWeek): Promise<void>;
  /** Look up a week by id; `undefined` when no row matches. */
  getTrainingWeek(id: string): Promise<StoredTrainingWeek | undefined>;
  /** Return every week in a block, ordered by `orderIndex` ascending. */
  getTrainingWeeksForBlock(blockId: string): Promise<StoredTrainingWeek[]>;

  /** Upsert a workout template within a week. */
  putWorkoutTemplate(t: StoredWorkoutTemplate): Promise<void>;
  /** Look up a workout template by id. */
  getWorkoutTemplate(id: string): Promise<StoredWorkoutTemplate | undefined>;
  /** Return every template in a week, ordered by `orderIndex` ascending. */
  getWorkoutTemplatesForWeek(weekId: string): Promise<StoredWorkoutTemplate[]>;

  /** Upsert a planned exercise within a workout template. */
  putPlannedExercise(e: StoredPlannedExercise): Promise<void>;
  /** Look up a planned exercise by id; `undefined` when no row matches. */
  getPlannedExercise(id: string): Promise<StoredPlannedExercise | undefined>;
  /** Return every planned exercise in a template, ordered by `orderIndex` ascending. */
  getPlannedExercisesForTemplate(templateId: string): Promise<StoredPlannedExercise[]>;

  /** Fetch a planning row by its authoring key, or `undefined` when nothing carries it. */
  getWorkoutTemplateByExternalId(externalId: string): Promise<StoredWorkoutTemplate | undefined>;

  getPlannedExerciseByExternalId(externalId: string): Promise<StoredPlannedExercise | undefined>;

  /**
   * Upsert a batch of externally-authored templates and their exercises in ONE
   * transaction, keyed by `externalId`. All-or-nothing: a partially-written
   * plan tree is worse than no plan tree, because the model would read it as
   * the coach's complete prescription.
   */
  importPlanTree(templates: readonly PlanImportTemplate[]): Promise<PlanImportResult>;
  /**
   * Remove one planned exercise. Resolves `true` when a row was removed and
   * `false` when no row matched, so a caller can 404 rather than report a
   * delete that deleted nothing.
   *
   * `program_assignments.planned_exercise_id` is `ON DELETE SET NULL`, so the
   * record of what was actually trained survives the plan row being pulled —
   * unplanning a lift never rewrites a past session (VW-121).
   */
  deletePlannedExercise(id: string): Promise<boolean>;

  /** Upsert a session-to-plan link. */
  putProgramAssignment(a: StoredProgramAssignment): Promise<void>;
  /** Return every assignment that links to a given session. */
  getAssignmentsForSession(sessionId: string): Promise<StoredProgramAssignment[]>;
  /**
   * Return every assignment that points at a given workout template (across
   * any session). Used by `plan.next_workout` to detect which templates have
   * already been completed in a program walk.
   */
  getAssignmentsForTemplate(templateId: string): Promise<StoredProgramAssignment[]>;

  // --- Training profile (I4 / VW-96 Wave 3) ---

  /** Upsert a user's self-reported training background. */
  putTrainingProfile(p: StoredTrainingProfile): Promise<void>;
  /** Look up a user's training background; `undefined` when no row exists. */
  getTrainingProfile(userId: string): Promise<StoredTrainingProfile | undefined>;

  // --- Observed diet phase (VW-149 / VW-150) ---

  /**
   * Declare the observed phase running from `startedAt`, and leave the user's
   * timeline with EXACTLY ONE range covering any given instant.
   *
   * Atomic, because a partial application is a timeline that lies. In one
   * transaction it truncates the range that was open across `startedAt` to end
   * there, drops any range that started at or after `startedAt` (the new open
   * range covers all of it, and two covering ranges is the state this method
   * exists to make impossible), and inserts the new one.
   *
   * `startedAt` in the past is the RETROACTIVE CORRECTION path the
   * `diet_phases` DDL comment calls for, not an error. It rewrites the
   * timeline from that instant forward.
   *
   * Writes nothing to `training_weeks.phase_type`: that is the PRESCRIBED
   * phase and a different claim entirely.
   */
  declareDietPhase(input: DeclareDietPhaseInput): Promise<StoredDietPhase>;

  /** Every declared range for a user, oldest-first. */
  listDietPhases(userId: string): Promise<StoredDietPhase[]>;

  /**
   * The single range covering every instant in `[from, to]`, or `undefined`
   * when none does. A window straddling two phases has NO covering range and
   * gets `undefined` — "half fat-loss" is not a phase. Pass `from === to` for
   * a point lookup.
   */
  getDietPhaseCovering(
    userId: string,
    from: string,
    to: string,
  ): Promise<StoredDietPhase | undefined>;

  /**
   * The observed phase for one session, or `undefined` when none is known.
   *
   * THE TABLE WINS. A range covering the session's `startedAt` answers this
   * even when `sessions.diet_phase` disagrees, because the table is the
   * retroactively-correctable source of truth and the column is a stamp taken
   * at write. The column is the fallback for a session whose covering range no
   * longer exists.
   *
   * A guest lifter's session (VW-169) always answers `undefined`: the owner's
   * declared phase is a claim about the OWNER's eating, and stamping it on
   * somebody else's set would fabricate data about a person who never
   * declared anything.
   */
  getSessionDietPhase(sessionId: string): Promise<string | undefined>;

  // --- Exercise baselines (I5 / B56, VW-116) ---

  /**
   * Read the persisted baseline STATE for one key; `undefined` when the key
   * has never been recalculated. Never returns baseline values — those are
   * derived from stored reps by the analytics layer, on demand.
   *
   * `key.setupId`, when present, must name a setup row that exists — the ids
   * are generated by the ROM clustering (VW-119), so a caller inventing one is
   * working from a wrong mental model and would silently get a row that means
   * something else. Absent ⇒ the pooled, setup-agnostic baseline.
   */
  getBaseline(key: BaselineKey): Promise<StoredExerciseBaseline | undefined>;

  /**
   * Recompute the baseline state for one key from stored reps and failure
   * anchors, then upsert it (`ON CONFLICT DO UPDATE`, never `INSERT OR
   * REPLACE` — see `putSession`).
   *
   * Idempotent and cheap enough to run on every set close: it reads, derives,
   * and writes one row. The returned row is the freshly-written one.
   */
  recalcBaseline(key: BaselineKey): Promise<StoredExerciseBaseline>;

  // --- Failure anchors (B59 / VW-174) ---

  /**
   * Upsert one anchor row, keyed on `(setId, filterVersion)`: re-evaluating a
   * set under the SAME filter version rewrites its verdict in place, while a
   * new filter version adds a row beside the old one so a threshold change is
   * re-scorable against history rather than destructive of it.
   *
   * `ON CONFLICT DO UPDATE`, never `INSERT OR REPLACE` — see `putSession`.
   */
  putFailureAnchor(anchor: StoredFailureAnchor): Promise<void>;

  /**
   * Run the harvest filter over one closed set and persist the verdict when
   * the set was a candidate. Returns the verdict either way; `'not_candidate'`
   * writes nothing.
   *
   * Retrospective by construction: it reads reps that were recorded anyway and
   * never asks for a set to be taken anywhere.
   */
  harvestFailureAnchor(set: StoredSet): Promise<FailureVerdict>;

  /**
   * Re-run the harvest filter over every working set for one key. Idempotent
   * at a fixed filter version, so back-filling an existing corpus is safe to
   * repeat.
   */
  reharvestExercise(key: BaselineKey): Promise<FailureHarvestCounts>;

  /** Release the underlying database handle. Idempotent. */
  close(): Promise<void>;
}
