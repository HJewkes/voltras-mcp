// Wave 3D — `exercise.search` and `exercise.get` tool registrations.
//
// Both tools are pure pass-throughs to the `ExerciseService` (R22 / AC-22):
// the wave-2B service owns the upstream catalog seam (`searchExercises`,
// `getExerciseById`), so this module never touches `@voltras/workout-analytics`
// directly. Search forwards `query` verbatim; get translates a missing entry
// into a structured `NOT_FOUND` error rather than letting `undefined` leak
// through as a `null` text payload.
//
// Registration mechanics: the server boots with `STARTING`-returning
// placeholders pre-registered for every tool name (see `src/server.ts`).
// Wave 3 hot-swaps the real callback in via `RegisteredTool.update({...})`;
// this preserves the original `RegisteredTool` reference, lets every tool
// register concurrently without ordering against `tools/list` notifications,
// and avoids the missing-tool window between `remove()` and a fresh
// `server.tool(...)` call. `server` is accepted in the signature for
// consistency with the wave-3 register-fn convention but is not currently
// used here — every callback attaches via the placeholder.
//
// Why `exercise.get` does not use `wrapHandler`: `wrapHandler` always frames
// the inner function's return value via `textResult`, which is right for the
// success path but would double-wrap a `NOT_FOUND` `errorResult`. We re-use
// the same pieces — `safeParse` for INVALID_INPUT, `mapSdkError` via try/catch
// — but compose them inline so `getById === undefined` can return the error
// result directly.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mapSdkError } from '../errors.js';
import { ExerciseGetInput, ExerciseSearchInput } from '../schemas/exercise.js';
import type { ServerState } from '../state/server-state.js';
import { errorResult, textResult, wrapHandler, type ToolResult } from './helpers.js';

/**
 * Swap real handlers for `exercise.search` and `exercise.get` into their
 * `STARTING` placeholders. Idempotent against the placeholder Map: if a
 * placeholder is missing the entry is skipped, which keeps the function safe
 * to call after `mock` placeholder cleanup in `runServer`.
 */
export function registerExerciseTools(
  _server: McpServer,
  state: ServerState,
  placeholders: Map<string, RegisteredTool>,
): void {
  const search = wrapHandler(ExerciseSearchInput, async ({ query }) => {
    return state.exercises.search(query);
  });
  placeholders.get('exercise.search')?.update({
    paramsSchema: ExerciseSearchInput.shape,
    callback: search as never,
  });

  placeholders.get('exercise.get')?.update({
    paramsSchema: ExerciseGetInput.shape,
    callback: makeGetCallback(state) as never,
  });
}

/**
 * Build the `exercise.get` callback. Cannot use `wrapHandler` because the
 * `undefined` return from `getById` must become a `NOT_FOUND` `ToolResult`,
 * not a `textResult(undefined)`.
 */
function makeGetCallback(
  state: ServerState,
): (args: unknown, extra?: unknown) => Promise<ToolResult> {
  return async (args: unknown, _extra?: unknown): Promise<ToolResult> => {
    const parsed = ExerciseGetInput.safeParse(args);
    if (!parsed.success) {
      return errorResult({ code: 'INVALID_INPUT', message: parsed.error.message });
    }
    try {
      const exercise = state.exercises.getById(parsed.data.id);
      if (exercise === undefined) {
        return errorResult({
          code: 'NOT_FOUND',
          message: `Exercise not found: ${parsed.data.id}`,
        });
      }
      return textResult(exercise);
    } catch (err) {
      return errorResult(mapSdkError(err));
    }
  };
}
