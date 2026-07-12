/**
 * Canonical `WorkoutSession` — the shared in-memory session model.
 *
 * NESTED over WA types (every WA analytics fn takes a `Set`/`Rep`/`WorkoutSample`
 * object graph directly, so a flat+id-ref shape would force re-joins before every call).
 * Timestamps are epoch-ms; normalization (ISO ⇄ ms, relational flattening) stays a
 * persistence concern inside each platform's adapter.
 *
 * Design: state-layer-convergence-2026-07-12.md §3d. Round-trip lossiness (chains/ecc
 * MCP-lossy, derivedVbt mobile-lossy, plan↔program_assignments never cross) is documented
 * and tested — see session-core-roundtrip-spec.md.
 */

import type { Set as WASet, LoadSettings, WorkoutSample } from '@voltras/workout-analytics';
import type { EpochMs, SessionStatus, TrainingModeName } from './types.js';

/** Per-rep enrichment absent from WA `Rep`. Index-aligned to `analytics.reps` — NEVER
 *  spread onto WA `Rep` (would break the MCP `satisfies Rep` invariant inside the core). */
export interface CanonicalRepMeta {
  id?: string; // MCP rep-row id; absent on mobile (index-identified)
  derivedVbt?: unknown; // MCP StoredRepVbt verbatim (finalized/corrected VBT). Opaque to core.
}

/** Mobile-precomputed set summary; else derived via WA on demand. */
export interface CanonicalSetSummary {
  meanVelocity: number;
  estimatedRPE: number;
  estimatedRIR: number;
  velocityLossPercent: number;
}

export interface CanonicalSet {
  id: string;
  index: number; // 0-based order
  startedAt: EpochMs;
  endedAt: EpochMs | null;
  /** Unifies mobile weight/chains/eccentric AND MCP weightLbs (chains/ecc = 0).
   *  Should mirror `analytics.loadSettings` when present. */
  load: LoadSettings;
  /** WA `Set` verbatim — reps[] with full `Phase` graph. The analytics core. */
  analytics: WASet;
  // optional, platform-originated
  partial?: boolean; // MCP
  partialReason?: string; // MCP
  trainingMode?: TrainingModeName; // MCP
  /** MCP rep ids + finalized derived VBT, index-aligned to `analytics.reps`. */
  repMeta?: CanonicalRepMeta[];
  summary?: CanonicalSetSummary; // mobile-precomputed; else derive via WA on demand
  rawSamples?: WorkoutSample[]; // mobile debug-only full-set stream
}

export interface CanonicalWorkoutSession {
  id: string;
  exerciseId?: string;
  exerciseName?: string;
  startedAt: EpochMs;
  endedAt: EpochMs | null;
  status: SessionStatus; // explicit; MCP adapter derives from endedAt + set partial
  sets: CanonicalSet[]; // NESTED, ordered by index
  notes?: string; // MCP
  terminationReason?: string; // mobile
  /** Platform payloads that don't round-trip; namespaced so neither adapter reads the
   *  other's keys. mobile: { plan, schemaVersion }; mcp: { programAssignments, … }. */
  extra?: {
    mobile?: Record<string, unknown>;
    mcp?: Record<string, unknown>;
  };
}
