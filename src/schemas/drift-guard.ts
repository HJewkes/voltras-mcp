// Input schema for the `driftguard.check` tool (VW-90 / B15).
//
// The exercise identity mirrors `schemas/baselines.ts`: `userId` is the
// implicit local user and `setupId` has no writer, so neither is nameable. The
// two session ids are what makes this a COMPARISON rather than a lookup —
// both are required, because "drift since when" has no sensible default.

import { z } from 'zod';

export const DriftGuardCheckInput = z
  .object({
    exerciseId: z.string().min(1),
    side: z.enum(['left', 'right']).optional(),
    /** The reference session — usually the older of the two. */
    baselineSessionId: z.string().min(1),
    /** The session being judged against the reference. */
    currentSessionId: z.string().min(1),
  })
  .strict();
