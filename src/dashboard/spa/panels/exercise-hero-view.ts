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
 * Confidentiality: reads WA view-models + adapter view state only; no protocol data.
 */
import {
  bestE1RMAcrossSets,
  estimateSetRpe,
  getSetRepPeakVelocities,
  getSetTempoSeconds,
  isNewE1RM,
} from '@voltras/workout-analytics/view';
import type {
  ExerciseCardProps,
  SetRowProps,
  StatusPillStatus,
  TempoDisplayProps,
} from '@titan-design/react-ui';
import { type WorkoutSetView } from '../adapter';
import { convertMass, type MassUnit } from '../live-page/mass';

/**
 * A {@link WorkoutSetView} plus the truthful load label for weightless training
 * modes (VMCP-02.74's `describeLoad`: `damper 6` / `band` / `iso`), used when
 * `weightLbs` is null instead of fabricating a numeric weight.
 */
export interface HeroSetView extends WorkoutSetView {
  loadLabel?: string;
}

/** A target reps/weight pair; `weight` is absent for a weightless training mode. */
interface HeroTarget {
  reps: number;
  weight?: number;
}

type HeroDoneRow = Omit<Extract<SetRowProps, { state: 'done' }>, 'weight'> & {
  weight?: number;
  loadLabel?: string;
};
type HeroLiveRow = Omit<Extract<SetRowProps, { state: 'live' }>, 'weight' | 'target'> & {
  weight?: number;
  loadLabel?: string;
  target: HeroTarget;
};

/** {@link SetRowProps}, but `weight`/`target.weight` may be absent instead of a fabricated 0. */
export type HeroSetRowProps = HeroDoneRow | HeroLiveRow;

/**
 * Coaching auto-regulation verdict from live velocity-loss %. Shared by the
 * live surface's `StatusPill` (verdict text) and `LiveAuraFrame` (flood), which
 * take the same `productive | threshold | stop` domain: below VL20 keep going,
 * VL20–VL30 approaching fatigue, VL30+ terminate the set. Null (no verdict / no
 * flood) when loss is not yet derivable (<2 reps).
 *
 * CANONICAL BANDS: 20/30 — identical to the rest view's `verdictFromLoss`
 * (`live-page/model.ts`), so the live StatusPill and the rest-view aura never
 * disagree (they previously split at 28 vs 30).
 * TODO(VW-64): decide whether to adopt WA's now-published `velocityLossVerdict`
 * (the eventual SSOT) in place of this local banding — a wiring choice, not a
 * blocked dependency.
 */
export function toAutoRegStatus(lossPct: number | null): StatusPillStatus | null {
  if (lossPct === null) return null;
  if (lossPct >= 30) return 'stop';
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
 * (SetRow rounds). Velocities need no conversion: the server's bridge converts
 * them once when it builds each `WorkoutSample` (VW-160).
 *
 * `unit` (VW-196) rescales the weight fields via `convertMass` — the EXACT
 * contract above still holds, so this never pre-rounds; SetRow does.
 */
export function toSetRowProps(view: HeroSetView, unit: MassUnit = 'lbs'): HeroSetRowProps {
  // TODO(VW-62): decide whether to swap to the now-published set-level MEAN
  // sibling `getSetRepMeanVelocities` — a wiring choice, not a blocked
  // dependency. The per-rep strips already moved to mean (`panels/live-view.ts`);
  // this set-level path stays peak until that choice is made, so the hero's
  // SetRow reads optimistic vs the recap.
  // A rep with no derivable peak velocity is omitted, not fabricated as 0.
  const velocities = getSetRepPeakVelocities({ reps: view.reps }).filter(
    (mps): mps is number => mps != null,
  );
  const rpe = estimateSetRpe({ reps: view.reps });
  const repsDone = view.reps.length;
  const weight = view.weightLbs == null ? undefined : convertMass(view.weightLbs, unit);
  const loadLabel = view.weightLbs == null ? (view.loadLabel ?? '—') : undefined;
  if (view.kind === 'active') {
    return {
      state: 'live',
      setNumber: view.setNumber,
      unit,
      target: {
        reps: view.targetReps ?? repsDone,
        weight: view.targetWeightLbs === null ? weight : convertMass(view.targetWeightLbs, unit),
      },
      reps: repsDone,
      weight,
      loadLabel,
      rpe,
      velocities,
    };
  }
  return {
    state: 'done',
    setNumber: view.setNumber,
    unit,
    reps: repsDone,
    weight,
    loadLabel,
    rpe,
    velocities,
  };
}

type ExerciseSummary = NonNullable<ExerciseCardProps['summary']>;

/** {@link ExerciseSummary}, but `weight` may be absent instead of a fabricated 0. */
export type HeroExerciseSummary = Omit<ExerciseSummary, 'weight'> & {
  weight?: number;
  loadLabel?: string;
};

/**
 * Map the set timeline onto titan `ExerciseCard`'s header summary. `sets` counts
 * completed sets; `reps`/`weight` reflect the active rep target when configured,
 * else the last set's actuals. Weight is exact (rescaled by `unit` via
 * `convertMass`, VW-196) — `ExerciseCard` rounds it. A weightless last set (or no
 * sets at all) carries its `loadLabel` (or an em-dash) instead of a fabricated 0.
 */
export function toExerciseSummary(
  views: HeroSetView[],
  repTarget: number | null,
  unit: MassUnit = 'lbs',
): HeroExerciseSummary {
  const completed = views.filter((v) => v.kind === 'completed').length;
  const last = views[views.length - 1];
  const lastReps = last ? last.reps.length : 0;
  const weight = last?.weightLbs == null ? undefined : convertMass(last.weightLbs, unit);
  const loadLabel = last?.weightLbs == null ? (last?.loadLabel ?? '—') : undefined;
  return {
    sets: completed,
    reps: repTarget ?? lastReps,
    weight,
    loadLabel,
    unit,
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
