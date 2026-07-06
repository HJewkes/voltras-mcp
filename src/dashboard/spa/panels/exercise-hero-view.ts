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
  estimateSetRpe,
  getSetRepPeakVelocities,
  getSetTempoSeconds,
} from '@voltras/workout-analytics';
import type { ExerciseCardProps, SetRowProps, TempoDisplayProps } from '@titan-design/react-ui';
import { MMS_PER_MPS, type WorkoutSetView } from '../adapter';

/** Rep count shown on a row: null for an active set with no reps yet, else count. */
function displayRepCount(view: WorkoutSetView): number | null {
  if (view.kind === 'active' && view.reps.length === 0) return null;
  return view.reps.length;
}

/**
 * Map a canonical set view onto titan `SetRow` props. Passes EXACT values — RPE
 * from WA (SetRow rounds to 0.5 + bands), per-rep peak velocity in m/s (SetRow's
 * VelocityStrip formats), raw weights (SetRow rounds). The mm/s→m/s conversion is
 * the app's data-source normalization (WA is unit-agnostic).
 */
export function toSetRowProps(view: WorkoutSetView): SetRowProps {
  const velocities = getSetRepPeakVelocities({ reps: view.reps }).map((mms) =>
    mms != null ? mms / MMS_PER_MPS : 0,
  );
  return {
    mode: view.kind,
    setNumber: view.setNumber,
    reps: displayRepCount(view),
    weight: view.weightLbs,
    rpe: estimateSetRpe({ reps: view.reps }),
    unit: 'lbs',
    velocities: velocities.length > 0 ? velocities : undefined,
    previous: view.previous ? { reps: view.previous.reps, weight: view.previous.weightLbs } : null,
    isNextSet: view.kind === 'active',
    targets:
      view.kind === 'active' && view.targetReps != null && view.targetWeightLbs != null
        ? { reps: view.targetReps, weight: view.targetWeightLbs }
        : undefined,
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
