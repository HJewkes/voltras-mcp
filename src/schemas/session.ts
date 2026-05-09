// Input schemas for `session.*` tools.
//
// `SessionStartInput` accepts either an `exerciseId` (validated against the
// `@voltras/workout-analytics` catalog at handler time) or a free-text
// `exerciseName`. Per spec R21, exactly one must be present; if both are
// provided, the handler ignores `exerciseName` and uses `exerciseId`. The
// `.refine()` here enforces the "at least one" half — the "id wins" half is
// implemented in the handler, not the schema.

import { z } from 'zod';
import { IdSchema, SlotIdSchema } from './common.js';

/**
 * Input for `session.start`. Both fields are optional individually so that
 * either may be supplied, but the refinement below requires at least one.
 *
 * Handler behavior (per R21):
 *   - if `exerciseId` is present, it wins and `exerciseName` is dropped.
 *   - if only `exerciseName` is present, it is stored as a free-text fallback.
 *   - an `exerciseId` not present in the catalog returns `EXERCISE_NOT_FOUND`.
 */
export const SessionStartInput = z
  .object({
    exerciseId: z.string().optional(),
    exerciseName: z.string().optional(),
    slot: SlotIdSchema,
  })
  .refine((v) => v.exerciseId !== undefined || v.exerciseName !== undefined, {
    message: 'Either exerciseId or exerciseName is required.',
  });

/**
 * Input for `session.list`. All fields optional; handler applies defaults
 * (`sort = 'startedAt:desc'`, `limit = 50`, `offset = 0`, `detail = 'summary'`).
 *
 * `detail` controls how much data is returned per session:
 *   - `'summary'` (default): existing session metadata PLUS aggregates
 *     (setCount, totalReps, topWeightLbs, trainingModes, totalDurationMs).
 *     Fires N `getSetsForSession` queries (one per session); acceptable for v1.
 *   - `'full'`: same as `'summary'` but also includes the full `sets` array
 *     with each set's `reps` array. Matches the old `session.get` payload shape.
 */
export const SessionListInput = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  exerciseId: z.string().optional(),
  sort: z.enum(['startedAt:desc', 'startedAt:asc']).default('startedAt:desc').optional(),
  limit: z.number().int().min(1).max(200).default(50).optional(),
  offset: z.number().int().min(0).default(0).optional(),
  detail: z.enum(['summary', 'full']).default('summary').optional(),
});

/** Input for `session.get` — fetches a single stored session by id. */
export const SessionGetInput = z.object({ id: IdSchema });

/**
 * Input for `session.end` — operates on the slot's live active session.
 * The handler reads the resolved slot's `live.session` to determine the
 * target.
 */
export const SessionEndInput = z.object({
  slot: SlotIdSchema,
});
