// Input schema for the `mrvguard.check` tool (VW-91 / B04).
//
// The exercise identity mirrors `schemas/drift-guard.ts`. Three session ids,
// not two: the B04 signal is TWO consecutive pairwise comparisons (session1 vs
// session2, then session2 vs session3), and both pairs are required for a
// caller to ask "did this lifter show two underperforming sessions in a row".

import { z } from 'zod';

export const MrvGuardCheckInput = z
  .object({
    exerciseId: z.string().min(1),
    side: z.enum(['left', 'right']).optional(),
    /** Oldest of the three sessions — the prior pair's baseline. */
    session1Id: z.string().min(1),
    /** Middle session — the prior pair's current AND the current pair's baseline. */
    session2Id: z.string().min(1),
    /** Newest session — the current pair's current. */
    session3Id: z.string().min(1),
  })
  .strict();
