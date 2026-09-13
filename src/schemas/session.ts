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
 * A lifter label (VW-169) — a short free-text name for whoever is on the
 * cable, used ONLY to keep a guest's work out of the owner's baselines,
 * anchors, progression and history. Not an identity: there is no user row, no
 * profile and no tier behind it, and the owner never carries one (absent means
 * the owner).
 */
export const LifterLabel = z.string().min(1).max(40);

/**
 * Optional self-reported pre-session carbohydrate context (VW-307). RP-style
 * coarse 3-point scale, same rationale as `CheckinScaleValue`: a finer
 * gradation would manufacture precision a subjective self-rating doesn't
 * have. `hoursSinceLastMeal` is a rough self-estimate, not a timestamp.
 */
export const PreSessionCarbsLevel = z.enum(['low', 'normal', 'high']);

export const PreSessionCarbsInput = z.object({
  level: PreSessionCarbsLevel,
  hoursSinceLastMeal: z.number().min(0).max(72).optional(),
});

/**
 * `session.checkin` answer codes (VMCP-06.12 / B41), quoted from the RP
 * corpus's five-question check-in (`rp-s10-checkin-question-set`): "How did
 * it go?" (`went`), "How did you feel?" (`felt`), "Did anything feel off?"
 * (`off`), "Any questions?" (`questions`) — all free text — and "How are you
 * feeling about the next session/week?" (`next`), RP's coarse 3-point scale.
 * `soreness`, `joint` and `motivation` are the backlog's additional
 * week-1-gated 3-point ratings (idea 15, B41).
 */
export const CHECKIN_TEXT_CODES = ['went', 'felt', 'off', 'questions'] as const;
export const CHECKIN_SCALE_CODES = ['next', 'soreness', 'joint', 'motivation'] as const;
/**
 * Withheld before the lifter's first completed training week: per the
 * backlog, answers are uniformly positive and low-signal that early, and
 * asking can seed unwarranted concern.
 */
export const CHECKIN_GATED_CODES = ['soreness', 'joint', 'motivation'] as const;

export const CheckinAnswerCode = z.enum([...CHECKIN_TEXT_CODES, ...CHECKIN_SCALE_CODES]);

/**
 * RP's coarse 3-point scale (`rp-s7-coarse-rating-scale-rationale`):
 * 'low'/'medium'/'high', never a 5- or 10-point scale — finer gradations
 * manufacture precision a subjective self-rating doesn't actually have.
 */
export const CheckinScaleValue = z.enum(['low', 'medium', 'high']);

const CHECKIN_SCALE_CODE_SET: ReadonlySet<string> = new Set(CHECKIN_SCALE_CODES);

export const CheckinAnswerInput = z
  .object({
    code: CheckinAnswerCode,
    value: z.string().min(1).max(500),
  })
  .refine(
    (v) => !CHECKIN_SCALE_CODE_SET.has(v.code) || CheckinScaleValue.safeParse(v.value).success,
    {
      message:
        "'next', 'soreness', 'joint' and 'motivation' answers must be 'low', 'medium' or 'high'.",
    },
  );

/**
 * Shared shape for `session.checkin` and `session.end`'s `checkin` block —
 * both call the same writer, so both take the same payload.
 */
const CheckinPayload = z.object({
  answers: z.array(CheckinAnswerInput).min(1).max(8),
  notes: z.string().max(2000).optional(),
});

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
    /**
     * Debug opt-in (VMCP-02.11). Default `false`: the bridge batches idle
     * reps into a single `idle_rep_summary` channel event every 5s instead
     * of emitting one `idle_rep` per occurrence. Set `true` to restore the
     * legacy per-occurrence emission (useful for protocol-debug sessions
     * where each idle rep needs to be inspected individually). When
     * verbose mode is on, summary events are suppressed to avoid
     * double-emission.
     */
    verboseIdleReps: z.boolean().optional(),
    /**
     * VW-169. The session's default lifter: every set started on it is
     * attributed to this label unless `set.start` overrides it. Omit for the
     * owner's own session, which is the overwhelmingly common case.
     */
    lifter: LifterLabel.optional(),
    /**
     * VW-307. Optional self-reported carb context for this session — nothing
     * downstream consumes it yet, see `StoredSession.preSessionCarbs`.
     */
    preSessionCarbs: PreSessionCarbsInput.optional(),
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
  /**
   * VW-169. Whose sessions to list. OMITTED MEANS THE OWNER'S — a guest's
   * sessions are excluded by default and returned only when asked for by
   * label.
   */
  lifter: LifterLabel.optional(),
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
  /**
   * Optional check-in written atomically with the close (VMCP-06.12 / B41),
   * same shape `session.checkin` takes. Omitted changes nothing about how
   * `session.end` behaves — it never blocks or prompts for one.
   */
  checkin: CheckinPayload.optional(),
});

/**
 * Input for `session.checkin` (VMCP-06.12 / B41). `sessionId` omitted means
 * the slot's active session; pass it explicitly to check in on a session
 * that has already ended.
 */
export const SessionCheckinInput = CheckinPayload.extend({
  slot: SlotIdSchema,
  sessionId: IdSchema.optional(),
  /**
   * VW-307. Set or correct the target session's carb context from here too,
   * for a lifter who didn't have it at `session.start`. Not part of
   * `CheckinPayload`: it isn't a check-in answer, and `session.end`'s
   * `checkin` block doesn't take it — the session has already ended by then.
   */
  preSessionCarbs: PreSessionCarbsInput.optional(),
});

/**
 * Input for `session.set_exercise` (VMCP-01.72b) — repoints the active
 * session's current exercise so one workout can hold several exercises
 * without ending and restarting the session. Same `exerciseId`/`exerciseName`
 * XOR shape as `SessionStartInput`, and the same R21 handling ("id wins over
 * name" if both present).
 */
export const SessionSetExerciseInput = z
  .object({
    exerciseId: z.string().optional(),
    exerciseName: z.string().optional(),
    slot: SlotIdSchema,
  })
  .refine((v) => v.exerciseId !== undefined || v.exerciseName !== undefined, {
    message: 'Either exerciseId or exerciseName is required.',
  });

/**
 * Input for `session.set_lifter` (VW-169) — set or clear the active session's
 * default lifter, so a second person working in mid-workout does not need a
 * session of their own.
 *
 * `lifter: null` CLEARS the default and hands the rig back to the owner. It is
 * spelled explicitly rather than as an omitted field because omitting it would
 * be indistinguishable from a caller that forgot, and the cost of guessing
 * wrong is a guest's sets landing in the owner's baselines.
 */
export const SessionSetLifterInput = z.object({
  lifter: LifterLabel.nullable(),
  slot: SlotIdSchema,
});
