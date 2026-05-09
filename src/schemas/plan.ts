// Input schemas for the `plan.*` block-periodization CRUD tools.
//
// All schemas are `.strict()` so unknown keys reject as INVALID_INPUT — the
// store rows are mostly opaque to the model, and silently dropping a typo'd
// field would be hard to debug. `id` is optional everywhere; the handler
// generates a UUID when omitted, accepts the caller's value when supplied.
//
// The tree is: program -> block -> week -> workout-template -> planned
// exercise. Each create-tool requires the parent id; the corresponding
// list-tool fetches every child of a parent (ordered by `orderIndex` for
// blocks/weeks/templates/exercises; by `created_at DESC` for programs at
// the store layer).

import { z } from 'zod';
import { IdSchema } from './common.js';

// --- programs ---

export const PlanProgramCreateInput = z
  .object({
    id: IdSchema.optional(),
    name: z.string().min(1),
    description: z.string().optional(),
  })
  .strict();

export const PlanProgramListInput = z
  .object({
    includeArchived: z.boolean().optional(),
  })
  .strict();

export const PlanProgramGetInput = z
  .object({
    id: IdSchema,
  })
  .strict();

export const PlanProgramArchiveInput = z
  .object({
    id: IdSchema,
  })
  .strict();

// --- blocks ---

export const PlanBlockCreateInput = z
  .object({
    id: IdSchema.optional(),
    programId: IdSchema,
    orderIndex: z.number().int().min(0),
    name: z.string().min(1),
    focus: z.string().optional(),
    weeksCount: z.number().int().min(1),
    notes: z.string().optional(),
  })
  .strict();

export const PlanBlockListForProgramInput = z
  .object({
    programId: IdSchema,
  })
  .strict();

// --- weeks ---

export const PlanWeekCreateInput = z
  .object({
    id: IdSchema.optional(),
    blockId: IdSchema,
    orderIndex: z.number().int().min(0),
    name: z.string().optional(),
  })
  .strict();

export const PlanWeekListForBlockInput = z
  .object({
    blockId: IdSchema,
  })
  .strict();

// --- workout templates ---

export const PlanTemplateCreateInput = z
  .object({
    id: IdSchema.optional(),
    weekId: IdSchema,
    dayLabel: z.string().optional(),
    name: z.string().min(1),
    notes: z.string().optional(),
    orderIndex: z.number().int().min(0),
  })
  .strict();

export const PlanTemplateGetInput = z
  .object({
    id: IdSchema,
  })
  .strict();

export const PlanTemplateListForWeekInput = z
  .object({
    weekId: IdSchema,
  })
  .strict();

// --- planned exercises ---

export const PlanExerciseCreateInput = z
  .object({
    id: IdSchema.optional(),
    workoutTemplateId: IdSchema,
    exerciseId: IdSchema,
    orderIndex: z.number().int().min(0),
    targetSets: z.number().int().min(1),
    targetRepsLow: z.number().int().min(1).optional(),
    targetRepsHigh: z.number().int().min(1).optional(),
    targetWeightLbs: z.number().min(0).optional(),
    targetRpe: z.number().min(0).max(10).optional(),
    restSec: z.number().int().min(0).optional(),
    notes: z.string().optional(),
  })
  .strict();

export const PlanExerciseListForTemplateInput = z
  .object({
    workoutTemplateId: IdSchema,
  })
  .strict();

// --- progression / session-link tools ---

/**
 * Walk a program's tree and return the first un-completed workout template.
 * `programId` is optional — when omitted the handler picks the most-recent
 * non-archived program from the store.
 */
export const PlanNextWorkoutInput = z
  .object({
    programId: IdSchema.optional(),
  })
  .strict();

/**
 * Mark a workout template as completed by writing a ProgramAssignment row
 * linking the given session to the template. `sessionId` is optional — when
 * omitted the handler uses the active session on the primary slot.
 */
export const PlanCompleteWorkoutInput = z
  .object({
    workoutTemplateId: IdSchema,
    sessionId: IdSchema.optional(),
  })
  .strict();

/**
 * Bind a session to a planned exercise OR a workout template (XOR — supplying
 * both or neither rejects as INVALID_INPUT). The caller picks which level of
 * the plan tree the session belongs to: a single set against a planned
 * exercise, or a whole workout against a template.
 */
export const PlanAttachToSessionInput = z
  .object({
    sessionId: IdSchema,
    plannedExerciseId: IdSchema.optional(),
    workoutTemplateId: IdSchema.optional(),
  })
  .strict()
  .refine(
    (v) =>
      (v.plannedExerciseId !== undefined && v.workoutTemplateId === undefined) ||
      (v.plannedExerciseId === undefined && v.workoutTemplateId !== undefined),
    {
      message: 'Provide exactly one of plannedExerciseId or workoutTemplateId.',
    },
  );

/**
 * Suggest a next-session weight delta for a planned exercise based on the
 * most-recent completed session. `programId` is optional (defaults to the
 * most-recent non-archived program); `completedSessionId` is optional
 * (defaults to the most-recent session for the given exercise).
 */
export const PlanSuggestProgressionInput = z
  .object({
    programId: IdSchema.optional(),
    exerciseId: IdSchema,
    completedSessionId: IdSchema.optional(),
  })
  .strict();
