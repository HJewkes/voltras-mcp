// Record every write-classified MCP call in the audit trail (VW-892, slice 3
// of VW-849).
//
// This is NOT `executeAudited`. That runs the handler inside an open store
// transaction, and a device handler awaits BLE while `isometric.measure_max`
// and `timer.wait` await for minutes: holding the store's write lock across
// those awaits would make every other store call throw. So the claim and the
// completion are two separate statements and no transaction spans the handler.
//
// The door is recorded-before-run, completed-after. A crash mid-call leaves a
// truthful `pending` row, and never a write with no row.
//
// A store failure at either end is logged and never blocks the call. For
// `device.unload` and `device.exit_guided_load` that is a safety rule.
//
// A row holds the tool's name, a summary from `summariseCommand` (never the
// arguments), the live session id, the outcome and the tool's own error code.
// `result_json` stays null, and the input hash is one constant for every call,
// so no digest of what the caller sent is ever stored.

import { createHash, randomUUID } from 'node:crypto';
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ClientId } from '../client-connection.js';
import { log } from '../logger.js';
import type { ServerState } from '../state/server-state.js';
import { isUiActionDeviceId } from '../store/ui-action-device-id.js';
import { toolAccess } from '../tool-registry.js';
import type { ToolResult } from '../tools/helpers.js';
import { summariseCommand, type WriteToolName } from './command-summary.js';

type ToolHandler = (args: unknown, extra?: unknown) => Promise<ToolResult> | ToolResult;

/** Stored on every MCP row in place of a hash of the arguments. */
export const MCP_INPUT_HASH = createHash('sha256').update('mcp-call').digest('hex');

/** The code a row carries when the handler threw instead of answering. */
export const HANDLER_THREW = 'HANDLER_THREW';

interface Outcome {
  resultStatus: 'ok' | 'error';
  resultCode?: string;
}

function errorCodeOf(result: ToolResult): string | undefined {
  const text = result.content[0]?.text;
  if (text === undefined) return undefined;
  try {
    const code: unknown = (JSON.parse(text) as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

function outcomeOf(result: ToolResult): Outcome {
  if (result.isError !== true) return { resultStatus: 'ok' };
  const code = errorCodeOf(result);
  return code === undefined
    ? { resultStatus: 'error' }
    : { resultStatus: 'error', resultCode: code };
}

function liveSessionId(state: ServerState): string | undefined {
  for (const slot of state.slots.values()) {
    const session = slot.live.snapshotSession();
    if (session !== undefined) return session.sessionId;
  }
  return undefined;
}

async function claim(
  state: ServerState,
  self: ClientId,
  name: WriteToolName,
  args: unknown,
  actionId: string,
): Promise<boolean> {
  try {
    const summary = summariseCommand(name, args);
    const sessionId = liveSessionId(state);
    await state.store.claimUiAction({
      actionId,
      actionName: name,
      actor: 'coach',
      surface: 'mcp',
      ...(isUiActionDeviceId(self) ? { deviceId: self } : {}),
      ...(summary === null ? {} : { summaryJson: JSON.stringify(summary) }),
      ...(sessionId === undefined ? {} : { sessionId }),
      inputHash: MCP_INPUT_HASH,
      createdAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    log.warn(`mcp audit: could not record ${name}`, err);
    return false;
  }
}

async function complete(state: ServerState, actionId: string, outcome: Outcome): Promise<void> {
  try {
    await state.store.completeUiAction({
      actionId,
      ...outcome,
      result: null,
      completedAt: new Date().toISOString(),
    });
  } catch (err) {
    log.warn('mcp audit: could not complete a recorded call', err);
  }
}

function audited(
  name: WriteToolName,
  inner: ToolHandler,
  state: ServerState,
  self: ClientId,
): ToolHandler {
  return async (args: unknown, extra?: unknown): Promise<ToolResult> => {
    const actionId = randomUUID();
    const recorded = await claim(state, self, name, args, actionId);
    let result: ToolResult;
    try {
      result = await inner(args, extra);
    } catch (err) {
      if (recorded)
        await complete(state, actionId, { resultStatus: 'error', resultCode: HANDLER_THREW });
      throw err;
    }
    if (recorded) await complete(state, actionId, outcomeOf(result));
    return result;
  };
}

/**
 * Wrap every write-classified tool on this connection, lease-exempt ones
 * included. Call straight after `applyLeaseGuard`: this is the outermost wrap,
 * so a lease refusal is recorded with its code.
 */
export function applyMcpAudit(
  placeholders: Map<string, RegisteredTool>,
  state: ServerState,
  self: ClientId,
): void {
  for (const [name, tool] of placeholders) {
    if (toolAccess(name) !== 'write') continue;
    const inner = tool.handler as ToolHandler;
    tool.update({ callback: audited(name as WriteToolName, inner, state, self) as never });
  }
}
