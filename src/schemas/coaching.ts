// Input schema for the `coaching.explain` tool (VW-136/VW-137).
//
// ONE tool with a bounded topic enum, per the locked consolidation design
// (sources/mined/mcp-tool-surface-consolidation-design.md §1): `coaching.explain`
// is a genuinely new namespace (knowledge/prose lookup, not a target-scoped
// compute op like `metrics.compute`), but within that namespace it stays a
// single tool — NOT one tool per topic, which would sprawl into dozens of
// narrow tools as new RP content gets mined.
//
// Topics are grouped by the 4 conversation types (onboarding/live/meso/diet)
// via a dotted prefix, matching house tool-naming style even though this is a
// parameter value, not a tool name — it keeps the enum self-documenting and
// gives a natural place to add topics within a group later.

import { z } from 'zod';

export const CoachingTopic = z.enum([
  // Session 0 / onboarding
  'onboarding.tier_inference',
  'onboarding.frequency_negotiation',
  'onboarding.goal_commitment_alignment',
  'onboarding.injury_intake',
  // Regular workout session (live-set coaching)
  'live.cue_budget',
  'live.cue_delivery',
  'live.warmup_protocol',
  'live.rir_estimation',
  'live.stop_set_signal',
  // Mesocycle planning
  'meso.deload_trigger',
  'meso.deload_ladder',
  'meso.volume_progression',
  'meso.post_deload_restart',
  'meso.exercise_rotation',
  // Diet / nutrition coaching
  'diet.phase_coupling',
  'diet.phase_durations',
  'diet.disruption_handling',
]);

export type CoachingTopic = z.infer<typeof CoachingTopic>;

export const CoachingExplainInput = z
  .object({
    topic: CoachingTopic,
    /**
     * Narrows a tier-split topic's response to one tier's values. Omitted
     * (the default) returns every applicable tier inline — callers that don't
     * yet know the lifter's tier still get a safe, complete answer rather
     * than being forced to guess a tier just to ask the question. Topics
     * whose content does not vary by tier ignore this field.
     */
    tier: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
  })
  .strict();
