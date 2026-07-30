// Wire shape of `GET /api/session-summary/:sessionId` (VW-120).
//
// Type-only, and deliberately free of any store / node import so BOTH sides of
// the boundary can import it: the server builder (`dashboard/session-summary.ts`)
// and the SPA page that renders it. The dashboard's older contracts
// (`PrescriptionView`, `LiveFatigueModel`) are hand-mirrored on each side, and
// optional fields have drifted across that seam with zero tsc signal — one
// shared declaration removes the failure mode entirely.
//
// Confidentiality: fitness units and plan metadata only — no protocol data (NF-07).

import type { FatigueSummary, FatigueVerdict } from '@voltras/workout-analytics';

/** One completed set, as the summary screen lists it. */
export interface SessionSummarySet {
  id: string;
  /** 1-based ordinal within the session. */
  index: number;
  startedAt: string;
  endedAt: string;
  weightLbs: number | null;
  repCount: number;
  isWarmup: boolean;
  /** Peak-to-last concentric velocity loss within the set, %. Null with no velocity telemetry. */
  velocityLossPct: number | null;
  bestRepVelocity: number | null;
}

/** The `plan.suggest_progression` recommendation, per exercise. */
export interface SessionSummaryProgression {
  /** Load delta in lbs: +5 / 0 / -5 under the v1 heuristic. */
  delta: number;
  reasoning: string;
  basedOnSessionId: string | null;
  /** The planned row the recommendation was scored against. */
  targetSets: number;
  targetRepsLow: number | null;
  targetRepsHigh: number | null;
  targetWeightLbs: number | null;
}

export interface SessionSummaryExercise {
  /** Catalog id, or null for sets that recorded no exercise. */
  exerciseId: string | null;
  /** Catalog name, the raw id when the catalog has no entry, or `'Unattributed'` for null. */
  name: string;
  setCount: number;
  /** Sets not flagged `isWarmup`. */
  workingSetCount: number;
  totalReps: number;
  /** Σ weight × reps. Null when NO set recorded a load — a gap, never a 0. */
  volumeLbs: number | null;
  topWeightLbs: number | null;
  bestRepVelocity: number | null;
  /** Worst within-set velocity loss across the exercise's sets, %. */
  maxVelocityLossPct: number | null;
  /** Fatigue verdict of the exercise's LAST working set — how the exercise ended. */
  verdict: FatigueVerdict | null;
  /** Fatigue summary (RIR/RPE/consistency) of that same last working set. */
  fatigue: FatigueSummary | null;
  sets: SessionSummarySet[];
  /** Null when the exercise isn't prescribed in the current program. */
  progression: SessionSummaryProgression | null;
  /** Why `progression` is null, when it is. */
  progressionNote: string | null;
}

export interface SessionSummaryView {
  session: {
    id: string;
    startedAt: string;
    endedAt: string | null;
    exerciseId: string | null;
    exerciseName: string | null;
  };
  /** One card per exercise the session touched, in first-set order. */
  exercises: SessionSummaryExercise[];
}
