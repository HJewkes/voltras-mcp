// Input schemas for the `goal.*` tools (VW-350, plan H2).
//
// THE HUMAN DECLARES PRIORITIES; THE COACH DERIVES TARGETS. Nothing here takes
// a target value as input at declaration time, and `goal.propose_targets` takes
// no value at all: a start value is READ FROM HISTORY, never typed. The only
// place a human number enters is `goal.accept_target`, where the lifter may
// keep the coach's committed edge or name their own.
//
// A TARGET IS FIXED ONCE ACCEPTED (human decision, 2026-09-13), which is why
// there is no `goal.update_target` in this namespace. The two exits are
// `goal.retire` with an outcome and `goal.new_chapter`.

import { z } from 'zod';

import type { StoredPriorityKind, StoredPriorityLevel } from '../store/types.js';

// `satisfies` rather than a bare literal: the store's unions are the contract,
// so a value added there without being offered here is a type error rather
// than a tool that silently cannot express it.
const PRIORITY_KINDS = ['muscle', 'lift'] as const satisfies readonly StoredPriorityKind[];
const PRIORITY_LEVELS = [
  'specialize',
  'maintain',
  'deprioritize',
] as const satisfies readonly StoredPriorityLevel[];

/**
 * One declared priority.
 *
 * `ref` is a catalog primary-muscle string (or a spoken synonym like "arms",
 * resolved by `analytics/goal-metrics.ts`) when `kind` is `'muscle'`, and an
 * `exerciseId` when it is `'lift'`.
 *
 * `declineFatLossDowngrade` is how the lifter answers the fat-loss
 * specialization advisory (rp:rp-s5-fatloss-priority-training-rule). Declining
 * is recorded, and the advisory is never raised for that muscle or lift again
 * in the same phase — an advisory the lifter has already answered is not a
 * question, and re-asking it is how advisory copy turns into nagging.
 */
export const GoalPriorityItem = z
  .object({
    kind: z.enum(PRIORITY_KINDS),
    ref: z.string().min(1),
    level: z.enum(PRIORITY_LEVELS),
    declineFatLossDowngrade: z.boolean().optional(),
  })
  .strict();

/**
 * `goal.declare_priorities` — the human's own object, stated once per block.
 *
 * Every guardrail this runs is ADVISORY: the declaration is stored exactly as
 * it was made, and the warnings come back beside it (audit:122, 308).
 * `horizonWeeks` defaults to the named block's `weeksCount`, then to the
 * three-month planning horizon (rp:rp-s10-three-month-planning-horizon).
 */
export const GoalDeclarePrioritiesInput = z
  .object({
    items: z.array(GoalPriorityItem).min(1),
    horizonWeeks: z.number().int().positive().optional(),
    blockId: z.string().min(1).optional(),
  })
  .strict();

/**
 * `goal.propose_targets` — derive a band per tracked metric of one priority.
 *
 * Takes no values: every input to the band is read (history for the start
 * value, the tier signal, the diet phase, the plan tree for the weeks).
 */
export const GoalProposeTargetsInput = z
  .object({
    priorityId: z.string().min(1),
  })
  .strict();

/**
 * `goal.accept_target` — fix a proposed target's numbers.
 *
 * Omitting both values accepts the coach default (`committedValue` at the
 * band's low edge, `stretchValue` at its high edge). A committed value BELOW
 * the low edge is refused: the low edge is already the conservative one
 * (rp:rp-s10-underpromise-overdeliver-goal-setting), and accepting less would
 * make "met" meaningless. A value above the high edge needs
 * `acknowledgeStretch`, which records that the lifter went past what the
 * evidence supports with their eyes open.
 */
export const GoalAcceptTargetInput = z
  .object({
    targetId: z.string().min(1),
    committedValue: z.number().optional(),
    stretchValue: z.number().optional(),
    acknowledgeStretch: z.boolean().optional(),
  })
  .strict();

/** `goal.list` — every declared priority with its targets. Read-only. */
export const GoalListInput = z
  .object({
    includeRetired: z.boolean().optional(),
  })
  .strict();

/**
 * `goal.retire` — end one priority (cascading to its targets) or one target.
 *
 * The outcome is required and has no default: whether a target was met, missed
 * or abandoned is a fact only the caller knows, and guessing it would put a
 * verdict on the lifter's record that nobody stated.
 *
 * "Exactly one of `priorityId` / `targetId`" is checked in the handler rather
 * than with a `.refine` here, because a refined schema has no `.shape` for the
 * MCP tool registration to publish as its parameter list.
 */
export const GoalRetireInput = z
  .object({
    priorityId: z.string().min(1).optional(),
    targetId: z.string().min(1).optional(),
    outcome: z.enum(['met', 'missed', 'abandoned']),
  })
  .strict();

/**
 * `goal.new_chapter` — mark where a target's comparable series restarts
 * (rp:rp-s3, plan v1 §1.12).
 *
 * A technique reform makes the stored start value a measurement of a different
 * movement. The target's numbers do NOT move — this is not a back door around
 * the fixed-target rule; it records that the series behind them changed.
 */
export const GoalNewChapterInput = z
  .object({
    targetId: z.string().min(1),
    at: z.string().datetime().optional(),
  })
  .strict();
