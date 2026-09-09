// Input schemas for the `profile.*` training-background tools (VW-96 Wave 3).
//
// Storage only: every field here is a self-reported raw value captured
// verbatim into `training_profile`. There is no derivation or tier
// classification here — that is a separate, already-scoped effort (VW-92)
// that reads this table.
//
// `ProfileSetTrainingBackgroundInput` is `.strict()` with every field
// optional so a caller can set one answer at a time across several onboarding
// turns; the handler merges each call onto the existing row rather than
// overwriting it wholesale (see `profile-tools.ts`).

import { z } from 'zod';

/**
 * One self-reported injury or limitation (VW-148 / B42).
 *
 * `kind` deliberately does NOT encode the RP injury ladder's diagnosed vs.
 * undiagnosed split as a clinical judgement — it records what the lifter said
 * happened. `cardioLimitation` is the one hard gate: it is a flag the lifter
 * raises, and nothing in this codebase interprets it beyond deferring to a
 * doctor (see `onboarding.injury_intake` in `coaching-content.ts`).
 */
export const ProfileInjury = z
  .object({
    area: z.string().min(1),
    kind: z.enum(['sharp_in_set', 'lingering_joint', 'other']),
    note: z.string().min(1).optional(),
    cardioLimitation: z.boolean().optional(),
  })
  .strict();

export const ProfileSetTrainingBackgroundInput = z
  .object({
    declaredTier: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
    yearsTraining: z.number().min(0).optional(),
    historyConsistent: z.boolean().optional(),
    everPlateaued: z.boolean().optional(),
    reportedSetsPerMuscle: z.number().min(0).optional(),
    goal: z.string().min(1).optional(),
    daysAvailable: z.number().int().min(0).max(7).optional(),
    daysReliable: z.number().int().min(0).max(7).optional(),
    // VMCP-06.04 / B39. RP keeps these three DISTINCT from each other and from
    // `goal`; collapsing them is what makes intake read a target as a baseline.
    currentBaseline: z.string().min(1).optional(),
    effortTolerance: z.enum(['low', 'moderate', 'high']).optional(),
    target: z.string().min(1).optional(),
    // VW-148 / B42. Replaces the whole list on every call, unlike the scalar
    // fields above: a merge would make removing a resolved injury impossible.
    injuries: z.array(ProfileInjury).optional(),
    // VW-148 / B36. The named program `reportedSetsPerMuscle` came from —
    // 5/3/1 and German Volume Training imply very different starting volumes
    // for the same reported set count.
    namedProgramHistory: z.string().min(1).optional(),
  })
  .strict();

export const ProfileGetTrainingBackgroundInput = z.object({}).strict();

// `profile.get_onboarding_gaps` (VW-148). Same single-user posture as the
// other profile reads: nothing for a caller to disambiguate.
export const ProfileGetOnboardingGapsInput = z.object({}).strict();

// `profile.get_tier_signal` (VW-92 MVP). No input today; this repo is
// effectively single-user in practice (see `tier-signal.ts`), so there is
// nothing for a caller to disambiguate yet.
export const ProfileGetTierSignalInput = z.object({}).strict();

// `profile.get_starting_prescription` (VMCP-06.04). Same single-user posture as
// the tier signal it reads: nothing to disambiguate, so nothing to pass.
export const ProfileGetStartingPrescriptionInput = z.object({}).strict();
