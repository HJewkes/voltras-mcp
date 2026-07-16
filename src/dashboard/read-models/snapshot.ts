// Snapshot read-model: the pure derivation behind `GET /api/snapshot`.
//
// This module owns the *shaping* of already-gathered device/session state into
// the snapshot payload the dashboard consumes. It is deliberately framework-
// free and I/O-free: it never touches `node:http`, the BLE SDK, the store, or
// the live-state map. `server.ts` gathers the plain state (iterating slots,
// looking up the exercise catalog) and hands it here; this module decides the
// output shape. Keeping it pure makes the snapshot contract unit-testable
// without standing up an HTTP server (see `read-models/architecture` §3).
//
// Confidentiality boundary (NF-07): every value shaped here is plain fitness
// (weights, mode strings, muscle names). No protocol bytes, frame buffers, or
// command codes cross this seam — the caller only ever passes already-typed
// session/device/exercise state.

import type { DeviceSnapshot, ActiveSession, ActiveSet } from '../../state/live-state.js';

/** One slot's device snapshot, tagged with its slot id. */
export interface DeviceEntry {
  slotId: string;
  device: DeviceSnapshot;
}

/**
 * The active session's target muscle groups (primary + secondary), joined from
 * the exercise catalog for the dashboard BodyMap. Plain fitness metadata —
 * never protocol data.
 */
export interface ActiveExerciseMuscles {
  primaryMuscles: string[];
  secondaryMuscles: string[];
}

/** The `/api/snapshot` response body. */
export interface SnapshotResponse {
  session: ActiveSession | null;
  devices: DeviceEntry[];
  sets: { active: ActiveSet | null };
  activeExercise: ActiveExerciseMuscles | null;
}

/**
 * The exercise-catalog entry the caller resolved from the active session's
 * `exerciseId` — the minimal slice the snapshot needs: the display `name` and
 * the BodyMap's muscle groups. `undefined` when there is no active session, no
 * `exerciseId`, no catalog wired, or the exercise is unknown; the derivation
 * collapses all of those to a null BodyMap and an absent `exerciseName`.
 */
export interface ExerciseMeta {
  name?: string;
  muscleGroups: string[];
  secondaryMuscleGroups?: string[];
}

/** The plain, already-gathered state the snapshot is shaped from. */
export interface SnapshotInput {
  /** Every slot's device snapshot, in slot-iteration order. */
  devices: DeviceEntry[];
  /** The primary active session (first slot that has one), if any. */
  session: ActiveSession | undefined;
  /** The primary active set (first slot that has one), if any. */
  activeSet: ActiveSet | undefined;
  /** The catalog entry for the active session's exercise, if resolved. */
  activeExercise: ExerciseMeta | undefined;
}

/**
 * Pure: map a resolved exercise-catalog entry to the BodyMap muscle view.
 * Returns null when no exercise was resolved (no session / unknown exercise /
 * no catalog) — the client renders an empty BodyMap in every such case.
 */
export function resolveActiveExerciseMuscles(
  exercise: ExerciseMeta | undefined,
): ActiveExerciseMuscles | null {
  if (!exercise) return null;
  return {
    primaryMuscles: exercise.muscleGroups ?? [],
    secondaryMuscles: exercise.secondaryMuscleGroups ?? [],
  };
}

/**
 * Pure: join the catalog's display name onto the active session.
 *
 * `session.start` enforces "exerciseId XOR exerciseName" (R21) and drops the
 * name whenever an id is given, so id-started sessions reach here nameless and
 * every consumer renders a placeholder. Resolving the name here — rather than
 * per-consumer — keeps `exerciseId` authoritative on the wire while giving the
 * dashboard something to display.
 *
 * An unresolvable id leaves `exerciseName` absent: a prettified id would be
 * invented data, and an honest blank is the better failure. A session that
 * already carries its own name (name-started, or an auto-created guided-load
 * session) keeps it — the catalog never overwrites what the caller supplied.
 */
export function resolveSessionView(
  session: ActiveSession | undefined,
  exercise: ExerciseMeta | undefined,
): ActiveSession | null {
  if (!session) return null;
  if (session.exerciseName !== undefined || exercise?.name === undefined) return session;
  return { ...session, exerciseName: exercise.name };
}

/**
 * Pure: shape gathered device/session state into the `/api/snapshot` payload.
 * A missing session/set becomes an explicit `null` (the wire contract), and the
 * active exercise is joined to both its display name and its muscle groups.
 */
export function buildSnapshotView(input: SnapshotInput): SnapshotResponse {
  return {
    session: resolveSessionView(input.session, input.activeExercise),
    devices: input.devices,
    sets: { active: input.activeSet ?? null },
    activeExercise: resolveActiveExerciseMuscles(input.activeExercise),
  };
}
