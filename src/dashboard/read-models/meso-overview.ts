// Meso-overview read-model: the pure week-view derivation behind
// `GET /api/meso-overview`.
//
// `server.ts` walks the plan store (program → block → week → template) into raw
// per-week rollups; this module normalizes them into the titan `WeekRow` view —
// per-week intensity relative to the block peak, deload flagging, and
// current/upcoming/completed workout status. Pure and I/O-free, so the
// volume/status math is unit-testable on its own. Plan metadata only (NF-07).

/** One workout in a meso week, tagged with its progress relative to the plan. */
export interface MesoWorkoutView {
  name: string;
  status: 'completed' | 'current' | 'upcoming';
}

/** One week of the active mesocycle, shaped for titan `WeekRow`. */
export interface MesoWeekView {
  /** 1-based week index within the block. */
  weekNumber: number;
  /** The first week that still has unfinished work (the lifter's live week). */
  isCurrent: boolean;
  /** Week whose name marks it a deload (rendered with the deload treatment). */
  isDeload: boolean;
  /** Planned volume (total target sets) normalized to the block's peak week, 0-1. */
  intensityLevel: number;
  workouts: MesoWorkoutView[];
}

/** The active mesocycle's week-by-week overview (titan `WeekRow` stack). */
export interface MesoOverviewView {
  mesoName: string;
  focus?: string;
  totalWeeks: number;
  weeks: MesoWeekView[];
}

/** Raw per-week rollup before the block-relative view derivation. */
export interface RawMesoWeek {
  orderIndex: number;
  name?: string;
  /** Total planned target sets across the week's templates. */
  volume: number;
  templates: Array<{ name: string; done: boolean }>;
}

/**
 * Derive the titan-ready week views from raw block weeks: normalize each week's
 * planned volume to the block's peak (the intensity bar), flag the deload weeks
 * by name, mark the first week with unfinished work as current, and tag the very
 * first unfinished workout `current` (the rest `upcoming`, done ones `completed`).
 * Pure — no store I/O — so the volume/status math is unit-testable on its own.
 */
export function deriveMesoWeekViews(rawWeeks: RawMesoWeek[]): MesoWeekView[] {
  const sorted = [...rawWeeks].sort((a, b) => a.orderIndex - b.orderIndex);
  const maxVolume = sorted.reduce((max, w) => Math.max(max, w.volume), 0);
  const currentWeekOrder = sorted.find((w) => w.templates.some((t) => !t.done))?.orderIndex ?? -1;
  let currentTagged = false;
  return sorted.map((week) => ({
    weekNumber: week.orderIndex + 1,
    isCurrent: week.orderIndex === currentWeekOrder,
    isDeload: /deload/i.test(week.name ?? ''),
    intensityLevel: maxVolume > 0 ? week.volume / maxVolume : 0,
    workouts: week.templates.map((t) => {
      if (t.done) return { name: t.name, status: 'completed' as const };
      if (!currentTagged) {
        currentTagged = true;
        return { name: t.name, status: 'current' as const };
      }
      return { name: t.name, status: 'upcoming' as const };
    }),
  }));
}
