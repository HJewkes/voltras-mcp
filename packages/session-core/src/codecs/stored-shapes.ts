/**
 * Reference stored-shape types for the two platform codecs.
 *
 * These mirror the persisted schemas the codecs map to/from:
 *   - MCP: `voltras-mcp/src/store/types.ts` (`StoredSession`/`StoredSet`/`StoredRep`)
 *   - mobile: `voltras/mobile/.../exercise-session-schema.ts`
 *
 * They live here (rather than importing the real platform types) so the Phase-1
 * package stays framework-agnostic and self-contained. VMCP-03.02 + the Phase-2
 * platform adapters wire the codecs to the REAL store types (structurally identical);
 * these local shapes then become the conformance contract the platform types satisfy.
 */

import type { Rep as WARep, WorkoutSample } from '@voltras/workout-analytics';
import type { SessionStatus } from '../types.js';

// ── MCP (relational SessionStore) ────────────────────────────────────────────

export interface McpStoredSession {
  id: string;
  exerciseId?: string;
  exerciseName?: string;
  startedAt: string; // ISO-8601
  endedAt?: string | null; // ISO-8601
  notes?: string;
}

/** MCP `StoredRep` IS a WA `Rep` (full `Phase` graph) plus row metadata. `derived` is the
 *  finalized/corrected VBT (opaque `StoredRepVbt`). */
export interface McpStoredRep extends WARep {
  id: string;
  setId: string;
  index: number;
  derived?: unknown;
}

export interface McpStoredSet {
  id: string;
  sessionId: string;
  startedAt: string; // ISO-8601
  endedAt?: string | null; // ISO-8601
  weightLbs: number; // NO chains/eccentric columns — the MCP-lossy direction
  trainingMode?: string;
  partial?: boolean;
  partialReason?: string;
  reps: McpStoredRep[];
}

export interface McpStored {
  session: McpStoredSession;
  sets: McpStoredSet[];
  /** From `getAssignmentsForSession` — the normalized periodization graph. Opaque here. */
  assignments?: unknown[];
}

// ── mobile (KV-blob StorageAdapter) ──────────────────────────────────────────

/** Mobile `StoredRep` is a LOSSY subset of WA `Rep` — only the raw samples per phase.
 *  The WA `Set` is rebuilt by replaying these through `addSampleToSet` on load. */
export interface MobileStoredRepPhase {
  samples: WorkoutSample[];
}

export interface MobileStoredRep {
  repNumber: number;
  concentric: MobileStoredRepPhase;
  eccentric: MobileStoredRepPhase;
}

export interface MobileCompletedSet {
  setIndex: number;
  startTime: number; // EpochMs
  endTime: number; // EpochMs
  weight: number;
  chains: number; // PRESENT on mobile — the MCP-lossy fields
  eccentric: number;
  meanVelocity: number;
  estimatedRPE: number;
  estimatedRIR: number;
  velocityLossPercent: number;
  reps: MobileStoredRep[];
}

export interface MobileStoredExerciseSession {
  id: string;
  exerciseId: string;
  exerciseName: string;
  startTime: number; // EpochMs
  endTime: number | null; // EpochMs
  status: SessionStatus;
  terminationReason?: string;
  schemaVersion: number;
  plan?: unknown; // embedded ad-hoc prescription — never crosses to MCP program_assignments
  completedSets: MobileCompletedSet[];
}
