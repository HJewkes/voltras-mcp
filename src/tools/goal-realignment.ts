// The block-boundary re-ask (VW-359, plan H3 / §2e).
//
// RP contracts a lifter to one block at a time and re-evaluates the direction
// at its end (rp:rp-s10-three-month-planning-horizon). This module is that
// re-evaluation: at a block edge it reads the declaration the lifter made,
// re-derives what the next block's bands would be, and says what a switch
// would cost them.
//
// IT RE-PROPOSES, IT NEVER LOWERS. A target accepted for the finished block is
// fixed and stays fixed — `previewTargets` reports it as blocked rather than
// re-banding it, which is what keeps "met" meaning something. The re-ask
// derives and shows; `goal.propose_targets` and `goal.accept_target` are the
// only things that write.
//
// THE WARNINGS ARE COMPOSED, NOT COPIED. `evaluateDeclaration` already holds
// the rp-s6 mid-block rule and the rp-s5 persistence nudge. Asking it the
// re-ask's own question — "what if I dropped these now?" — is what produces
// them here, so there is exactly one copy of each rule in the tree.

import type { ServerState } from '../state/server-state.js';
import {
  LOCAL_USER_ID,
  type StoredPriority,
  type StoredPriorityKind,
  type StoredPriorityLevel,
} from '../store/types.js';
import { readDietPhaseState } from './diet-phase-state.js';
import type { SkippedMetric } from './goal-derivation.js';
import {
  evaluateDeclaration,
  GOAL_GUARDRAIL_THRESHOLDS,
  type GoalGuardrailWarning,
} from './goal-guardrails.js';
import { previewTargets, readDeclinedRefs, type PreviewedTarget } from './goal-tools.js';
import { getTierSignal } from './tier-signal.js';

/** The notes behind the re-ask itself, cited on every boundary it reports. */
const REALIGNMENT_RP_IDS = [
  'rp:rp-s10-three-month-planning-horizon',
  'rp:rp-s5-goal-persistence-multi-meso',
  'rp:rp-s6-priority-muscle-held-constant-per-block',
];

/** One declared priority, with the bands it would get for the next block. */
export interface GoalRealignmentPriority {
  priorityId: string;
  kind: StoredPriorityKind;
  ref: string;
  level: StoredPriorityLevel;
  mesosHeld: number;
  targets: PreviewedTarget[];
  skipped: SkippedMetric[];
}

export interface GoalRealignment {
  priorities: GoalRealignmentPriority[];
  /** What the guardrails would say if these priorities were dropped now. */
  warningsIfChanged: GoalGuardrailWarning[];
  minMesosBeforeSwitch: number;
  rpIds: string[];
  note: string;
}

/**
 * The re-ask for a block that just ended, or null when nothing was declared —
 * a pre-VW-350 database has no priorities, and the boundary keeps its old
 * free-text prompt rather than inventing a declaration nobody made.
 */
export async function buildGoalRealignment(
  state: ServerState,
  finishedBlockId: string,
): Promise<GoalRealignment | null> {
  const live = await state.store.listPriorities(LOCAL_USER_ID);
  if (live.length === 0) return null;
  const priorities: GoalRealignmentPriority[] = [];
  for (const priority of live) {
    priorities.push(await repropose(state, priority));
  }
  return {
    priorities,
    warningsIfChanged: await warningsIfChanged(state, live, finishedBlockId),
    minMesosBeforeSwitch: GOAL_GUARDRAIL_THRESHOLDS.minMesosBeforeSwitch,
    rpIds: REALIGNMENT_RP_IDS,
    note:
      'Re-proposed for the next block and nothing is written: declare the priorities against the ' +
      'new block and accept a target to commit to it. A target you already accepted is reported ' +
      'as skipped rather than re-banded — the re-ask never lowers a target you met the block on.',
  };
}

async function repropose(
  state: ServerState,
  priority: StoredPriority,
): Promise<GoalRealignmentPriority> {
  const preview = await previewTargets(state, priority);
  return {
    priorityId: priority.id,
    kind: priority.kind,
    ref: priority.ref,
    level: priority.level,
    mesosHeld: priority.mesosHeld,
    targets: preview.legs.map((leg) => leg.entry),
    skipped: preview.skipped,
  };
}

/**
 * The declaration guardrails, asked the re-ask's own question. `items: []` is
 * the "re-architect" answer, so `evaluateDeclaration` returns the rp-s6
 * warning for every priority still bound to the block that just finished and
 * the rp-s5 nudge for any specialization held fewer than
 * `minMesosBeforeSwitch` mesocycles.
 */
async function warningsIfChanged(
  state: ServerState,
  live: readonly StoredPriority[],
  finishedBlockId: string,
): Promise<GoalGuardrailWarning[]> {
  const signal = await getTierSignal(state, LOCAL_USER_ID);
  const dietState = await readDietPhaseState(state, new Date().toISOString());
  return evaluateDeclaration({
    items: [],
    existing: live,
    dietPhase: dietState.phase,
    tier: signal.declared ?? signal.tier,
    blockId: finishedBlockId,
    declinedRefs: await readDeclinedRefs(state),
  }).warnings;
}
