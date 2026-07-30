// Input schemas for the `baselines.*` tools (I5 / B56, VW-116).
//
// The key mirrors `@voltras/workout-analytics`'s public `BaselineKey`
// (`userId`, `exerciseId`, `setupId`, `side`) minus the two dimensions a
// caller cannot supply today: `userId` is the implicit local user, and
// `setupId` has no writer (setup inference is a separate, unbuilt task), so
// naming a setup is rejected at the store boundary rather than silently
// answered with the pooled row.
//
// `side` omitted means the side-agnostic view — a distinct baseline from
// either per-side one, not a wildcard over them.

import { z } from 'zod';

const BaselineKeyFields = {
  exerciseId: z.string().min(1),
  side: z.enum(['left', 'right']).optional(),
};

export const BaselinesGetInput = z.object(BaselineKeyFields).strict();

export const BaselinesRecalcInput = z.object(BaselineKeyFields).strict();
