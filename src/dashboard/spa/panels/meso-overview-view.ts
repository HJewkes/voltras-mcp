/**
 * Meso-overview view wiring — maps the sidecar's `/api/meso-overview` weeks onto
 * titan `WeekRow` prop shapes for the dashboard's mesocycle panel.
 *
 * Thin app-side glue: the server derives the exact per-week volume + workout
 * status (see `fetchMesoOverview`); titan renders the week rows (workout pills +
 * intensity bar + deload/current treatment). Passes values straight through and
 * threads the block's `totalWeeks` onto each row. Titan imports are TYPES only
 * (erased at build), so this runs in the node test environment.
 *
 * Confidentiality: plan metadata only; no protocol data (NF-07).
 */
import type { WeekRowProps } from '@titan-design/react-ui';

/** One workout on a meso week, matching the `/api/meso-overview` response. */
export interface MesoWorkoutView {
  name: string;
  status: 'completed' | 'current' | 'upcoming';
}

/** One week of the active mesocycle, matching the `/api/meso-overview` response. */
export interface MesoWeekView {
  weekNumber: number;
  isCurrent: boolean;
  isDeload: boolean;
  /** Planned volume normalized to the block's peak week, 0-1. */
  intensityLevel: number;
  workouts: MesoWorkoutView[];
}

/** The active mesocycle overview, matching the `/api/meso-overview` response. */
export interface MesoOverviewView {
  mesoName: string;
  focus?: string;
  totalWeeks: number;
  weeks: MesoWeekView[];
}

/**
 * Map each meso week onto titan `WeekRow` props — exact values through, with the
 * block's `totalWeeks` threaded onto every row (WeekRow renders "W{n}" against
 * the total). Empty in → empty out (the panel hides).
 */
export function toWeekRowPropsList(meso: MesoOverviewView): WeekRowProps[] {
  return meso.weeks.map((week) => ({
    weekNumber: week.weekNumber,
    totalWeeks: meso.totalWeeks,
    workouts: week.workouts.map((w) => ({ name: w.name, status: w.status })),
    intensityLevel: week.intensityLevel,
    isCurrent: week.isCurrent,
    isDeload: week.isDeload,
  }));
}
