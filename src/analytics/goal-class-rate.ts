// The later-block rate a goal ramp slows to, from the lifter's own history (VW-510).
//
// PURE. The caller reads the lift series and the dated blocks; this module only asks WA's
// `progressionRateByClass` for the start-to-start slope of one ramp class and decides whether
// there is enough behind it to call it MEASURED. Start to start, never in-block: a lift can
// climb every week inside a block and still restart each block where the last one started,
// and a projection across blocks needs the second rate.

import {
  progressionRateByClass,
  type ProgressionBlock,
  type ProgressionSeriesInput,
} from '@voltras/workout-analytics';

import { GOAL_BAND_CONSTANTS, type GoalLaterBlockRate, type RampClass } from './goal-band.js';
import type { Tier } from '../tools/tier-signal.js';

/**
 * Sessions and blocks a measured start-to-start class slope needs before it replaces the default.
 *
 * ENGINEERING DEFAULT (design 4.3, VW-558). Two blocks is the least a start-to-start slope can be
 * fitted through; eight sessions is two 4-week blocks at one session a week.
 */
export const CLASS_RATE_GATE = { minSessions: 8, minBlocks: 2 } as const;

/** The two rows of WA's answer this module reads; the package's .d.ts degrades them to `any`. */
interface ClassRates {
  byLift: {
    classKey: string;
    sessions: number;
    blocks: number;
    startToStartPctPerWeek: number | null;
  }[];
  byClass: { classKey: string; startToStart: { median: number } | null }[];
}

export interface ClassRateInput {
  series: readonly ProgressionSeriesInput[];
  blocks: readonly ProgressionBlock[];
  classOf: (lift: string) => RampClass | null;
  rampClass: RampClass;
  tier: Tier;
}

/**
 * The measured start-to-start slope for `rampClass` when the gate passes, else the default:
 * `laterBlockClassFraction` of the tier's class percent, labelled ENGINEERING DEFAULT. Both are
 * percent of the start value per week, the class step's own unit.
 */
export function laterBlockRateOf(input: ClassRateInput): GoalLaterBlockRate {
  const rates: ClassRates = progressionRateByClass(input.series, input.blocks, input.classOf);
  const lifts = rates.byLift.filter(
    (lift) => lift.classKey === input.rampClass && lift.startToStartPctPerWeek !== null,
  );
  const sessions = lifts.reduce((sum, lift) => sum + lift.sessions, 0);
  const blocks = Math.max(0, ...lifts.map((lift) => lift.blocks));
  const summary = rates.byClass.find((row) => row.classKey === input.rampClass)?.startToStart;
  const gated = sessions >= CLASS_RATE_GATE.minSessions && blocks >= CLASS_RATE_GATE.minBlocks;
  if (summary !== null && summary !== undefined && gated) {
    return { value: summary.median, source: 'MEASURED', n: sessions };
  }
  const classPct = GOAL_BAND_CONSTANTS.rampIncrementPctByTier[input.tier][input.rampClass];
  return {
    value: classPct * GOAL_BAND_CONSTANTS.laterBlockClassFraction,
    source: 'ENGINEERING DEFAULT',
    n: sessions,
  };
}
