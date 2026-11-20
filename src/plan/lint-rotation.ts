// The beginner rotation cap (VW-622, B19): a beginner rotates at most about a quarter of their
// exercises from one block to the next (rp:rp-s4-exercise-rotation-quarter-rule), because a
// beginner's gains come from repeating the same movements. Advisory, like every plan lint.

import type { Tier, TierConfidence } from '../profile/tier.js';
import { PROVISIONAL_SUFFIX, type PlanWarning } from './lint-plan.js';

/** The share of a block's exercises that may be new against the block before it. */
export const BEGINNER_ROTATION_CAP = 0.25;

export interface LintRotationInput {
  /** Exercise ids planned anywhere in the block before this one; empty when this is the first. */
  previousBlockExerciseIds: readonly string[];
  /** Exercise ids planned anywhere in this block, after the edit. */
  blockExerciseIds: readonly string[];
  /** The same block before the edit, so a write that changes nothing is not warned again. */
  blockExerciseIdsBefore?: readonly string[];
  tier: Tier;
  confidence: TierConfidence;
}

interface RotationRead {
  rotated: number;
  distinct: number;
}

/**
 * Flags a beginner block whose share of exercises new against the previous block tops the cap.
 * Like the frequency lint, it judges only a block built out far enough to be judged: one with
 * at least as many distinct exercises as the block before it. A half-built block is silent.
 */
export function lintBeginnerRotation(input: LintRotationInput): PlanWarning[] {
  if (input.tier !== 'beginner') return [];
  const previous = new Set(input.previousBlockExerciseIds);
  const after = overCap(previous, input.blockExerciseIds);
  if (after === null) return [];
  const before = input.blockExerciseIdsBefore && overCap(previous, input.blockExerciseIdsBefore);
  if (before && before.rotated === after.rotated && before.distinct === after.distinct) return [];
  const warning = rotationWarning(after, input.tier);
  if (input.confidence !== 'provisional') return [warning];
  return [{ ...warning, message: warning.message + PROVISIONAL_SUFFIX }];
}

/** The block's rotation when it is built out and over the cap, else `null`. */
function overCap(previous: ReadonlySet<string>, blockIds: readonly string[]): RotationRead | null {
  const current = new Set(blockIds);
  if (previous.size === 0 || current.size < previous.size) return null;
  const rotated = [...current].filter((id) => !previous.has(id)).length;
  if (rotated / current.size <= BEGINNER_ROTATION_CAP) return null;
  return { rotated, distinct: current.size };
}

function rotationWarning({ rotated, distinct }: RotationRead, tier: Tier): PlanWarning {
  const percent = Math.round((rotated / distinct) * 100);
  return {
    code: 'beginner_rotation_over_quarter',
    message:
      `${rotated} of this block's ${distinct} exercises (${percent}%) are new against the ` +
      'block before it. A beginner rotates about a quarter of their exercises per block at most, ' +
      'because their progress comes from repeating the same movements ' +
      '(rp:rp-s4-exercise-rotation-quarter-rule). Consider keeping more of the previous ' +
      "block's exercises.",
    observed: percent,
    ceiling: BEGINNER_ROTATION_CAP * 100,
    tier,
  };
}
