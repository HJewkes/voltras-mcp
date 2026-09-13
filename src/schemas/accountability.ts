// Input schema for `accountability.*`.
//
// `.strict()` like the rest of the tool surface: a typo'd key rejects as
// INVALID_INPUT rather than being silently dropped.

import { z } from 'zod';

export const AccountabilityStateInput = z
  .object({
    /**
     * Evaluate the dry run as of this instant (ISO-8601) instead of now. The
     * persisted state is returned unchanged either way — nothing is written.
     */
    at: z.string().min(1).optional(),
  })
  .strict();

export const AccountabilityPreviewInput = z
  .object({
    /** Same as `accountability.state`'s `at`: evaluate as of this instant instead of now. */
    at: z.string().min(1).optional(),
  })
  .strict();
