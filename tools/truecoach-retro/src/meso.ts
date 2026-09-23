// Meso segmentation, the approved simple rule: a 10% load drop on two main lifts in one week, or a
// 10-day gap, ends a meso. Inferred, not RP's: the log carries no meso labels.

import { trainingGaps } from '../../../src/analytics/training-days.js';

import { addDays, daysBetween, isoWeekStart } from './dates.js';

export const MESO_RULE = { dropPct: 10, liftsDropping: 2, gapDays: 10 } as const;

export interface LoadDrop {
  lift: string;
  /** Percent under the lift's previous trained week, unrounded. */
  pct: number;
}

export interface MesoBoundary {
  /** Monday of the first week of the new meso. */
  week: string;
  triggers: string[];
  /** The gap that ended the meso, or `null` when a load drop alone did. */
  gapDays: number | null;
  /** The lifts that dropped, when the load half of the rule fired; empty otherwise. */
  drops: LoadDrop[];
}

export interface Meso {
  startWeek: string;
  /** Monday of the week after the meso's last week. */
  endWeek: string;
  weeks: number;
  /** Weeks inside the meso holding at least one training day; a gap's empty weeks do not count. */
  trainedWeeks: number;
}

/** Weeks where a lift's top load fell at least `dropPct` below its previous trained week. */
export function loadDropWeeks(
  topLoadsByLift: ReadonlyMap<string, ReadonlyMap<string, number>>,
  dropPct: number = MESO_RULE.dropPct,
): Map<string, LoadDrop[]> {
  const drops = new Map<string, LoadDrop[]>();
  for (const [lift, weeks] of topLoadsByLift) {
    const ordered = [...weeks].sort(([a], [b]) => a.localeCompare(b));
    ordered.slice(1).forEach(([week, load], index) => {
      const previous = ordered[index]![1];
      const pct = ((previous - load) / previous) * 100;
      if (pct >= dropPct) drops.set(week, [...(drops.get(week) ?? []), { lift, pct }]);
    });
  }
  return drops;
}

function boundaryAt(boundaries: Map<string, MesoBoundary>, week: string): MesoBoundary {
  const boundary = boundaries.get(week) ?? { week, triggers: [], gapDays: null, drops: [] };
  boundaries.set(week, boundary);
  return boundary;
}

function dropTrigger(drops: readonly LoadDrop[]): string {
  const lifts = [...drops].sort((a, b) => a.lift.localeCompare(b.lift));
  return `load drop: ${lifts.map((d) => `${d.lift} -${Math.round(d.pct)}%`).join(', ')}`;
}

/** Every boundary the rule finds, oldest first; triggers landing in one week merge. */
export function mesoBoundaries(
  days: readonly string[],
  topLoadsByLift: ReadonlyMap<string, ReadonlyMap<string, number>>,
): MesoBoundary[] {
  const boundaries = new Map<string, MesoBoundary>();
  for (const [week, drops] of loadDropWeeks(topLoadsByLift)) {
    if (drops.length < MESO_RULE.liftsDropping) continue;
    const boundary = boundaryAt(boundaries, week);
    boundary.drops = [...drops].sort((a, b) => a.lift.localeCompare(b.lift));
    boundary.triggers.push(dropTrigger(drops));
  }
  for (const gap of trainingGaps(days)) {
    if (gap.days < MESO_RULE.gapDays) continue;
    const boundary = boundaryAt(boundaries, isoWeekStart(gap.endsOn));
    boundary.gapDays = gap.days;
    boundary.triggers.push(`gap ${gap.days} days`);
  }
  return [...boundaries.values()].sort((a, b) => a.week.localeCompare(b.week));
}

/** The mesos between the first training week, each boundary, and the week after the last day. */
export function mesosBetween(days: readonly string[], boundaries: readonly MesoBoundary[]): Meso[] {
  if (days.length === 0) return [];
  const first = isoWeekStart(days[0]!);
  const afterLast = isoWeekStart(days.at(-1)!);
  const edges = [first, ...boundaries.map((b) => b.week).filter((w) => w > first)];
  const ends = [...edges.slice(1), addDays(afterLast, 7)];
  const trained = new Set(days.map(isoWeekStart));
  return edges.map((startWeek, index) => {
    const endWeek = ends[index]!;
    const inside = [...trained].filter((week) => week >= startWeek && week < endWeek);
    return {
      startWeek,
      endWeek,
      weeks: daysBetween(startWeek, endWeek) / 7,
      trainedWeeks: inside.length,
    };
  });
}

/** RP's 3:1 to 5:1: three to five accumulation weeks plus a deload, so a meso of four to six weeks. */
export function classifyMesoLength(weeks: number): 'short' | 'within 3:1 to 5:1' | 'long' {
  if (weeks < 4) return 'short';
  return weeks <= 6 ? 'within 3:1 to 5:1' : 'long';
}
