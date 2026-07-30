// `baselines.*` tool handlers — the read surface over `exercise_baselines`
// (I5 / B56, VW-116).
//
// `exercise_baselines` has been inert DDL since v7. These handlers, plus the
// recalc hook on the set-close choke point in `set-tools.ts`, are its first
// call sites.
//
// STATE, NOT VALUES. `baselines.get` answers "how much do we know about this
// exercise, and how consistent was it" — never "what is this user's median
// ROM". Baseline values are recomputed from stored reps by the analytics
// layer on demand; caching them here would mean serving a number produced by
// a formula that has since changed.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import { BaselinesGetInput, BaselinesRecalcInput } from '../schemas/baselines.js';
import type { ServerState } from '../state/server-state.js';
import { LOCAL_USER_ID, type StoredExerciseBaseline } from '../store/types.js';
import { wrapHandler } from './helpers.js';

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

/**
 * Hot-swap the `baselines.*` placeholders with their real handlers. Mirrors
 * the install pattern used by the other tool registries (see
 * `profile-tools.ts`).
 */
export function registerBaselineTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
  install(
    placeholders,
    'baselines.get',
    BaselinesGetInput,
    wrapHandler(BaselinesGetInput, (input) => getBaseline(state, input)),
  );
  install(
    placeholders,
    'baselines.recalc',
    BaselinesRecalcInput,
    wrapHandler(BaselinesRecalcInput, (input) => recalcBaseline(state, input)),
  );
}

function install<S extends z.ZodObject>(
  placeholders: PlaceholderTools,
  name: string,
  schema: S,
  callback: (args: unknown, extra?: unknown) => Promise<unknown>,
): void {
  const tool = placeholders.get(name);
  if (tool === undefined) {
    throw new Error(`tool placeholder not registered: ${name}`);
  }
  tool.update({ paramsSchema: schema.shape, callback: callback as never });
}

/**
 * Read the persisted baseline state. `null` means this key has never been
 * recalculated — which is NOT the same as `COLD`, and is deliberately not
 * coalesced to it: "never observed" and "observed, not enough evidence" are
 * different answers and the caller decides how to say so.
 */
async function getBaseline(
  state: ServerState,
  input: z.infer<typeof BaselinesGetInput>,
): Promise<{ baseline: StoredExerciseBaseline | null }> {
  const baseline = await state.store.getBaseline({
    userId: LOCAL_USER_ID,
    exerciseId: input.exerciseId,
    ...(input.side !== undefined ? { side: input.side } : {}),
  });
  return { baseline: baseline ?? null };
}

/**
 * Force a recalculation. Set close already recalculates the key it touched,
 * so this exists for the two cases that hook cannot cover: history recorded
 * before the hook shipped, and a threshold change that makes every stored
 * `state` stale against the current `algorithmVersion`.
 */
async function recalcBaseline(
  state: ServerState,
  input: z.infer<typeof BaselinesRecalcInput>,
): Promise<{ baseline: StoredExerciseBaseline }> {
  const baseline = await state.store.recalcBaseline({
    userId: LOCAL_USER_ID,
    exerciseId: input.exerciseId,
    ...(input.side !== undefined ? { side: input.side } : {}),
  });
  return { baseline };
}
