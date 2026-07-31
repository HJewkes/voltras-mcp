// `driftguard.check` handler — a DIAGNOSTIC read over `checkDriftGuard`
// (VW-90 / B15).
//
// This tool is not the consumption path. The cross-session comparisons that
// need a drift verdict (VW-91 / B04's MRV detector, progression scoring) run
// inside this process and import `checkDriftGuard` directly — routing them
// through an MCP round-trip would buy nothing and lose the type. The tool
// exists so a human can ask "why did the detector refuse to compare these two
// sessions" and get the same verdict the detector saw.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import { DriftGuardCheckInput } from '../schemas/drift-guard.js';
import type { ServerState } from '../state/server-state.js';
import { checkDriftGuard } from '../store/drift-guard.js';
import { LOCAL_USER_ID } from '../store/types.js';
import { wrapHandler } from './helpers.js';
import type { DriftGuardVerdict } from '@voltras/workout-analytics';

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

/**
 * Hot-swap the `driftguard.*` placeholder with its real handler. Mirrors the
 * install pattern used by the other tool registries (see `baseline-tools.ts`).
 */
const DRIFT_GUARD_CHECK_DESCRIPTION =
  'DIAGNOSTIC ONLY — not the consumption path. Ask "why did the system refuse (or accept) a ' +
  'comparison between these two sessions for this exercise" and get the same comparability ' +
  'verdict any internal cross-session check would see (drift in ROM/tempo, setup mismatch, ' +
  'insufficient baseline). Real internal consumers import `checkDriftGuard` directly rather ' +
  'than round-tripping through this tool. Use this when a human wants to inspect or debug a ' +
  'refused comparison, not as a step in an automated coaching decision.';

export function registerDriftGuardTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
  install(
    placeholders,
    'driftguard.check',
    DriftGuardCheckInput,
    wrapHandler(DriftGuardCheckInput, (input) => checkDrift(state, input)),
    DRIFT_GUARD_CHECK_DESCRIPTION,
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

async function checkDrift(
  state: ServerState,
  input: z.infer<typeof DriftGuardCheckInput>,
): Promise<{ verdict: DriftGuardVerdict }> {
  const verdict = await checkDriftGuard(state.store, {
    key: {
      userId: LOCAL_USER_ID,
      exerciseId: input.exerciseId,
      ...(input.side !== undefined ? { side: input.side } : {}),
    },
    baselineSessionId: input.baselineSessionId,
    currentSessionId: input.currentSessionId,
  });
  return { verdict };
}
