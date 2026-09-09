// Input schemas for `exercise.*` tools.
//
// `exercise.search` wraps `searchExercises(query)` from the analytics
// catalog; `exercise.get` wraps `getExerciseById(id)`. Both return only the
// catalog's public `Exercise` fields (per spec R22).
//
// `exercise.confirm_setup` is the odd one out: it writes, and it writes the
// one thing the ROM clustering cannot derive — what a physical setup actually
// IS (VW-119).

import { z } from 'zod';
import { IdSchema } from './common.js';

/** Input for `exercise.search` — non-empty free-text query. */
export const ExerciseSearchInput = z.object({
  query: z.string().min(1),
});

/** Input for `exercise.get` — catalog id. */
export const ExerciseGetInput = z.object({
  id: IdSchema,
});

/**
 * Input for `exercise.confirm_setup`. `setupId` is a generated clustering id,
 * so it can only come from a `baselines.recalc { inferSetups: true }` response;
 * `label` is the human's own words for the setup and is stored verbatim.
 */
export const ExerciseConfirmSetupInput = z
  .object({
    setupId: z.string().min(1),
    label: z.string().min(1).max(120),
  })
  .strict();
