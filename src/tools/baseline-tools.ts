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
const GET_BASELINE_DESCRIPTION =
  'Read the persisted confidence state for one exercise baseline (COLD -> SHAPE_ONLY -> ' +
  'PROVISIONAL -> CALIBRATED -> STALE). This is a diagnostic read over an internal state ' +
  'machine (B56/VW-116), not a value lookup — it answers "how much do we know about this ' +
  'exercise, and how consistent was it", never "what is the median ROM". `baseline: null` ' +
  'means this (user, exercise, side) key has never been recalculated — that is NOT the same ' +
  'as COLD (COLD means it HAS been observed but shape is not yet established). A number ' +
  'derived from a baseline below CALIBRATED should be treated as provisional; do not present ' +
  'RIR or readiness-zone claims as confident until state is CALIBRATED.';

const RECALC_BASELINE_DESCRIPTION =
  'Force a baseline recalculation for one (exercise, side) key. Set-close already recalculates ' +
  'the key it touched, so this only matters for two cases: history recorded before that hook ' +
  'shipped, or an algorithm-version bump that makes a stored `state` stale against the current ' +
  'thresholds. Prefer `baselines.get` for a normal read; only call this when you specifically ' +
  'need to force a fresh derivation.';

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
    GET_BASELINE_DESCRIPTION,
  );
  install(
    placeholders,
    'baselines.recalc',
    BaselinesRecalcInput,
    wrapHandler(BaselinesRecalcInput, (input) => recalcBaseline(state, input)),
    RECALC_BASELINE_DESCRIPTION,
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
