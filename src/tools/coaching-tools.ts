// `coaching.explain` handler — a knowledge/prose lookup over the mined RP
// University corpus (VW-136/VW-137).
//
// A genuinely new namespace per the locked consolidation design
// (sources/mined/mcp-tool-surface-consolidation-design.md §1): this is not a
// target-scoped compute operation like `metrics.compute`, it's "explain this
// RP-derived concept to me." Kept to ONE tool with a bounded topic enum
// (schemas/coaching.ts) rather than one tool per topic.
//
// Every response states tier-specific values INLINE in `explanation` — never
// an unqualified number — per the corpus's own framing rule. `sources` and
// `caveats` let a human or downstream agent trace a claim back to the mined
// notes; this tool never fabricates content beyond what coaching-content.ts
// carries.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import { CoachingExplainInput } from '../schemas/coaching.js';
import type { ServerState } from '../state/server-state.js';
import { COACHING_CONTENT } from './coaching-content.js';
import { wrapHandler } from './helpers.js';

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

const COACHING_EXPLAIN_DESCRIPTION =
  'Look up RP-derived coaching knowledge by topic, grouped by conversation type: ' +
  'onboarding.* (tier inference, frequency negotiation, goal/commitment alignment, injury ' +
  'intake), live.* (cue budget, cue delivery, warmup protocol, RIR estimation, stop-set ' +
  'signal), meso.* (deload trigger, deload ladder, volume progression, post-deload restart, ' +
  'exercise rotation), diet.* (phase coupling, phase durations, disruption handling). ' +
  'Every response states tier-specific values INLINE in `explanation` — an unqualified number ' +
  'from this corpus is meaningless, so never strip the tier qualifier when relaying it. Pass ' +
  '`tier` to narrow a tier-split topic to one tier; omit it to get every applicable tier at ' +
  "once (safe default when the lifter's tier is not yet known). `sources` cites the mined " +
  'note ids a response draws from; a `caveats` array, when present, flags topics whose own ' +
  'source material self-contradicts — quote those as ranges, not resolved single numbers.';

/**
 * Hot-swap the `coaching.*` placeholder with its real handler. Mirrors the
 * install pattern used by the other tool registries (see `baseline-tools.ts`).
 */
export function registerCoachingTools(
  _server: McpServer,
  _state: ServerState,
  placeholders: PlaceholderTools,
): void {
  install(
    placeholders,
    'coaching.explain',
    CoachingExplainInput,
    wrapHandler(CoachingExplainInput, (input) => Promise.resolve(explain(input))),
    COACHING_EXPLAIN_DESCRIPTION,
  );
}

function install<S extends z.ZodObject>(
  placeholders: PlaceholderTools,
  name: string,
  schema: S,
  callback: (args: unknown, extra?: unknown) => Promise<unknown>,
  description?: string,
): void {
  const tool = placeholders.get(name);
  if (tool === undefined) {
    throw new Error(`tool placeholder not registered: ${name}`);
  }
  const updates: Record<string, unknown> = {
    paramsSchema: schema.shape,
    callback: callback as never,
  };
  if (description !== undefined) {
    updates.description = description;
  }
  tool.update(updates as never);
}

function explain(input: z.infer<typeof CoachingExplainInput>): {
  topic: string;
  explanation: string;
  sources: string[];
  caveats?: string[];
} {
  const content = COACHING_CONTENT[input.topic];
  const perTierValue = input.tier !== undefined ? content.perTier?.[input.tier] : undefined;
  const explanation = perTierValue ?? content.allTiers;
  return {
    topic: input.topic,
    explanation,
    sources: content.sources,
    ...(content.caveats !== undefined ? { caveats: content.caveats } : {}),
  };
}
