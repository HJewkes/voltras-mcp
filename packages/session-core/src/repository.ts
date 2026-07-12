/**
 * Seam 2 — `SessionRepository` (persistence) + the per-platform `SessionCodec` contract.
 *
 * Document-oriented, lifecycle-only. The planning tree stays platform-side (a separate
 * `PlanRepository` concern). Mobile backs this over `StorageAdapter`; MCP/dashboard over
 * the relational `SessionStore` or an HTTP repository.
 */

import type { CanonicalWorkoutSession } from './canonical.js';
import type { Unsubscribe } from './types.js';
import type { WorkoutDataSource } from './data-source.js';

export interface SessionRepository {
  save(session: CanonicalWorkoutSession): Promise<void>; // upsert-in-place (NOT delete+insert)
  getById(id: string): Promise<CanonicalWorkoutSession | null>;
  getCurrent(): Promise<CanonicalWorkoutSession | null>; // in-progress
  setCurrent(id: string | null): Promise<void>;
  getRecent(count: number): Promise<CanonicalWorkoutSession[]>;
  getByExercise(exerciseId: string): Promise<CanonicalWorkoutSession[]>;
}

/** Each platform implements both directions over its own stored shape. Round-trip
 *  lossiness is documented + tested (session-core-roundtrip-spec.md). */
export interface SessionCodec<TStored> {
  toCanonical(stored: TStored): CanonicalWorkoutSession;
  fromCanonical(session: CanonicalWorkoutSession): TStored;
}

/** Glue relocated out of mobile's per-screen `useEffect` so both platforms share it.
 *  The recording-store action surface is typed in Phase 2 (VMCP-03.02); left `unknown`
 *  here so the transport seam can land without the store implementation. */
export type ConnectTransportToRecording = (
  source: WorkoutDataSource,
  recordingStore: unknown,
) => Unsubscribe;
