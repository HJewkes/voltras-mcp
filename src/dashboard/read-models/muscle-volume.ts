// Muscle-volume read-model: the pure aggregation behind `GET /api/muscle-volume`.
//
// `server.ts` gathers the trailing-window sessions, resolves each to its exercise
// catalog muscles + set count, and hands the plain entries here; this function
// sums effective sets per muscle. Pure and I/O-free — the weekly windowing and
// store access stay in the caller. Derived fitness metadata only (NF-07).

/** One in-window session resolved to its catalog muscles + working-set count. */
export interface MuscleVolumeEntry {
  /** Working sets recorded in the session. */
  setCount: number;
  /** Primary muscles worked (each counts a full set). */
  primaryMuscles: readonly string[];
  /** Secondary muscles worked (each counts a half set). */
  secondaryMuscles: readonly string[];
}

/** Secondary muscles count as a fraction of a working set (standard heuristic). */
export const SECONDARY_SET_WEIGHT = 0.5;

/**
 * Effective sets per muscle: each entry's set count is attributed to its primary
 * muscles (full) and secondary muscles (half). The client maps these onto titan's
 * volume landmarks.
 */
export function buildMuscleVolume(entries: readonly MuscleVolumeEntry[]): Record<string, number> {
  const volume: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.setCount === 0) continue;
    for (const muscle of entry.primaryMuscles) {
      volume[muscle] = (volume[muscle] ?? 0) + entry.setCount;
    }
    for (const muscle of entry.secondaryMuscles) {
      volume[muscle] = (volume[muscle] ?? 0) + entry.setCount * SECONDARY_SET_WEIGHT;
    }
  }
  return volume;
}
