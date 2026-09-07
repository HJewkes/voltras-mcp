// `mrvguard.check` handler — a DIAGNOSTIC read over `checkMrvGuard`
// (VW-91 / B04).
//
// Mirrors `driftguard.check` exactly, per VW-131's decision: no internal
// wiring, no not-yet-built advisory tool consuming this. This tool exists so
// a human (or an agent relaying to one) can ask "did this lifter show two
// consecutive underperforming sessions" and get the same verdict any future
// consumer would compute.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import { MrvGuardCheckInput } from '../schemas/mrv-guard.js';
import type { ServerState } from '../state/server-state.js';
import { checkMrvGuard } from '../store/mrv-guard.js';
import { LOCAL_USER_ID } from '../store/types.js';
import { wrapHandler } from './helpers.js';
import type { MrvGuardVerdict, MrvUnderperformanceVerdict } from '@voltras/workout-analytics';

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

/**
 * Hot-swap the `mrvguard.*` placeholder with its real handler. Mirrors the
 * install pattern used by the other tool registries (see `drift-guard-tools.ts`).
 */
const MRV_GUARD_CHECK_DESCRIPTION =
  'DIAGNOSTIC ONLY — not the consumption path. Ask "did this lifter underperform their prior ' +
  'benchmark on two consecutive sessions for this exercise" and get the same B04 ' +
  'MRV/under-recovery verdict any internal check would see. All three session ids are ' +
  'required and must be ordered oldest to newest: the signal is TWO pairwise comparisons ' +
  '(session1 vs session2, then session2 vs session3), so a single pair cannot answer it. ' +
  'Returns `priorPair`, `currentPair`, and the combined `guard` verdict. Real internal ' +
  'consumers import `checkMrvGuard` directly rather than round-tripping through this tool. ' +
  'Use this when a human wants to inspect a deload signal, not as a step in an automated ' +
  'coaching decision.';

export function registerMrvGuardTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
  install(
    placeholders,
    'mrvguard.check',
    MrvGuardCheckInput,
    wrapHandler(MrvGuardCheckInput, (input) => checkMrv(state, input)),
    MRV_GUARD_CHECK_DESCRIPTION,
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

async function checkMrv(
  state: ServerState,
  input: z.infer<typeof MrvGuardCheckInput>,
): Promise<{
  priorPair: MrvUnderperformanceVerdict;
  currentPair: MrvUnderperformanceVerdict;
  guard: MrvGuardVerdict;
}> {
  return checkMrvGuard(state.store, {
    key: {
      userId: LOCAL_USER_ID,
      exerciseId: input.exerciseId,
      ...(input.side !== undefined ? { side: input.side } : {}),
    },
    session1Id: input.session1Id,
    session2Id: input.session2Id,
    session3Id: input.session3Id,
  });
}
