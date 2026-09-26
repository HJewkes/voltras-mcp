/**
 * Pure derivations behind the `#/body` wall page (VW-338, plan D1).
 *
 * Everything here is `(payload) -> view data`: no fetch, no clock, no React, so
 * the page's render test can drive it with the same JSON the three `/api/muscle-*`
 * routes return. `BodyView` holds no logic beyond layout.
 *
 * ── Two muscle vocabularies meet here ─────────────────────────────────────
 * This repo carries its own copy of the 15 titan slugs (`TitanMuscleGroup`, a
 * string union) because it does not depend on titan-design at the read-model
 * layer; titan publishes them as the `MuscleGroup` enum. The values are
 * identical, so the bridge is a lookup rather than a cast — same technique
 * `goals-model.ts` uses.
 *
 * The statuses are NOT identical. A read model reports the physiological
 * landmark zone (`under | maintenance | productive | over`, titan's
 * `VolumeLandmarkZone`); the figure and the chips paint titan's single UI
 * `VolumeStatus`, which splits `productive` into `target` / `approaching` near
 * MRV and adds `untrained`. `landmarkZoneToStatus` is titan's own wiring for
 * that, and reusing it is what keeps one muscle one colour in both places.
 */
import {
  MuscleGroup,
  MUSCLE_DISPLAY_NAMES,
  landmarkZoneToStatus,
  type BodyMapData,
  type VolumeStatus as TitanVolumeStatus,
} from '@titan-design/react-ui/bodymap';
import type { MuscleStripMuscleData } from '@titan-design/react-ui';

import type {
  MusclePlanView,
  MuscleStrengthView,
  MuscleWeekMuscleView,
  MuscleWeekView,
} from '../../read-models/index.js';

/** Everything the page renders, as fetched. `plan` is null with no active training week. */
export interface BodyPageData {
  week: MuscleWeekView;
  strength: MuscleStrengthView;
  plan: MusclePlanView | null;
}

const MUSCLE_BY_SLUG = new Map<string, MuscleGroup>(
  Object.values(MuscleGroup).map((group) => [group, group]),
);

/** The titan enum member for a read-model slug, or `null` for a slug titan does not carry. */
export function muscleGroupOf(slug: string): MuscleGroup | null {
  return MUSCLE_BY_SLUG.get(slug) ?? null;
}

/** Display name for a read-model slug; the slug itself when titan has no name for it. */
export function muscleLabel(slug: string): string {
  const group = muscleGroupOf(slug);
  return group === null ? slug : MUSCLE_DISPLAY_NAMES[group];
}

/**
 * Where a muscle's week sits between "nothing" and its MRV, as the 0-1 the
 * figure shades with. Clamped at 1 so an over-MRV week reads as full rather
 * than wrapping past the top of the scale.
 */
export function intensityOf(muscle: MuscleWeekMuscleView): number {
  if (muscle.landmarks.mrv <= 0) return 0;
  return Math.min(1, muscle.sets / muscle.landmarks.mrv);
}

/**
 * The UI status a muscle's week reads as, including the untrained case. Titan
 * has no "no verdict" status, so a withheld verdict (VW-561) paints the neutral
 * `ontrack` fill; the THIS WEEK tiles still leave it out.
 */
export function statusOf(muscle: MuscleWeekMuscleView): TitanVolumeStatus {
  if (muscle.sets === 0) return 'untrained';
  if (muscle.status === null) return 'ontrack';
  return landmarkZoneToStatus(muscle.status, intensityOf(muscle));
}

/**
 * The figure's data. Untrained muscles are OMITTED, not sent with a zero:
 * `BodyMap` keeps its outline fill for a muscle it has no row for, which is how
 * titan draws "no data" — a zero row would paint it as a shaded value instead.
 */
export function bodyMapData(week: MuscleWeekView): BodyMapData[] {
  return week.muscles.flatMap((muscle) => {
    const group = muscleGroupOf(muscle.muscle);
    if (group === null || muscle.sets === 0) return [];
    return [
      {
        muscleGroup: group,
        intensity: intensityOf(muscle),
        volumeStatus: statusOf(muscle),
        weeklySets: muscle.sets,
      },
    ];
  });
}

/**
 * The strip's data. `MuscleStrip` requires every `MuscleGroup` to be present,
 * so this seeds all 15 at zero and fills in what the week carries — a muscle the
 * read model dropped renders as untrained rather than crashing the strip.
 *
 * Target is MAV, not MRV: MAV is the week a chip is measured against, and MRV
 * is the ceiling the status already reports by turning `over`.
 */
export function muscleStripData(week: MuscleWeekView): Record<MuscleGroup, MuscleStripMuscleData> {
  const data = Object.fromEntries(
    Object.values(MuscleGroup).map((group) => [
      group,
      { sets: 0, target: 0, volumeStatus: 'untrained' as TitanVolumeStatus },
    ]),
  ) as Record<MuscleGroup, MuscleStripMuscleData>;
  for (const muscle of week.muscles) {
    const group = muscleGroupOf(muscle.muscle);
    if (group === null) continue;
    data[group] = {
      sets: muscle.sets,
      target: muscle.landmarks.mav,
      volumeStatus: statusOf(muscle),
    };
  }
  return data;
}

/** The THIS WEEK tiles: the counts the wall is read for from three metres away. */
export interface BodyWeekSummary {
  /** Working sets, summed once per muscle — a lift training two muscles counts in both. */
  totalSets: number;
  /** Muscles with at least one set this week. */
  trainedMuscles: number;
  productive: number;
  /**
   * Muscles below their MEV, WHICH INCLUDES the ones not trained at all: zero
   * sets is below every non-zero minimum. So this can exceed `trainedMuscles`,
   * and the tile says "below MEV" rather than "under" for that reason.
   */
  under: number;
  over: number;
}

export function weekSummary(week: MuscleWeekView): BodyWeekSummary {
  let totalSets = 0;
  let trainedMuscles = 0;
  let productive = 0;
  let under = 0;
  let over = 0;
  for (const muscle of week.muscles) {
    totalSets += muscle.sets;
    if (muscle.sets > 0) trainedMuscles += 1;
    if (muscle.status === 'productive') productive += 1;
    if (muscle.status === 'under') under += 1;
    if (muscle.status === 'over') over += 1;
  }
  return { totalSets, trainedMuscles, productive, under, over };
}

/** One upcoming planned lift, with every muscle it is still owed sets for folded in. */
export interface NextUpRow {
  exerciseId: string;
  exerciseName: string;
  workoutName: string;
  sets: number;
}

/**
 * The NEXT UP list. `plannedRemaining` repeats one exercise under every muscle it
 * trains, so the same lift would otherwise appear three times for a "shoulders"
 * row; this keys by exercise and keeps the largest remaining set count, which is
 * the number the athlete still owes that lift.
 */
export function nextUpRows(plan: MusclePlanView | null): NextUpRow[] {
  if (plan === null) return [];
  const byExercise = new Map<string, NextUpRow>();
  for (const muscle of plan.muscles) {
    for (const row of muscle.plannedRemaining) {
      const seen = byExercise.get(row.exerciseId);
      if (seen === undefined || row.sets > seen.sets) {
        byExercise.set(row.exerciseId, {
          exerciseId: row.exerciseId,
          exerciseName: row.exerciseName,
          workoutName: row.workoutName,
          sets: row.sets,
        });
      }
    }
  }
  return [...byExercise.values()];
}

/** One PR the week's strength read model found, with the muscle it is filed under. */
export interface PrRow {
  key: string;
  exerciseName: string;
  muscleLabel: string;
  e1rm: number | null;
  priorBest: number | null;
  side: 'left' | 'right' | null;
}

/**
 * Every PR row across every muscle, best first. An exercise that trains two
 * muscles is filed under both by the read model, so rows are keyed by
 * exercise + side and the first muscle to claim one wins — showing the same PR
 * twice on a glance page reads as two PRs.
 */
export function prRows(strength: MuscleStrengthView): PrRow[] {
  const seen = new Set<string>();
  const rows: PrRow[] = [];
  for (const muscle of strength.muscles) {
    for (const exercise of muscle.exercises) {
      if (!exercise.isPR) continue;
      const key = `${exercise.exerciseId}:${exercise.side ?? 'none'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        key,
        exerciseName: exercise.name,
        muscleLabel: muscleLabel(muscle.muscle),
        e1rm: exercise.bestE1rm?.value ?? null,
        priorBest: exercise.priorBest,
        side: exercise.side,
      });
    }
  }
  return rows.sort((a, b) => (b.e1rm ?? 0) - (a.e1rm ?? 0));
}

/** `52 lb (+3)`, or `52 lb` with no prior to beat. Never a bare number — the unit carries. */
export function prValueText(row: PrRow): string {
  if (row.e1rm === null) return '—';
  const value = `${round1(row.e1rm)} lb`;
  if (row.priorBest === null) return value;
  const delta = round1(row.e1rm - row.priorBest);
  return `${value} (+${delta})`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
