// The declaration guardrails of `goal.declare_priorities` (VW-350, plan §2a).
//
// PURE. Takes the declaration plus the context it is judged against, returns
// warnings and proposals. It reads nothing and writes nothing — persisting the
// declaration and recording an answered proposal are `goal-tools.ts`'s job.
//
// ADVISORY, NEVER BLOCKING (audit:122, 308). Every finding here is returned
// beside a declaration that was stored exactly as it was made. RP's own
// posture is that the coach counters a wish and then holds the line in
// conversation (rp:rp-s10-underpromise-overdeliver-goal-setting), not that the
// software refuses the lifter's stated goal.
//
// A DOWNGRADE IS A PROPOSAL, NOT AN EDIT. In a fat-loss phase specialization
// is disabled (rp:rp-s5-fatloss-priority-training-rule), but the way that
// reaches the lifter is an offer to change `specialize` to `maintain`, with a
// decline that is recorded and never re-raised. Applying it silently would
// make the stored declaration something the lifter never said.

import type { GoalDietPhase } from '../analytics/goal-band.js';
import type { StoredPriority, StoredPriorityKind, StoredPriorityLevel } from '../store/types.js';
import type { Tier } from './tier-signal.js';

/** The advisory code a recorded fat-loss downgrade answer is filed under. */
export const FAT_LOSS_DOWNGRADE_CODE = 'goal_fat_loss_specialize_downgrade';

/** Bumped when the rule below changes, so old answers stay re-scorable. */
export const GOAL_GUARDRAIL_VERSION = 'goal-guardrails@1.0.0';

export const GOAL_GUARDRAIL_THRESHOLDS = {
  /**
   * Specialized muscles or lifts at once.
   *
   * HUMAN DECISION 2026-09-13 (plan §4 Q1). The corpus never states a cap; it
   * says "one or two chosen muscles" in passing and every worked example is a
   * pair (rp:rp-s5-fatloss-priority-training-rule,
   * rp:rp-s6-priority-muscle-held-constant-per-block). Two is a reading of
   * those examples, which is why exceeding it warns rather than blocks.
   */
  maxSpecializeItems: 2,
  /** Specialized items a fat-loss phase admits. rp:rp-s5-fatloss-priority-training-rule */
  fatLossSpecializeCap: 0,
  /**
   * Mesocycles a priority should be held before it is swapped.
   *
   * rp:rp-s5-goal-persistence-multi-meso says 2-5; the low edge is what the
   * nudge fires below, because switching at every meso is the failure mode the
   * note names.
   */
  minMesosBeforeSwitch: 2,
} as const;

const T = GOAL_GUARDRAIL_THRESHOLDS;

/** One declared item, as the tool receives it. */
export interface DeclaredItem {
  kind: StoredPriorityKind;
  ref: string;
  level: StoredPriorityLevel;
  declineFatLossDowngrade?: boolean | undefined;
}

/** An advisory finding. `ref` is present when it is about one declared item. */
export interface GoalGuardrailWarning {
  code: string;
  ref?: string;
  message: string;
  rpIds: string[];
}

/** An offer to change one item's level, which only the lifter may accept. */
export interface GoalDowngradeProposal {
  code: typeof FAT_LOSS_DOWNGRADE_CODE;
  kind: StoredPriorityKind;
  ref: string;
  from: 'specialize';
  to: 'maintain';
  rationale: string;
  rpIds: string[];
}

export interface GoalGuardrailContext {
  items: readonly DeclaredItem[];
  /** Live priorities before this declaration lands. */
  existing: readonly StoredPriority[];
  dietPhase: GoalDietPhase;
  /** The DECLARED tier: the beginner exception is about the lifter's own claim. */
  tier: Tier;
  blockId?: string;
  /** Refs whose fat-loss downgrade the lifter has already declined. */
  declinedRefs: readonly string[];
}

export interface GoalGuardrailResult {
  warnings: GoalGuardrailWarning[];
  proposals: GoalDowngradeProposal[];
  /** Refs whose downgrade this call declines, for the caller to record. */
  declinedNow: string[];
}

export function evaluateDeclaration(context: GoalGuardrailContext): GoalGuardrailResult {
  const specialized = context.items.filter((item) => item.level === 'specialize');
  const fatLoss = context.dietPhase === 'fat-loss';
  return {
    warnings: [
      ...capWarnings(specialized, fatLoss, context.tier),
      ...midBlockWarnings(context),
      ...persistenceNudges(context),
    ],
    proposals:
      fatLoss && context.tier !== 'beginner' ? downgradeProposals(specialized, context) : [],
    declinedNow:
      fatLoss && context.tier !== 'beginner'
        ? specialized.filter((item) => item.declineFatLossDowngrade === true).map((i) => i.ref)
        : [],
  };
}

/**
 * The count rule. In a fat-loss phase the cap is zero, but a non-beginner
 * hears about it through the per-item proposal below rather than twice, and a
 * beginner hears the exception instead: a beginner's program does not change
 * across diet phases at all (rp:rp-s4-training-invariant-across-diet-phase).
 */
function capWarnings(
  specialized: readonly DeclaredItem[],
  fatLoss: boolean,
  tier: Tier,
): GoalGuardrailWarning[] {
  if (fatLoss) {
    return tier === 'beginner' && specialized.length > 0
      ? [
          {
            code: 'fat_loss_specialize_beginner_exception',
            message:
              `A fat-loss phase normally disables specialization, but a beginner program does not ` +
              `change across diet phases, so ${specialized.length} specialized item(s) stand as declared.`,
            rpIds: [
              'rp:rp-s5-fatloss-priority-training-rule',
              'rp:rp-s4-training-invariant-across-diet-phase',
            ],
          },
        ]
      : [];
  }
  if (specialized.length <= T.maxSpecializeItems) return [];
  return [
    {
      code: 'specialize_cap_exceeded',
      message:
        `${specialized.length} specialized items declared; ${T.maxSpecializeItems} is the working cap. ` +
        'Every worked example in the corpus is a pair, and spreading emphasis further is how a ' +
        'block ends with no visible gain anywhere. This is advisory: the declaration stands.',
      rpIds: [
        'rp:rp-s5-fatloss-priority-training-rule',
        'rp:rp-s6-priority-muscle-held-constant-per-block',
      ],
    },
  ];
}

/** A priority is held for a whole block; changing one inside it warns (rp-s6). */
function midBlockWarnings(context: GoalGuardrailContext): GoalGuardrailWarning[] {
  const { blockId } = context;
  if (blockId === undefined) return [];
  const inBlock = context.existing.filter((priority) => priority.blockId === blockId);
  if (inBlock.length === 0) return [];
  const declared = new Set(context.items.map(itemKey));
  const changed = inBlock.filter((priority) => !declared.has(itemKey(priority)));
  if (changed.length === 0) return [];
  return [
    {
      code: 'priority_changed_mid_block',
      message:
        `This block already holds ${changed.map((p) => `${p.ref} (${p.level})`).join(', ')}, which ` +
        'this declaration changes. A priority is meant to be held for the whole block; changing it ' +
        'mid-block means neither the old nor the new one gets a clean read.',
      rpIds: ['rp:rp-s6-priority-muscle-held-constant-per-block'],
    },
  ];
}

/** Dropping a priority that has not been held long enough to show anything. */
function persistenceNudges(context: GoalGuardrailContext): GoalGuardrailWarning[] {
  const declared = new Set(context.items.map((item) => `${item.kind}:${item.ref}`));
  return context.existing
    .filter(
      (priority) =>
        !declared.has(`${priority.kind}:${priority.ref}`) &&
        priority.level === 'specialize' &&
        priority.mesosHeld < T.minMesosBeforeSwitch,
    )
    .map((priority) => ({
      code: 'priority_persistence_nudge',
      ref: priority.ref,
      message:
        `${priority.ref} has been a priority for ${priority.mesosHeld} mesocycle(s). Commit to a ` +
        `couple more? Switching before ${T.minMesosBeforeSwitch} spreads the work too thin to see a result.`,
      rpIds: ['rp:rp-s5-goal-persistence-multi-meso'],
    }));
}

function downgradeProposals(
  specialized: readonly DeclaredItem[],
  context: GoalGuardrailContext,
): GoalDowngradeProposal[] {
  const alreadyDeclined = new Set(context.declinedRefs);
  return specialized
    .filter((item) => item.declineFatLossDowngrade !== true && !alreadyDeclined.has(item.ref))
    .map((item) => ({
      code: FAT_LOSS_DOWNGRADE_CODE,
      kind: item.kind,
      ref: item.ref,
      from: 'specialize' as const,
      to: 'maintain' as const,
      rationale:
        `In a fat-loss phase every muscle gets at least maintenance volume and none gets ` +
        `specialized: a deficit is when a back-burnered muscle actually shrinks, and the ` +
        `genetically weakest go first. Accept to declare ${item.ref} as maintain, or decline and ` +
        'the declaration stands as made.',
      rpIds: [
        'rp:rp-s5-fatloss-priority-training-rule',
        'rp:rp-s6-genetically-weak-muscle-diet-loss',
      ],
    }));
}

function itemKey(item: { kind: StoredPriorityKind; ref: string; level: StoredPriorityLevel }) {
  return `${item.kind}:${item.ref}:${item.level}`;
}
