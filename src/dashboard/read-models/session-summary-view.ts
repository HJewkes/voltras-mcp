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
import type { LoadDriftFlag } from '../../analytics/load-drift.js';
// Type-only: erased at build, so this stays free of a runtime store dependency
// (see the file banner) — mirrors the store's four-value set-purpose enum, the
// same treatment `dashboard/spa/live-page/model.ts`'s `CompletedSet` gives it.
import type { SetPurpose } from '../../store/types.js';
// Type-only, and itself store/node-free (see its own file banner) — the VW-301
// expected-rep-range shape.
import type { RepsToThresholdRange } from '../../analytics/reps-to-threshold-range.js';

/** One completed set, as the summary screen lists it. */
export interface SessionSummarySet {
  id: string;
  /** 1-based ordinal within the session. */
  index: number;
  startedAt: string;
  endedAt: string;
  weightLbs: number | null;
  /**
   * Truthful load label for the set, by its own `trainingMode` setting
   * (VMCP-02.74) — `damper 6` / `band` / `iso` for a Damper, Band or
   * Isokinetic set that has no `weightLbs` to fall back on. See
   * `describeLoad` in `state/set-capture.ts`, the one place this is decided.
   */
  loadLabel: string;
  repCount: number;
  /** Why this set was performed — the same enum `CompletedSet.setPurpose` carries (VW-283). */
  setPurpose: SetPurpose;
  /** Peak-to-last concentric velocity loss within the set, %. Null with no velocity telemetry. */
  velocityLossPct: number | null;
  bestRepVelocity: number | null;
  /**
   * Expected rep range for a velocity-loss-terminated set at this load, from
   * this lifter's own history (VW-301) — never a point estimate, because
   * Jukic et al. 2023 found reps-to-a-fixed-VL-threshold carry 95% limits of
   * agreement of roughly -5.4/+5.5 reps between sessions at the same
   * threshold and load. Null below the module's minimum qualifying history.
   */
  expectedRepRange: RepsToThresholdRange | null;
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
  /** Count from the shared `selectWorkingSets` predicate (VW-283). */
  workingSetCount: number;
  totalReps: number;
  /** Σ weight × reps. Null when NO set recorded a load — a gap, never a 0. */
  volumeLbs: number | null;
  topWeightLbs: number | null;
  bestRepVelocity: number | null;
  /**
   * Worst within-set velocity loss across the exercise's WORKING sets, %.
   * The verdict/fatigue below read the same set this number comes from — see
   * `scoreVerdictSet` in `session-summary.ts` for why one basis, not two.
   */
  maxVelocityLossPct: number | null;
  /** Fatigue verdict of the exercise's WORST working set (by velocity loss). */
  verdict: FatigueVerdict | null;
  /** Fatigue summary (RIR/RPE/consistency) of that same worst set. */
  fatigue: FatigueSummary | null;
  /** 1-based session ordinal of the set `verdict`/`fatigue`/`maxVelocityLossPct` read. */
  verdictSetIndex: number | null;
  sets: SessionSummarySet[];
  /** Null when the exercise isn't prescribed in the current program. */
  progression: SessionSummaryProgression | null;
  /** Why `progression` is null, when it is. */
  progressionNote: string | null;
  /**
   * VW-300: set when a WORKING set at this exercise's programmed absolute
   * load implies a %1RM that has drifted materially from the programmed one,
   * per the lifter's own load-velocity profile. Null when nothing is
   * prescribed, no set matched the prescribed load, or the drift (if any) is
   * under threshold. See `analytics/load-drift.ts`.
   */
  loadDrift: LoadDriftFlag | null;
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
