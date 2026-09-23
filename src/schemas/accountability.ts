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

/**
 * An enum rather than free text: the consuming surface is a day picker (chat design P17) and
 * "mondayish" must not persist. These are the names the coach's copy renders.
 */
export const COMMITMENT_WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

const CommitmentWeekday = z.enum(COMMITMENT_WEEKDAYS);

export const AccountabilityDeclareCommitmentInput = z
  .object({
    /** Each training day with the day it falls back to; a fallback day may also be committed. */
    days: z
      .array(z.object({ day: CommitmentWeekday, fallbackDay: CommitmentWeekday }).strict())
      .min(1)
      .max(7),
    /** The lifter's if-then sentence. Stored and rendered verbatim. */
    ifThen: z.string().min(1).max(1000),
    /** The commitment in the lifter's own words. Stored and rendered verbatim. */
    wording: z.string().min(1).max(1000),
    /** The local Monday the committed week opens on; defaults to the week being committed to. */
    weekOf: z.string().min(1).optional(),
  })
  .strict();
