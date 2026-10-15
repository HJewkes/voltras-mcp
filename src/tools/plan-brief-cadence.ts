// The planning brief's cadence advisories (VW-619): a tier-split accumulation-to-deload prior for
// the finishing block, a note when a declared advanced lifter's history argues against the tier,
// and rung 5 of the fatigue-reduction ladder, an active rest once or twice a year.
// rp:rp-s2-fatigue-reduction-ladder, rp:rp-s4-beginner-no-deload-for-months. Advisory copy only:
// every ratio here is a planning prior, and the trigger to deload stays performance-based.

import { addDays } from '../plan/block-calendar.js';
import type { StoredTrainingBlock } from '../store/types.js';
import type { BriefAdvisory } from './plan-brief-advisories.js';
import type { TierSignal } from './tier-signal.js';

const LADDER = 'rp:rp-s2-fatigue-reduction-ladder';
const BEGINNER_NO_DELOAD = 'rp:rp-s4-beginner-no-deload-for-months';
const RATIO_PRIOR = 'The ratio is a planning prior and the trigger stays performance-based.';

/** The long end of each tier's accumulation-to-deload ratio: 5:1 intermediate, 4:1 advanced. */
const ACCUMULATION_CEILING: Record<CadenceTier, number> = { intermediate: 5, advanced: 4 };

/** An intermediate with no deload on record commits to this many weeks, then extends. */
const UNKNOWN_TOLERANCE_WEEKS = 3;

/** Weeks without a deload that RP reads as evidence against an advanced claim (6 to 8). */
const ADVANCED_EVIDENCE_WEEKS = 6;

/** Rung 5 looks back a year, and only once there is half a year of dated blocks to look at. */
const ACTIVE_REST_WINDOW_DAYS = 365;
const ACTIVE_REST_MIN_HISTORY_DAYS = 182;

const DAY_MS = 24 * 60 * 60 * 1000;

export type CadenceTier = 'intermediate' | 'advanced';

/** One week of a block: whether it is a deload, and how many workouts it plans. */
export interface WeekShape {
  isDeload: boolean;
  templates: number;
  name?: string;
  phaseType?: string;
}

/** A block of the finishing block's program, up to and including it, in order. */
export interface BlockWeeks {
  block: StoredTrainingBlock;
  weeks: WeekShape[];
}

/** One calendar week of a dated block; `off` is a skipped week or a planned week with no workouts. */
export interface DatedWeek {
  isDeload: boolean;
  off: boolean;
  endsOn: string;
}

/** A dated block and its calendar weeks, for the active-rest look-back. */
export interface DatedBlockWeeks {
  startsOn: string;
  endsOn: string;
  weeks: DatedWeek[];
}

/**
 * The tier the cadence prior reads, or `null` when the clamped tier is beginner, who gets no
 * calendar cadence (rp:rp-s4-beginner-no-deload-for-months). The clamp never derives advanced,
 * so past the beginner clamp a declaration of advanced selects the 3:1 to 4:1 prior.
 */
export function cadenceTier(signal: Pick<TierSignal, 'tier' | 'declared'>): CadenceTier | null {
  if (signal.tier === 'beginner') return null;
  return signal.declared === 'advanced' ? 'advanced' : 'intermediate';
}

export function deloadCadenceAdvisory(
  finishing: StoredTrainingBlock,
  history: readonly BlockWeeks[],
  tier: CadenceTier,
): BriefAdvisory | null {
  const weeks = history.find((entry) => entry.block.id === finishing.id)?.weeks ?? [];
  const earlier = history.filter((entry) => entry.block.id !== finishing.id);
  const toleranceKnown = earlier.some((entry) => entry.weeks.some((week) => week.isDeload));
  const run = longestAccumulationRun(weeks);
  const hasDeload = weeks.some((week) => week.isDeload);
  const ceiling =
    tier === 'intermediate' && !toleranceKnown
      ? UNKNOWN_TOLERANCE_WEEKS
      : ACCUMULATION_CEILING[tier];
  if (weeks.length === 0 || (hasDeload && run <= ceiling)) return null;
  const shape = hasDeload
    ? `runs ${run} accumulation weeks before its deload`
    : `has ${run} weeks and no deload week`;
  return {
    kind: 'deload_cadence',
    exerciseId: null,
    text:
      `"${finishing.name}" ${shape}. ${tierPrior(tier, toleranceKnown)} ` +
      `${deloadRecord(history)} ${RATIO_PRIOR}`,
    rpIds: [LADDER, BEGINNER_NO_DELOAD],
  };
}

function tierPrior(tier: CadenceTier, toleranceKnown: boolean): string {
  const split = `The prior splits by tier, and a beginner has none (${BEGINNER_NO_DELOAD}).`;
  if (tier === 'advanced') {
    return (
      `For a declared advanced lifter it is 3:1 or 4:1 accumulation to deload (${LADDER}). ` +
      `${split} The one exception: still upright and still gaining at the end of week 4, add ` +
      'one more accumulation week rather than deloading on the calendar.'
    );
  }
  const unknown = toleranceKnown
    ? ''
    : ' No earlier block of this program closed on a deload week, so the tolerance is ' +
      'unknown: commit to 3 accumulation weeks, then extend week by week while performance holds.';
  return `For an intermediate it is 4:1 or 5:1 accumulation to deload (${LADDER}). ${split}${unknown}`;
}

/** A declared advanced lifter whose program shows 6 or more weeks in a row with no deload. */
export function tierEvidenceAdvisory(history: readonly BlockWeeks[]): BriefAdvisory | null {
  const run = longestAccumulationRun(history.flatMap((entry) => entry.weeks));
  if (run < ADVANCED_EVIDENCE_WEEKS) return null;
  return {
    kind: 'tier_evidence',
    exerciseId: null,
    text:
      `This program's history runs ${run} weeks in a row with no deload week. At the advanced ` +
      'tier, 6 to 8 weeks without a deload is evidence the lifter is not training at an ' +
      `advanced level or not hard enough (${LADDER}). It is evidence against the declared tier, ` +
      `not a change to it: the tier stays as declared. ${RATIO_PRIOR}`,
    rpIds: [LADDER],
  };
}

/** Rung 5: no ended deload week followed by an ended off week in the last year of dated blocks. */
export function activeRestAdvisory(
  blocks: readonly DatedBlockWeeks[],
  today: string,
): BriefAdvisory | null {
  const since = addDays(today, -ACTIVE_REST_WINDOW_DAYS);
  const ordered = [...blocks].sort((a, b) => a.startsOn.localeCompare(b.startsOn));
  const first = ordered[0];
  if (first === undefined || first.startsOn > addDays(today, -ACTIVE_REST_MIN_HISTORY_DAYS)) {
    return null;
  }
  const inWindow = ordered.filter((b) => b.endsOn >= since && b.startsOn <= today);
  if (hasActiveRest(weekSequence(inWindow, today))) return null;
  return {
    kind: 'active_rest',
    exerciseId: null,
    text:
      `No active rest shows in the dated blocks since ${since}: no deload week followed by a ` +
      'week fully off. RP places one, about two weeks (a deload week, then a week off), once or ' +
      `twice a year, as the last rung of the fatigue-reduction ladder (${LADDER}). The ` +
      'once-a-year cadence is a planning prior and the trigger stays performance-based.',
    rpIds: [LADDER],
  };
}

type WeekKind = 'deload' | 'off' | 'train';

/**
 * Each block's ended weeks in order, with any whole weeks between blocks (and after the last,
 * up to today) as off. A week that has not ended has not happened, so it counts as nothing.
 */
function weekSequence(blocks: readonly DatedBlockWeeks[], today: string): WeekKind[] {
  const sequence: WeekKind[] = [];
  blocks.forEach((block, i) => {
    sequence.push(...block.weeks.filter((week) => week.endsOn < today).map(weekKind));
    const nextStart = blocks[i + 1]?.startsOn ?? today;
    const gapDays = daysBetween(block.endsOn, nextStart) - 1;
    for (let w = 0; w < Math.floor(gapDays / 7); w++) sequence.push('off');
  });
  return sequence;
}

function weekKind(week: DatedWeek): WeekKind {
  if (week.isDeload) return 'deload';
  return week.off ? 'off' : 'train';
}

function hasActiveRest(sequence: readonly WeekKind[]): boolean {
  return sequence.some((kind, i) => kind === 'deload' && sequence[i + 1] === 'off');
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

function longestAccumulationRun(weeks: readonly WeekShape[]): number {
  let longest = 0;
  let current = 0;
  for (const week of weeks) {
    current = week.isDeload ? 0 : current + 1;
    longest = Math.max(longest, current);
  }
  return longest;
}

/** The lifter's own record: how many of the program's blocks so far planned a deload week. */
function deloadRecord(history: readonly BlockWeeks[]): string {
  const withDeload = history.filter((entry) => entry.weeks.some((week) => week.isDeload)).length;
  return `${withDeload} of this program's ${history.length} blocks planned a deload week.`;
}
