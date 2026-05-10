// Input and response schemas for `progression.*` tools.
//
// `MAX_LOOKBACK_WEEKS` is the hard upper bound. Inputs above this are rejected
// with `INVALID_INPUT` rather than silently clamped, so callers get explicit
// feedback instead of quietly receiving a shorter window than requested.

import { z } from 'zod';

export const MAX_LOOKBACK_WEEKS = 52;

/**
 * Input for `progression.get_for_exercise`. All optional fields have
 * documented defaults applied in the handler, not in the schema, so the
 * schema remains a pure validation surface (no `.default()` side-effects).
 */
export const ProgressionGetInput = z.object({
  exerciseId: z.string().min(1),
  lookbackWeeks: z
    .number()
    .int()
    .min(1)
    .max(MAX_LOOKBACK_WEEKS)
    .optional()
    .describe(
      `Number of weeks to look back from now. Default 8, max ${MAX_LOOKBACK_WEEKS}. ` +
        'Values above the max return INVALID_INPUT.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Maximum number of sessions to return. Default 20, max 200.'),
});
