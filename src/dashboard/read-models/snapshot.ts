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
// NDA boundary (NF-07): every value shaped here is plain fitness metadata
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
 * `exerciseId` — the minimal muscle-group slice the snapshot needs. `undefined`
 * when there is no active session, no `exerciseId`, no catalog wired, or the
 * exercise is unknown; the derivation collapses all of those to a null BodyMap.
 */
export interface ExerciseMuscleMeta {
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
  activeExercise: ExerciseMuscleMeta | undefined;
}

/**
 * Pure: map a resolved exercise-catalog entry to the BodyMap muscle view.
 * Returns null when no exercise was resolved (no session / unknown exercise /
 * no catalog) — the client renders an empty BodyMap in every such case.
 */
export function resolveActiveExerciseMuscles(
  exercise: ExerciseMuscleMeta | undefined,
): ActiveExerciseMuscles | null {
  if (!exercise) return null;
  return {
    primaryMuscles: exercise.muscleGroups ?? [],
    secondaryMuscles: exercise.secondaryMuscleGroups ?? [],
  };
}

/**
 * Pure: shape gathered device/session state into the `/api/snapshot` payload.
 * A missing session/set becomes an explicit `null` (the wire contract), and the
 * active exercise is joined to its muscle groups. Byte-for-byte equivalent to
 * the assembly that previously lived inline in `server.ts`.
 */
export function buildSnapshotView(input: SnapshotInput): SnapshotResponse {
  return {
    session: input.session ?? null,
    devices: input.devices,
    sets: { active: input.activeSet ?? null },
    activeExercise: resolveActiveExerciseMuscles(input.activeExercise),
  };
}
