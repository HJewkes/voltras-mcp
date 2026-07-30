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
  })
  .strict();

export const ProfileGetTrainingBackgroundInput = z.object({}).strict();

// `profile.get_tier_signal` (VW-92 MVP). No input today; this repo is
// effectively single-user in practice (see `tier-signal.ts`), so there is
// nothing for a caller to disambiguate yet.
export const ProfileGetTierSignalInput = z.object({}).strict();
