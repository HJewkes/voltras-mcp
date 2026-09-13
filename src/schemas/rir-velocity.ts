// Input schemas for the `rir_velocity.*` tools (VW-298).

import { z } from 'zod';

/**
 * Reps in reserve a prescription names. Upper bound at 10 because RP's own
 * corpus puts beginner self-report error at 5-10 reps and never prescribes
 * above this range; a larger number is a typo, not a request.
 */
export const RepsInReserve = z.number().min(0).max(10);

export const RirVelocityFitInput = z
  .object({
    exerciseId: z.string().min(1),
  })
  .strict();

export const RirVelocityTargetInput = z
  .object({
    exerciseId: z.string().min(1),
    rir: RepsInReserve,
  })
  .strict();
