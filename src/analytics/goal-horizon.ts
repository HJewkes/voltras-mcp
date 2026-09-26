// The goal horizon's weeks with their block ordinals (VW-510). PURE: goal derivation reads the
// planned blocks and the goal ramp sim varies the undated block length.

import type { GoalBandWeek } from './goal-band.js';

/**
 * The block length an undated stretch of the horizon is split into, so a later week ramps at the
 * later-block rate (VW-510). ENGINEERING DEFAULT, not an owner decision yet: the middle of RP's
 * 4-to-6-week accumulation run; the PR puts the 4, 5 and 6 week sim numbers to the owner.
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
