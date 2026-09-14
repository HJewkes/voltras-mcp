// Pure read-model for the body-map plan's "weekly sets per muscle vs landmarks"
// affordance (VW-329, B2 of the body-map plan). `buildMuscleWeekView` shapes one
// calendar week of recorded sets into one row per titan muscle group: working
// sets this week, the population volume landmarks, the status those two imply,
// and when the muscle was last trained. It performs NO I/O: the caller
// (`dashboard/server.ts`'s `serveMuscleWeek`) owns the store reads, this module
// owns the output shape — the same split `read-models/plan-tree.ts` uses.
//
// TARGET-ONLY (B47, VMCP-06.05): a set counts toward its exercise's PRIMARY
// catalog muscle group ONLY, mapped to titan slug(s) through `mapCatalogMuscle`
// (VW-328). Secondary groups never contribute, at any weight — the retired
// `muscle-volume.ts` counted them at half a set, which the B47 decision
// recorded later reversed. A coarse catalog group (e.g. `shoulders`) maps to
// more than one titan slug, and a set against it counts in full toward each;
// there is no way to split it further from the data recorded.
//
// LANDMARKS ARE POPULATION DEFAULTS. They are looked up, not discovered, so
// `landmarkBasis` is the literal `'population-default'` and nothing here may
// ever claim otherwise. Discovering an athlete's own MEV/MAV/MRV from set-count
// history is VW-146's job; until it lands, `history.weekly_volume` keeps
// returning `verdict: null` and this view keeps saying whose numbers these are.
//
// Confidentiality: fitness metadata only — no protocol data (NF-07).

import {
  MUSCLE_MAP_VERSION,
  TITAN_MUSCLE_GROUPS,
  type TitanMuscleGroup,
} from '../../exercises/muscle-map.js';
import type { StoredSet } from '../../store/types.js';
import {
  endOfCalendarWeekIso,
  isEligibleWorkingSet,
  startOfCalendarWeekIso,
  titanMusclesFor,
  type MuscleCatalogLookup,
} from './muscle-set-scope.js';

/** Weekly working-set landmarks for one muscle group. */
export interface VolumeLandmarks {
  /** Minimum Effective Volume. */
  mev: number;
  /** Maximum Adaptive Volume. */
  mav: number;
  /** Maximum Recoverable Volume. */
  mrv: number;
}

/**
 * Weekly working sets per titan muscle group, copied verbatim from
 * titan-design's `DEFAULT_VOLUME_LANDMARKS`
 * (`packages/ui/src/components/custom/Workout/muscleTaxonomy.ts`,
 * `@titan-design/react-ui` 0.14.0, as of that file's 2026-06-30 revision on
 * `origin/main`). Copied rather than imported, for the same reason
 * `TITAN_MUSCLE_GROUPS` is: this repo does not depend on titan-design.
 *
 * These are POPULATION defaults, not this athlete's numbers — see the
 * `landmarkBasis` note at the top of this file.
 */
export const POPULATION_VOLUME_LANDMARKS: Readonly<Record<TitanMuscleGroup, VolumeLandmarks>> = {
  chest: { mev: 8, mav: 14, mrv: 20 },
  front_delts: { mev: 2, mav: 6, mrv: 10 },
  side_delts: { mev: 6, mav: 14, mrv: 22 },
  triceps: { mev: 4, mav: 8, mrv: 14 },
  lats: { mev: 8, mav: 14, mrv: 20 },
  upper_back: { mev: 6, mav: 12, mrv: 18 },
  rear_delts: { mev: 6, mav: 12, mrv: 18 },
  biceps: { mev: 4, mav: 10, mrv: 18 },
  forearms: { mev: 2, mav: 6, mrv: 12 },
  quads: { mev: 6, mav: 12, mrv: 18 },
  hamstrings: { mev: 4, mav: 10, mrv: 16 },
  glutes: { mev: 4, mav: 10, mrv: 16 },
  calves: { mev: 6, mav: 10, mrv: 16 },
  abs: { mev: 0, mav: 8, mrv: 16 },
  obliques: { mev: 0, mav: 6, mrv: 12 },
};

/** Weekly-volume status relative to the MEV/MAV/MRV landmarks (titan's `VolumeStatus`). */
export type VolumeStatus = 'under' | 'maintenance' | 'productive' | 'over';

/**
 * Weekly sets against the three landmarks, classified exactly as titan's
 * `zoneForSets` (`VolumeLandmarkBar.tsx`) does. Titan splits the MAV-to-MRV
 * band into `productive` and `approaching` for the heatmap fill, but
 * `approaching` is not a `VolumeStatus` — `getHeatmapColor` derives it at
 * render time from the separate `intensity` prop — so the whole band is
 * `productive` here.
 *
 * A muscle with `mev: 0` (abs, obliques) is therefore `maintenance` at zero
 * sets rather than `under`: titan's thresholds say a muscle whose minimum
 * effective volume is zero is never below it.
 */
export function classifyWeeklyVolume(
  sets: number,
  { mev, mav, mrv }: VolumeLandmarks,
): VolumeStatus {
  if (sets < mev) return 'under';
  if (sets < mav) return 'maintenance';
  if (sets >= mrv) return 'over';
  return 'productive';
}

/** One titan muscle group's weekly volume state. */
export interface MuscleWeekMuscleView {
  muscle: TitanMuscleGroup;
  /** Eligible working sets attributed to this muscle inside the week. */
  sets: number;
  status: VolumeStatus;
  landmarks: VolumeLandmarks;
  /**
   * `startedAt` of the most recent eligible set for this muscle at or before
   * the week's end — which may predate `weekStart`, so the figure can dim a
   * muscle by staleness. Null when no such set is in the rows the caller read.
   */
  lastTrainedAt: string | null;
}

export interface MuscleWeekView {
  /** Monday 00:00:00.000 UTC of the calendar week `now` falls in. */
  weekStart: string;
  muscleMapVersion: string;
  /** Always this literal: the landmarks are looked up, never discovered (VW-146). */
  landmarkBasis: 'population-default';
  /** Every titan slug (VW-328), zeros included, so the figure can paint every muscle. */
  muscles: MuscleWeekMuscleView[];
}

/** Everything `buildMuscleWeekView` needs, already read out of the store. */
export interface MuscleWeekRows {
  /**
   * Candidate sets. The caller may over-fetch — a trailing window wider than
   * the week is expected, and is what gives `lastTrainedAt` any depth; this
   * function applies the authoritative date/purpose/ownership/source filter, so
   * the caller never has to duplicate that rule.
   */
  sets: readonly StoredSet[];
  catalog: MuscleCatalogLookup;
  /** Any instant inside the week to report. The route's `?weekStart=` lands here. */
  now: Date;
  /**
   * Landmark table to classify against. Defaults to
   * {@link POPULATION_VOLUME_LANDMARKS}; overriding it is a test seam, and does
   * NOT change `landmarkBasis` — no caller may pass per-athlete numbers until
   * VW-146 defines what one is.
   */
  landmarks?: Readonly<Record<TitanMuscleGroup, VolumeLandmarks>>;
}

/** Lower bound for the `lastTrainedAt` scan: earlier than any ISO timestamp a set can carry. */
const BEFORE_ANY_SET = '';

interface MuscleTallies {
  sets: Map<TitanMuscleGroup, number>;
  lastTrainedAt: Map<TitanMuscleGroup, string>;
}

/**
 * One pass over the candidate sets: count the ones inside the week, and track
 * the latest eligible set at or before the week's end for `lastTrainedAt`.
 */
function tally(rows: MuscleWeekRows, weekStart: string, weekEnd: string): MuscleTallies {
  const tallies: MuscleTallies = { sets: new Map(), lastTrainedAt: new Map() };
  for (const set of rows.sets) {
    if (set.exerciseId === undefined) continue;
    if (!isEligibleWorkingSet(set, BEFORE_ANY_SET, weekEnd)) continue;
    const inWeek = set.startedAt >= weekStart;
    for (const muscle of titanMusclesFor(set.exerciseId, rows.catalog)) {
      if (inWeek) tallies.sets.set(muscle, (tallies.sets.get(muscle) ?? 0) + 1);
      const latest = tallies.lastTrainedAt.get(muscle);
      if (latest === undefined || set.startedAt > latest) {
        tallies.lastTrainedAt.set(muscle, set.startedAt);
      }
    }
  }
  return tallies;
}

/**
 * Shape one calendar week of recorded sets into per-muscle weekly volume
 * against the population landmarks (VW-329, B2).
 */
export function buildMuscleWeekView(rows: MuscleWeekRows): MuscleWeekView {
  const weekStart = startOfCalendarWeekIso(rows.now);
  const weekEnd = endOfCalendarWeekIso(weekStart);
  const landmarks = rows.landmarks ?? POPULATION_VOLUME_LANDMARKS;
  const tallies = tally(rows, weekStart, weekEnd);

  const muscles: MuscleWeekMuscleView[] = TITAN_MUSCLE_GROUPS.map((muscle) => {
    const sets = tallies.sets.get(muscle) ?? 0;
    return {
      muscle,
      sets,
      status: classifyWeeklyVolume(sets, landmarks[muscle]),
      landmarks: landmarks[muscle],
      lastTrainedAt: tallies.lastTrainedAt.get(muscle) ?? null,
    };
  });

  return {
    weekStart,
    muscleMapVersion: MUSCLE_MAP_VERSION,
    landmarkBasis: 'population-default',
    muscles,
  };
}
