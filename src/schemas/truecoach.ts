// Input schema for `truecoach.import_week`.
//
// `.strict()` like the rest of the tool surface: a typo'd key rejects as
// INVALID_INPUT rather than being silently dropped, which matters more here
// than elsewhere because a dropped `dryRun` would turn a rehearsal into a write.

import { z } from 'zod';
import { IdSchema } from './common.js';

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date.');

export const TrueCoachImportWeekInput = z
  .object({
    /** Inclusive range start; defaults with `to` to the current ISO week. */
    from: IsoDate.optional(),
    /** Inclusive range end. */
    to: IsoDate.optional(),
    /** Program to import into; defaults to the most recent non-archived program. */
    programId: IdSchema.optional(),
    /** Map the tree and report it without writing anything. */
    dryRun: z.boolean().optional(),
    /** TrueCoach exercise name -> catalog exercise id, for names the catalog cannot match. */
    mapping: z.record(z.string().min(1), z.string().min(1)).optional(),
    /** Bypass the on-disk response cache and re-fetch from TrueCoach. */
    refresh: z.boolean().optional(),
  })
  .strict();
