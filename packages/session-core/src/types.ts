/**
 * Shared value types for @voltras/session-core — SDK-free by construction.
 *
 * Everything here is at the `WorkoutSample` (fitness-unit) grain, never
 * `TelemetryFrame` / protocol bytes (confidentiality / ESLint NF-07). The domain atoms are
 * re-exported from `@voltras/workout-analytics` so consumers import them from one
 * place.
 *
 * Design: coordination/architecture/state-layer-convergence-2026-07-12.md (§3a/§3d).
 */

import type { LoadSettings } from '@voltras/workout-analytics';

// Direct re-export (single hop) so downstream `.reps`/`.samples` types resolve — a
// two-step `import type … as X; export type { X }` collapses the WA graph to `any`.
export type {
  Set as WASet,
  Rep as WARep,
  Phase as WAPhase,
  WorkoutSample,
  LoadSettings,
} from '@voltras/workout-analytics';

export type Unsubscribe = () => void;

/** Canonical time unit across session-core = `WorkoutSample.timestamp` (ms since epoch). */
export type EpochMs = number;

/** Kept a string alias to stay SDK-free; platform adapters map their own mode enums in. */
export type TrainingModeName = string;

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export type SessionStatus = 'in_progress' | 'completed' | 'abandoned';

/** Device configuration at the fitness-unit grain (mirrors WA `LoadSettings` + mode). */
export interface DeviceSettings {
  load: LoadSettings; // { weight, chains, eccentric }
  mode: TrainingModeName;
  battery?: number; // 0–100
}

/** Set lifecycle boundary — lets a store reset/clear its live tempo state. */
export interface SetLifecycleEvent {
  kind: 'started' | 'ended';
  setId: string;
  sessionId: string;
  targetReps?: number;
  tempo?: string;
}
