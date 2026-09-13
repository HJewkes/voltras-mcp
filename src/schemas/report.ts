// Input schemas for `report.*`.
//
// `.strict()` like the rest of the tool surface: a typo'd key rejects as
// INVALID_INPUT rather than being silently dropped.

import { z } from 'zod';
import { IdSchema } from './common.js';

export const ReportSessionResultsInput = z
  .object({
    /** The session to render. Must already be ended. */
    sessionId: IdSchema,
  })
  .strict();

export const ReportWeeklyInput = z
  .object({
    /** Range start (ISO-8601). Defaults to 7 days before `to`. */
    from: z.string().min(1).optional(),
    /** Range end (ISO-8601), exclusive of nothing in particular — sessions are
     *  matched by `startedAt` in `[from, to]`. Defaults to now. */
    to: z.string().min(1).optional(),
    /** Defaults to `'markdown'`. */
    format: z.enum(['markdown', 'json']).optional(),
    /** Whose sessions to report on. Absent means the owner. */
    lifter: z.string().optional(),
    /** Fallback check-in text used only when no `self_reports` rows exist. */
    notes: z.string().optional(),
  })
  .strict();
