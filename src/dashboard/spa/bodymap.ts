/**
 * Muscle-heatmap model for the dashboard BodyMap (Phase 3 — VMCP-01.47).
 *
 * Maps the voltras exercise-catalog muscle strings (`'chest'`, `'shoulders'`,
 * `'triceps'`, …) onto titan-design's `MuscleGroup` taxonomy and derives the
 * live `BodyMapData[]` the SVG heatmap consumes.
 *
 * This module imports the titan barrel (for the `MuscleGroup` enum + types),
 * which transitively pulls `react-native-body-highlighter` / `react-native-svg`.
 * That resolves only under the SPA's vite build (see vite-rn-svg-plugins.ts), so
 * it is imported EXCLUSIVELY from the `.tsx` panel — never from `adapter.ts` or
 * any node-vitest `.ts`, which would load the native RN sources and crash.
 *
 * NDA: derived purely from `/api/snapshot` JSON muscle metadata — no protocol
 * data crosses this boundary.
 */
import {
  DEFAULT_VOLUME_LANDMARKS,
  MUSCLE_DISPLAY_NAMES,
  MuscleGroup,
  type BodyMapData,
} from '@titan-design/react-ui/bodymap';
import { classifyWeeklyVolume } from '@voltras/workout-analytics';
import type { SnapshotActiveExercise } from './adapter';
import { compareVolumeChips, toChipVolumeStatus, type VolumeStatusChip } from './volume-status';

/**
 * The volume-status enum BodyMap's data actually expects. Derived from
 * `BodyMapData` because the titan barrel exports two colliding `VolumeStatus`
 * types (the muscle-taxonomy one — used here — and an unrelated token variant).
 */
type BodyMapStatus = BodyMapData['volumeStatus'];

/**
 * Live-intensity semantics (v1): a muscle worked by the CURRENT exercise is lit
 * `productive`; PRIMARY muscles burn at {@link PRIMARY_INTENSITY} (≥ 0.85 →
 * titan's brighter `approaching` heatmap token) and SECONDARY at
 * {@link SECONDARY_INTENSITY} (the medium `productive` token). Idle / no active
 * exercise yields an empty map (plain body outline). This mirrors the objective:
 * during "Cable Chest Press" the chest reads primary-hot with shoulders/triceps
 * secondary.
 */
export const PRIMARY_INTENSITY = 0.85;
export const SECONDARY_INTENSITY = 0.45;

/** Volume status painted while a muscle is being trained this session. */
const ACTIVE_STATUS: BodyMapStatus = 'productive';

/**
 * voltras catalog muscle string → a single representative titan `MuscleGroup`.
 * The dashboard renders the BodyMap in `simple` mode, so the representative only
 * needs to resolve to the right SVG region + simplified legend name (e.g. any
 * deltoid → the shared `deltoids` slug / "Shoulders"). Groups voltras tracks
 * coarsely (`core`, `abductors`, `adductors`) fold onto their closest slug.
 */
const VOLTRAS_TO_MUSCLE: Record<string, MuscleGroup> = {
  chest: MuscleGroup.CHEST,
  shoulders: MuscleGroup.SIDE_DELTS,
  triceps: MuscleGroup.TRICEPS,
  back: MuscleGroup.LATS,
  biceps: MuscleGroup.BICEPS,
  traps: MuscleGroup.UPPER_BACK,
  forearms: MuscleGroup.FOREARMS,
  core: MuscleGroup.ABS,
  abs: MuscleGroup.ABS,
  obliques: MuscleGroup.OBLIQUES,
  quads: MuscleGroup.QUADS,
  hamstrings: MuscleGroup.HAMSTRINGS,
  glutes: MuscleGroup.GLUTES,
  calves: MuscleGroup.CALVES,
  abductors: MuscleGroup.GLUTES,
  adductors: MuscleGroup.QUADS,
};

/** Resolve a voltras muscle string to its titan group (case/space tolerant). */
function toMuscleGroup(raw: string): MuscleGroup | null {
  return VOLTRAS_TO_MUSCLE[raw.trim().toLowerCase()] ?? null;
}

/**
 * Build the live BodyMap heatmap data from the active exercise's target muscles.
 *
 * PRIMARY muscles win over SECONDARY when both resolve to the same group (the
 * higher intensity is kept). `weeklySets` carries the session's completed-set
 * count — every set so far targets the active exercise — so the muscle-legend
 * a11y label reads "N sets this session". Returns `[]` when idle / no exercise.
 */
export function buildBodyMapData(
  activeExercise: SnapshotActiveExercise | null | undefined,
  sessionSetCount: number,
): BodyMapData[] {
  if (!activeExercise) return [];

  const byGroup = new Map<MuscleGroup, BodyMapData>();

  const add = (raw: string, intensity: number): void => {
    const group = toMuscleGroup(raw);
    if (group === null) return;
    const existing = byGroup.get(group);
    if (existing && existing.intensity >= intensity) return;
    byGroup.set(group, {
      muscleGroup: group,
      intensity,
      volumeStatus: ACTIVE_STATUS,
      weeklySets: sessionSetCount,
    });
  };

  for (const raw of activeExercise.primaryMuscles) add(raw, PRIMARY_INTENSITY);
  for (const raw of activeExercise.secondaryMuscles) add(raw, SECONDARY_INTENSITY);

  return Array.from(byGroup.values());
}

/**
 * Build the WEEKLY-volume heatmap from `/api/muscle-volume` (effective sets per
 * voltras muscle string over the trailing week). Each muscle's `volumeStatus`
 * comes from titan's MEV/MAV/MRV landmarks (getHeatmapColor paints under=cool →
 * over=hot); `intensity` scales the fill toward MRV. Multiple voltras strings
 * that fold onto one titan group have their sets summed. Empty input (no recent
 * training) yields a plain body outline.
 */
/**
 * Fold the voltras per-muscle-string weekly set counts onto titan `MuscleGroup`s,
 * summing strings that share a group and dropping zero/empty entries. Shared by
 * the heatmap ({@link buildWeeklyVolumeData}) and the chip list
 * ({@link buildVolumeStatusChips}) so both read the same grouping.
 */
function groupWeeklySets(weeklySetsByMuscle: Record<string, number>): Map<MuscleGroup, number> {
  const byGroup = new Map<MuscleGroup, number>();
  for (const [raw, sets] of Object.entries(weeklySetsByMuscle)) {
    const group = toMuscleGroup(raw);
    if (group === null || !(sets > 0)) continue;
    byGroup.set(group, (byGroup.get(group) ?? 0) + sets);
  }
  return byGroup;
}

export function buildWeeklyVolumeData(weeklySetsByMuscle: Record<string, number>): BodyMapData[] {
  return Array.from(groupWeeklySets(weeklySetsByMuscle).entries()).map(([group, sets]) => {
    const landmarks = DEFAULT_VOLUME_LANDMARKS[group];
    return {
      muscleGroup: group,
      intensity: Math.min(1, sets / landmarks.mrv),
      volumeStatus: classifyWeeklyVolume(sets, landmarks),
      weeklySets: Math.round(sets),
    };
  });
}

/**
 * Build the weekly volume-status chip list from the same `/api/muscle-volume`
 * data the heatmap uses — a compact "which muscles are under/over this week"
 * summary rendered as titan `MuscleGroupChip`s. Reuses the landmark
 * classification (no new computation); returns attention-ordered chips (see
 * {@link compareVolumeChips}). Empty input yields `[]`.
 */
export function buildVolumeStatusChips(
  weeklySetsByMuscle: Record<string, number>,
): VolumeStatusChip[] {
  return Array.from(groupWeeklySets(weeklySetsByMuscle).entries())
    .map(([group, sets]) => {
      const landmarks = DEFAULT_VOLUME_LANDMARKS[group];
      return {
        muscleGroup: String(group),
        name: MUSCLE_DISPLAY_NAMES[group] ?? String(group),
        status: toChipVolumeStatus(classifyWeeklyVolume(sets, landmarks)),
        weeklySets: Math.round(sets),
      };
    })
    .sort(compareVolumeChips);
}
