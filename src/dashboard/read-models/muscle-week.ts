// Pure read-model for the body-map plan's "weekly sets per muscle vs landmarks"
// affordance (VW-329, B2 of the body-map plan). `buildMuscleWeekView` shapes one
// calendar week of recorded sets into one row per titan muscle group: working
// sets this week, the population volume landmarks, the status those two imply,
// and when the muscle was last trained. It performs NO I/O: the caller
// (`dashboard/server.ts`'s `serveMuscleWeek`) owns the store reads, this module
// owns the output shape — the same split `read-models/plan-tree.ts` uses.
//
// TARGET-ONLY (B47, VMCP-06.05): `sets`, `status` and `sessions` count a set
// toward its exercise's TARGET muscles only, from the attribution table
// (`exercises/seed-attribution.ts`, VW-561), which splits the delts by head.
// Secondary muscles never reach those fields, at any weight.
//
// DOSE (VW-561): `dose` sums each muscle's weight (1, 0.5 or 0; Pelland et al.
// 2025) as a comparison. It is never classified against a landmark.
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
import { dayFrequencyCredit, type SlugAttribution } from '../../exercises/muscle-attribution.js';
import {
  attributionFor,
  endOfCalendarWeekIso,
  isEligibleWorkingSet,
  startOfCalendarWeekIso,
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

/**
 * Muscles that show sets but no band: RP publishes their glute and back
 * landmarks only as images nobody has read yet, so no verdict is drawn from
 * the defaults (VW-561 R8c; back added by the owner on 2026-09-26).
 */
export const LANDMARK_VERDICT_WITHHELD: ReadonlySet<TitanMuscleGroup> = new Set([
  'glutes',
  'lats',
  'upper_back',
]);

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

/** The dose read for one muscle's week: a comparison, never a verdict. */
export interface MuscleWeekDose {
  /** Eligible working sets times each set's weight for this muscle. */
  sets: number;
  /** 1 per day with a target set, 0.5 per day that hit the muscle only through a weighted row. */
  sessions: number;
}

/** One titan muscle group's weekly volume state. */
export interface MuscleWeekMuscleView {
  muscle: TitanMuscleGroup;
  /** Eligible working sets of exercises that target this muscle, inside the week. */
  sets: number;
  /** The landmark band of `sets`; `null` where the landmark is unverified (glutes, lats, upper back). */
  status: VolumeStatus | null;
  landmarks: VolumeLandmarks;
  /** UTC days this week holding an eligible set of an exercise that targets this muscle (Q5). */
  sessions: number;
  dose: MuscleWeekDose;
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
  dose: Map<TitanMuscleGroup, number>;
  lastTrainedAt: Map<TitanMuscleGroup, string>;
  /** The attribution of every exercise trained on each UTC day of the week. */
  days: Map<string, SlugAttribution[][]>;
}

const add = (map: Map<TitanMuscleGroup, number>, muscle: TitanMuscleGroup, n: number) =>
  map.set(muscle, (map.get(muscle) ?? 0) + n);

function countInWeek(tallies: MuscleTallies, set: StoredSet, rows: SlugAttribution[]): void {
  for (const row of rows) {
    if (row.target) add(tallies.sets, row.muscle, 1);
    if (row.weight > 0) add(tallies.dose, row.muscle, row.weight);
  }
  const day = set.startedAt.slice(0, 10);
  tallies.days.set(day, [...(tallies.days.get(day) ?? []), rows]);
}

/**
 * One pass over the candidate sets: count the ones inside the week in both
 * reads, and track the latest target set at or before the week's end.
 */
function tally(rows: MuscleWeekRows, weekStart: string, weekEnd: string): MuscleTallies {
  const tallies: MuscleTallies = {
    sets: new Map(),
    dose: new Map(),
    lastTrainedAt: new Map(),
    days: new Map(),
  };
  for (const set of rows.sets) {
    if (set.exerciseId === undefined) continue;
    if (!isEligibleWorkingSet(set, BEFORE_ANY_SET, weekEnd)) continue;
    const attribution = attributionFor(set.exerciseId, rows.catalog);
    if (set.startedAt >= weekStart) countInWeek(tallies, set, attribution);
    for (const row of attribution) {
      if (!row.target) continue;
      const latest = tallies.lastTrainedAt.get(row.muscle);
      if (latest === undefined || set.startedAt > latest) {
        tallies.lastTrainedAt.set(row.muscle, set.startedAt);
      }
    }
  }
  return tallies;
}

/** Landmark sessions (credit 1 only) and dose sessions (every credit) per muscle. */
function sessionCounts(days: MuscleTallies['days']) {
  const landmark = new Map<TitanMuscleGroup, number>();
  const dose = new Map<TitanMuscleGroup, number>();
  for (const exercises of days.values()) {
    for (const [muscle, credit] of dayFrequencyCredit(exercises)) {
      if (credit === 1) add(landmark, muscle, 1);
      add(dose, muscle, credit);
    }
  }
  return { landmark, dose };
}

/** The landmark band, withheld where the landmark is unverified (VW-561 R8c). */
function statusOf(
  muscle: TitanMuscleGroup,
  sets: number,
  landmarks: VolumeLandmarks,
): VolumeStatus | null {
  return LANDMARK_VERDICT_WITHHELD.has(muscle) ? null : classifyWeeklyVolume(sets, landmarks);
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
  const sessions = sessionCounts(tallies.days);

  const muscles: MuscleWeekMuscleView[] = TITAN_MUSCLE_GROUPS.map((muscle) => {
    const sets = tallies.sets.get(muscle) ?? 0;
    return {
      muscle,
      sets,
      status: statusOf(muscle, sets, landmarks[muscle]),
      landmarks: landmarks[muscle],
      sessions: sessions.landmark.get(muscle) ?? 0,
      dose: {
        sets: tallies.dose.get(muscle) ?? 0,
        sessions: sessions.dose.get(muscle) ?? 0,
      },
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
