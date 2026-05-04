// Input schemas for `exercise.*` tools.
//
// `exercise.search` wraps `searchExercises(query)` from the analytics
// catalog; `exercise.get` wraps `getExerciseById(id)`. Both return only the
// catalog's public `Exercise` fields (per spec R22).

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
