// The beginner rotation cap (VW-622, B19): a beginner rotates at most about a quarter of their
// exercises from one block to the next (rp:rp-s4-exercise-rotation-quarter-rule), because a
// beginner's gains come from repeating the same movements. Advisory, like every plan lint.

import type { Tier } from '../profile/tier.js';
import type { PlanWarning } from './lint-plan.js';

/** The share of a block's exercises that may be new against the block before it. */
export const BEGINNER_ROTATION_CAP = 0.25;

export interface LintRotationInput {
  /** Exercise ids planned anywhere in the block before this one; empty when this is the first. */
  previousBlockExerciseIds: readonly string[];
  /** Exercise ids planned anywhere in this block, after the edit. */
  blockExerciseIds: readonly string[];
  tier: Tier;
}

/** Flags a beginner block whose share of exercises new against the previous block tops the cap. */
export function lintBeginnerRotation(input: LintRotationInput): PlanWarning[] {
  if (input.tier !== 'beginner') return [];
  const previous = new Set(input.previousBlockExerciseIds);
  const current = new Set(input.blockExerciseIds);
  if (previous.size === 0 || current.size === 0) return [];
  const rotated = [...current].filter((id) => !previous.has(id)).length;
  const share = rotated / current.size;
  if (share <= BEGINNER_ROTATION_CAP) return [];
  const percent = Math.round(share * 100);
  return [
    {
      code: 'beginner_rotation_over_quarter',
      message:
        `${rotated} of this block's ${current.size} exercises (${percent}%) are new against the ` +
        'block before it. A beginner rotates about a quarter of their exercises per block at most, ' +
        'because their progress comes from repeating the same movements ' +
        '(rp:rp-s4-exercise-rotation-quarter-rule). Consider keeping more of the previous ' +
        "block's exercises.",
      observed: percent,
      ceiling: BEGINNER_ROTATION_CAP * 100,
      tier: input.tier,
    },
  ];
}
