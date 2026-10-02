// The planning brief's specialization frequency bump (VW-624, B45): in the final specialization
// block before an active rest, a specialized muscle limited by fatigue rather than soreness may
// train one more session a week, because the active rest pays off the extra fatigue. Never in a
// fat-loss phase, never for a beginner. Advisory copy only: the sitting decides.

import type { TitanMuscleGroup } from '../exercises/muscle-map.js';
import { isSpecializedMuscle, priorityMuscleSlugs } from '../plan/specialization.js';
import type { StoredPriority } from '../store/types.js';
import { GOAL_GUARDRAIL_THRESHOLDS } from './goal-guardrails.js';
import type { BriefAdvisory } from './plan-brief-advisories.js';
import type { WeekShape } from './plan-brief-cadence.js';
import type { Tier } from './tier-signal.js';

const BUMP = 'rp:rp-s6-frequency-bump-final-specialization-mesocycle';
const PERSISTENCE = 'rp:rp-s5-goal-persistence-multi-meso';

/** Muscles limited by fatigue, not soreness, so a pre-active-rest bump pays off (rp-s6-frequency-bump-final-specialization-mesocycle). */
export const FATIGUE_LIMITED_MUSCLES: ReadonlySet<TitanMuscleGroup> = new Set([
  'biceps',
  'front_delts',
  'side_delts',
  'rear_delts',
]);

/** Systemically fatiguing muscles a bump never helps, whatever else lists them (rp-s6-frequency-bump-final-specialization-mesocycle). */
export const SYSTEMICALLY_FATIGUING_MUSCLES: ReadonlySet<TitanMuscleGroup> = new Set([
  'hamstrings',
]);

export interface MuscleLists {
  fatigueLimited: ReadonlySet<TitanMuscleGroup>;
  systemic: ReadonlySet<TitanMuscleGroup>;
}

const DEFAULT_LISTS: MuscleLists = {
  fatigueLimited: FATIGUE_LIMITED_MUSCLES,
  systemic: SYSTEMICALLY_FATIGUING_MUSCLES,
};

export interface FrequencyBumpInput {
  blockName: string;
  priorities: readonly StoredPriority[];
  /** The clamped tier: a beginner gets no specialization block to bump. */
  tier: Tier;
  dietPhase: string;
  finalBeforeActiveRest: boolean;
}

/** One offer per specialized muscle ref with a bumpable slug; empty unless every gate passes. */
export function frequencyBumpAdvisories(
  input: FrequencyBumpInput,
  lists: MuscleLists = DEFAULT_LISTS,
): BriefAdvisory[] {
  if (input.tier === 'beginner' || input.dietPhase === 'fat-loss') return [];
  if (!input.finalBeforeActiveRest) return [];
  return input.priorities.filter(isSpecializedMuscle).flatMap((priority) => {
    const bumpable = priorityMuscleSlugs(priority.ref).filter(
      (muscle) => lists.fatigueLimited.has(muscle) && !lists.systemic.has(muscle),
    );
    if (bumpable.length === 0) return [];
    return [bumpAdvisory(input.blockName, muscleLabel(priority.ref, bumpable), priority.mesosHeld)];
  });
}

/** The declared ref, naming the slugs it bumps when they are not the ref itself: "arms (biceps)". */
function muscleLabel(ref: string, slugs: readonly string[]): string {
  const named = slugs.map((slug) => slug.replaceAll('_', ' ')).join(', ');
  return slugs.length === 1 && slugs[0] === ref ? named : `${ref} (${named})`;
}

function bumpAdvisory(blockName: string, label: string, mesosHeld: number): BriefAdvisory {
  const early = mesosHeld < GOAL_GUARDRAIL_THRESHOLDS.minMesosBeforeSwitch;
  return {
    kind: 'specialization_frequency_bump',
    exerciseId: null,
    text:
      `"${blockName}" is the last block before an active rest, so ${label}, a specialized muscle ` +
      'limited by fatigue rather than soreness, may train one more session a week in it: the ' +
      `active rest pays off the extra fatigue (${BUMP}). This is an offer, not a plan change.` +
      (early ? earlyCaveat(label, mesosHeld) : ''),
    rpIds: early ? [BUMP, PERSISTENCE] : [BUMP],
  };
}

function earlyCaveat(label: string, mesosHeld: number): string {
  const min = GOAL_GUARDRAIL_THRESHOLDS.minMesosBeforeSwitch;
  return (
    ` ${label} has been specialized for ${mesosHeld} mesocycle(s), fewer than ${min}: priority and ` +
    `frequency changes are held for 2 to 3 mesocycles, so this bump comes early (${PERSISTENCE}).`
  );
}

type WeekKind = 'deload' | 'off' | 'train';

// "Rest-pause" is a set technique, not a week off.
const OFF_WORD = /\b(off|rest)\b(?![-\s]?pause)/i;

/** A week whose name or phase says it is off or a rest: the explicit marker, built or not. */
function markedOff(week: WeekShape): boolean {
  return [week.name, week.phaseType].some((text) => text !== undefined && OFF_WORD.test(text));
}

/**
 * An unmarked week with no workouts is off only in a block that has workouts. In a block with
 * none it is scaffolding, a training week not yet built, so it can never stand in for a week off.
 */
function blockKinds(weeks: readonly WeekShape[]): WeekKind[] {
  const built = weeks.some((week) => week.templates > 0);
  return weeks.map((week) => {
    if (week.isDeload) return 'deload';
    if (markedOff(week)) return 'off';
    return week.templates === 0 && built ? 'off' : 'train';
  });
}

/**
 * True when the block's last training week is followed by a deload week and then an off week,
 * inside the block or running into the block after it: an active rest comes straight after it.
 * An unbuilt block counts only through its markers, so an empty one with none gets no offer.
 */
export function isFinalBeforeActiveRest(
  blockWeeks: readonly WeekShape[],
  followingWeeks: readonly WeekShape[],
): boolean {
  const own = blockKinds(blockWeeks);
  const lastTrain = own.lastIndexOf('train');
  if (lastTrain === -1) return false;
  const tail = [...own.slice(lastTrain + 1), ...blockKinds(followingWeeks)];
  return tail[0] === 'deload' && tail[1] === 'off';
}
