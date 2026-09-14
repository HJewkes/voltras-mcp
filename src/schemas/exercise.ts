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
 * The declared setup card (VW-275): anchor landmark, rack mount hole, the
 * device's Settings > Cable length value, and resistance mode. All optional
 * except `anchor` — a caller may know the mode but not the mount hole, and a
 * partial card is still worth recording rather than forcing an all-or-nothing
 * answer.
 */
const SetupCardInput = z
  .object({
    anchor: z.enum(['low', 'mid', 'chest', 'high']),
    mountHole: z.number().int().positive().optional(),
    cableLengthSetting: z.union([z.string().min(1), z.number()]).optional(),
    mode: z.string().min(1).optional(),
  })
  .strict();

/**
 * Input for `exercise.confirm_setup`. `setupId` is a generated clustering id,
 * so it can only come from a `baselines.recalc { inferSetups: true }` response;
 * `label` is the human's own words for the setup and is stored verbatim.
 * `card` is optional and, when given, is stored verbatim too — same rule as
 * `label`, nothing here is inferred from the clustering.
 */
export const ExerciseConfirmSetupInput = z
  .object({
    setupId: z.string().min(1),
    label: z.string().min(1).max(120),
    card: SetupCardInput.optional(),
  })
  .strict();

/**
 * Input for `exercise.mark_new_chapter` (VW-361). `startedAt` defaults to now
 * and may be in the past — a lifter naming the week the reform began is the
 * ordinary case, not a correction. `reason` is their own words and is stored
 * verbatim.
 */
export const ExerciseMarkNewChapterInput = z
  .object({
    exerciseId: IdSchema,
    startedAt: z.string().datetime().optional(),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

/** Input for `exercise.retire_chapter` — the `chapterId` a mark call returned. */
export const ExerciseRetireChapterInput = z
  .object({
    chapterId: z.string().min(1),
  })
  .strict();
