/**
 * Exercise-hero view wiring — maps canonical `WorkoutSetView`s onto titan
 * `ExerciseCard` / `SetRow` prop shapes for the dashboard hero.
 *
 * This is the thin app-side glue of the model↔render split: exact derivations
 * come from `@voltras/workout-analytics`; the titan components round / band /
 * format for display. It passes EXACT WA values straight into the prop shapes —
 * no pre-rounding, no shared-package seam. Mobile wires its own WA data into the
 * same titan components the same way. Titan imports are TYPES only (erased at
 * build), so this runs in the node test environment.
 *
 * NDA: reads WA view-models + adapter view state only; no protocol data.
 */
import {
  bestE1RMAcrossSets,
  estimateSetRpe,
  getSetRepPeakVelocities,
  getSetTempoSeconds,
  isNewE1RM,
} from '@voltras/workout-analytics';
import type {
  ExerciseCardProps,
  SetRowProps,
  StatusPillStatus,
  TempoDisplayProps,
} from '@titan-design/react-ui';
import { MMS_PER_MPS, type WorkoutSetView } from '../adapter';

/**
 * Coaching auto-regulation verdict from live velocity-loss %. Shared by the
 * live surface's `StatusPill` (verdict text) and `LiveAuraFrame` (flood), which
 * take the same `productive | threshold | stop` domain: below VL20 keep going,
 * VL20–28 approaching fatigue, VL28+ terminate the set. Null (no verdict / no
 * flood) when loss is not yet derivable (<2 reps).
 */
export function toAutoRegStatus(lossPct: number | null): StatusPillStatus | null {
  if (lossPct === null) return null;
  if (lossPct >= 28) return 'stop';
  if (lossPct >= 20) return 'threshold';
  return 'productive';
}

/**
 * Map a canonical set view onto titan `SetRow` props (titan 0.7.0 unified table:
 * a `state` discriminated union, no PREV column). `completed` → `done` (logged
 * reps/weight/rpe); `active` → `live`, which always displays a `target` — so an
 * unplanned live set falls back its target to the reps done so far and the
 * current working weight. Passes EXACT WA values — RPE (SetRow rounds to 0.5 +
 * bands), per-rep velocity in m/s (SetRow's VelocityStrip formats), raw weights
 * (SetRow rounds). The mm/s→m/s conversion is the app's data-source
 * normalization (WA is unit-agnostic).
 */
export function toSetRowProps(view: WorkoutSetView): SetRowProps {
  const velocities = getSetRepPeakVelocities({ reps: view.reps }).map((mms) =>
    mms != null ? mms / MMS_PER_MPS : 0,
  );
  const rpe = estimateSetRpe({ reps: view.reps });
  const repsDone = view.reps.length;
  const weight = view.weightLbs ?? 0;
  if (view.kind === 'active') {
    return {
      state: 'live',
      setNumber: view.setNumber,
      unit: 'lbs',
      target: {
        reps: view.targetReps ?? repsDone,
        weight: view.targetWeightLbs ?? weight,
      },
      reps: repsDone,
      weight,
      rpe,
      velocities,
    };
  }
  return {
    state: 'done',
    setNumber: view.setNumber,
    unit: 'lbs',
    reps: repsDone,
    weight,
    rpe,
    velocities,
  };
}

type ExerciseSummary = NonNullable<ExerciseCardProps['summary']>;

/**
 * Map the set timeline onto titan `ExerciseCard`'s header summary. `sets` counts
 * completed sets; `reps`/`weight` reflect the active rep target when configured,
 * else the last set's actuals. Weight is exact — `ExerciseCard` rounds it.
 */
export function toExerciseSummary(
  views: WorkoutSetView[],
  repTarget: number | null,
): ExerciseSummary {
  const completed = views.filter((v) => v.kind === 'completed').length;
  const last = views[views.length - 1];
  const lastReps = last ? last.reps.length : 0;
  return {
    sets: completed,
    reps: repTarget ?? lastReps,
    weight: last?.weightLbs ?? 0,
    unit: 'lbs',
  };
}

/**
 * Live cadence for the active set as titan `TempoDisplay`'s
 * `[eccentric, pauseBottom, concentric, pauseTop]` seconds tuple — EXACT,
 * straight from WA's `getSetTempoSeconds` (the most recent rep that carries real
 * phase timing). `null` when there is no active set or no rep has timing yet, so
 * the panel renders nothing rather than an all-zero "instant" cadence (an
 * uncaptured tempo is absence, not a real zero — see `getSetTempoSeconds`).
 * TempoDisplay rounds each phase to whole seconds for display.
 */
export function toLiveTempoSeconds(view: WorkoutSetView | null): TempoDisplayProps['tempo'] | null {
  if (view == null) return null;
  return getSetTempoSeconds({ reps: view.reps });
}

/**
 * PR flag for titan `ExerciseCard`'s `isPR` chip. titan 0.7.0's unified card
 * dropped the numeric e1RM badge, so the dashboard no longer surfaces the
 * projected-1RM value — but PR *detection* still rides the same WA estimate:
 * `bestE1RMAcrossSets` (Epley, per-set primitive `estimateE1RMFromReps`) is
 * compared to the exercise's prior historical best via `isNewE1RM`. Never true
 * without a baseline (the first-ever session isn't a PR) or before a set has a
 * positive load + >=1 captured rep.
 */
export function toExerciseIsPR(views: WorkoutSetView[], historyBestE1rm: number | null): boolean {
  const value = bestE1RMAcrossSets(views.map((v) => ({ load: v.weightLbs, reps: v.reps.length })));
  return isNewE1RM(value, historyBestE1rm);
}
