// The goal horizon's weeks with their block ordinals (VW-510). PURE: goal derivation reads the
// planned blocks and the goal ramp sim varies the undated block length.

import type { GoalBandWeek } from './goal-band.js';

/**
 * The block length an undated stretch of the horizon is split into, so a later week ramps at the
 * later-block rate (VW-510). HUMAN DECISION 2026-09-26 (VW-510): the owner chose 5 weeks over 4
 * and 6 from the goal ramp sim (`npm run sim:goal-ramp`), the middle of RP's 4-to-6-week run.
 */
export const UNDATED_MESO_WEEKS = 5;

/**
 * The planned blocks' weeks in order, each carrying its block's ordinal, then undated weeks split
 * into `mesoWeeks`-week blocks until `length` is reached, truncated to `length`. Pure, so the goal
 * ramp sim can vary `mesoWeeks`.
 */
export function horizonWeeksOf(
  blocks: readonly (readonly boolean[])[],
  length: number,
  mesoWeeks: number = UNDATED_MESO_WEEKS,
): GoalBandWeek[] {
  const weeks = blocks.flatMap((rows, blockOrdinal) =>
    rows.map((isDeload) => ({ isDeload, blockOrdinal })),
  );
  const planned = weeks.length;
  for (let undated = 0; planned + undated < length; undated++) {
    weeks.push({ isDeload: false, blockOrdinal: blocks.length + Math.floor(undated / mesoWeeks) });
  }
  return weeks.slice(0, length).map((week, index) => ({ index: index + 1, ...week }));
}
