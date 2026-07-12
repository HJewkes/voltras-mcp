/**
 * @voltras/session-core — framework-agnostic shared workout-state layer.
 *
 * Phase-1 scaffold (VMCP-03.01): the two swappable seams (`WorkoutDataSource`,
 * `SessionRepository`), the canonical `WorkoutSession` model, and the two reference
 * platform codecs with round-trip tests. No platform code, no store bodies yet — those
 * land in VMCP-03.02 (dashboard store) and the Phase-2 platform adapters.
 *
 * Design: coordination/architecture/state-layer-convergence-2026-07-12.md
 */

// Re-export the WA domain atoms so consumers import them from one place.
export type { WASet, WARep, WAPhase, WorkoutSample, LoadSettings } from './types.js';

export type {
  Unsubscribe,
  EpochMs,
  TrainingModeName,
  ConnectionState,
  SessionStatus,
  DeviceSettings,
  SetLifecycleEvent,
} from './types.js';

export type { WorkoutDataSource, WorkoutControl } from './data-source.js';

export type { SessionRepository, SessionCodec, ConnectTransportToRecording } from './repository.js';

export type {
  CanonicalRepMeta,
  CanonicalSetSummary,
  CanonicalSet,
  CanonicalWorkoutSession,
} from './canonical.js';

export * from './codecs/index.js';
