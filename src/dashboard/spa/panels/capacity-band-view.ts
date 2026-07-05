/**
 * Capacity-band view wiring — maps the sidecar's `/api/capacity-band` points onto
 * titan `CapacityBandChart` prop shapes for the dashboard history rail.
 *
 * Thin app-side glue of the model↔render split: the exact strength estimate + its
 * ±k·σ corridor come from WA's `StateSpaceStrengthModel` (folded server-side, see
 * `coordination/architecture/capacity-band-model-2026-07-04.md`); titan renders the
 * shaded band + session dots. Passes EXACT values into the prop shapes — no
 * pre-rounding. Titan imports are TYPES only (erased at build), so this runs in the
 * node test environment.
 *
 * NDA: reads derived fitness metadata only; no protocol data (NF-07).
 */
import type { CapacityBandDataPoint, WorkoutDot, WorkoutDotStatus } from '@titan-design/react-ui';

/** One capacity-band point, matching the `/api/capacity-band` response shape. */
export interface CapacityBandPoint {
  /** ISO timestamp of the session. */
  date: string;
  /** WA smoothed latent-strength estimate (lbs) after this session. */
  estimate: number;
  /** Lower corridor bound (`estimate − k·√variance`). */
  bandLow: number;
  /** Upper corridor bound (`estimate + k·√variance`). */
  bandHigh: number;
  /** The session's observed best e1RM (lbs) — the plotted dot's load. */
  e1rm: number;
}

/** titan `CapacityBandChart`'s two data props, split from the point series. */
export interface CapacityBandChartData {
  band: CapacityBandDataPoint[];
  workouts: WorkoutDot[];
}

/** Where the observed e1RM sits relative to its corridor (drives dot color). */
function dotStatus(point: CapacityBandPoint): WorkoutDotStatus {
  if (point.e1rm < point.bandLow) return 'below';
  if (point.e1rm > point.bandHigh) return 'above';
  return 'within';
}

/**
 * titan's `CapacityBandChart` parses each `date` by splitting on `-` and expects a
 * calendar `YYYY-MM-DD` string — a full ISO timestamp's third split part is garbage,
 * so its time-axis position collapses to NaN and its label reads `M/NaN`. Sessions
 * carry full ISO timestamps, so truncate to the date component for titan (both the
 * band point and its dot must share the format so they align on the x-axis).
 */
function toBandDate(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Split the capacity-band series into titan's `band` (shaded corridor) and
 * `workouts` (session dots) props. Exact values straight through — titan positions
 * and colors; only the date is reshaped to titan's calendar-string form. Empty in →
 * empty out (the panel hides).
 */
export function toCapacityBandChartData(points: CapacityBandPoint[]): CapacityBandChartData {
  return {
    band: points.map((p) => ({
      date: toBandDate(p.date),
      bandLow: p.bandLow,
      bandHigh: p.bandHigh,
    })),
    workouts: points.map((p) => ({
      date: toBandDate(p.date),
      load: p.e1rm,
      status: dotStatus(p),
    })),
  };
}
