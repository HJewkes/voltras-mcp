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
