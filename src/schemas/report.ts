// Input schema for `report.session_results`.
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
