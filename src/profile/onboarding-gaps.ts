// `profile.get_onboarding_gaps` (VW-148) — what session 0 has not asked yet.
//
// A READ over the stored self-report. It computes no verdict, prescribes
// nothing, and invents no questions: `missing` is exactly the set of
// `training_profile` fields with no stored answer, listed in the order the RP
// session-0 checklist asks them (sources/mined/mcp-audit-rp-docs.md §1).
//
// The two pieces of prose it returns are QUOTED VERBATIM from
// `coaching-content.ts` — the same corpus `coaching.explain` serves. Nothing
// here writes new coaching or medical copy, and nothing here interprets the
// cardiovascular flag beyond repeating RP's own instruction to defer to a
// doctor: that is a liability boundary, not something a non-clinical coach
// (or this server) gets to reason about.

import { COACHING_CONTENT } from '../tools/coaching-content.js';
import type { StoredTrainingProfile } from '../store/types.js';

/**
 * The RP session-0 checklist, in the order §1 of the audit asks it:
 * §1a the four-part intake (goal, days available, days RELIABLE) plus the
 * rp-s11 baseline/effort/target triple; §1b tier, which is never years-trained
 * alone; §1c volume history, which is uninterpretable without the named
 * program it came from; §1j the injury ladder.
 *
 * Order is the contract — a caller walks this list top to bottom to decide
 * what to ask next, so reordering it changes the conversation.
 */
export const ONBOARDING_CHECKLIST = [
  'goal',
  'daysAvailable',
  'daysReliable',
  'currentBaseline',
  'effortTolerance',
  'target',
  'declaredTier',
  'yearsTraining',
  'historyConsistent',
  'everPlateaued',
  'reportedSetsPerMuscle',
  'namedProgramHistory',
  'injuries',
] as const satisfies ReadonlyArray<keyof StoredTrainingProfile>;

export type OnboardingField = (typeof ONBOARDING_CHECKLIST)[number];

/**
 * The cardiovascular hard gate, quoted verbatim from
 * `onboarding.injury_intake`. A test asserts this is still a substring of that
 * topic's prose, so the quote cannot drift away from the corpus silently.
 */
export const MEDICAL_CLEARANCE_SENTENCE =
  "Cardiovascular limitations of any kind — ALWAYS defer to a doctor's clearance; never " +
  'interpret these as a non-clinically-trained coach. This is a liability boundary, not a ' +
  'feature flag.';

export interface GoalRealism {
  goal: string | null;
  target: string | null;
  /** `onboarding.goal_commitment_alignment` prose. NOT a computed verdict. */
  note: string;
}

export interface OnboardingGaps {
  missing: OnboardingField[];
  medicalClearanceRequired: boolean;
  /** The gate's own wording when required, `null` otherwise. */
  medicalClearanceNote: string | null;
  goalRealism: GoalRealism | null;
}

export function onboardingGaps(profile: StoredTrainingProfile | undefined): OnboardingGaps {
  const cardio = profile?.injuries?.some((injury) => injury.cardioLimitation === true) === true;
  return {
    missing: ONBOARDING_CHECKLIST.filter((field) => !hasAnswer(profile, field)),
    medicalClearanceRequired: cardio,
    medicalClearanceNote: cardio ? MEDICAL_CLEARANCE_SENTENCE : null,
    goalRealism: goalRealism(profile),
  };
}

/**
 * An empty `injuries` array IS an answer — "asked, nothing to report" is not
 * the same as never asked, and only the latter belongs in `missing`.
 */
function hasAnswer(profile: StoredTrainingProfile | undefined, field: OnboardingField): boolean {
  return profile?.[field] !== undefined;
}

/**
 * `null` until there is something to weigh. The note is the corpus's rule for
 * how to run the check, handed to the agent to run with the lifter — this
 * function never decides whether a goal is realistic.
 */
function goalRealism(profile: StoredTrainingProfile | undefined): GoalRealism | null {
  const goal = profile?.goal ?? null;
  const target = profile?.target ?? null;
  if (goal === null && target === null) return null;
  return {
    goal,
    target,
    note: COACHING_CONTENT['onboarding.goal_commitment_alignment'].allTiers,
  };
}
