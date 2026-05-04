// `metrics.compute` — Wave 3C dispatcher (Task 12).
//
// One MCP tool, one zod discriminated union, eight pipelines, eight distinct
// `@voltras/workout-analytics` functions. The handler's only jobs are:
//
//   1. Fetch the targeted persistence rows (`getSet`, `getSetsForSession`).
//   2. Adapt the storage shape to the analytics function's input shape
//      (always pure plumbing — no rep math here).
//   3. Dispatch to the analytics function.
//
// Per AC-20: zero analytics computation logic lives here. Per EC-07: a missing
// target id short-circuits to a `NOT_FOUND` error result before any analytics
// function is invoked.
//
// ── `vbt.set` resolution (briefing Step 1) ────────────────────────────────
//
// `@voltras/workout-analytics@0.2.0` exposes `getSetVelocitySummary(set)`
// returning `{ first, last, best, mean, peak, lossPct, repCount }` — the
// canonical "single-set VBT result" the schema's `vbt.set` literal points
// at. The schema's `PENDING` comment is satisfied by binding `vbt.set` to
// `getSetVelocitySummary`. No schema change required.
//
// ── Pipelines NOT_IMPLEMENTED in this wave ─────────────────────────────────
//
// `quality.rep` — `assessRepQuality(rep, baseline, schemes?)` requires a
// `TechniqueBaseline` not present in the schema. Building one here would
// inject invented expectations, which is exactly the analytics logic AC-20
// forbids. Returns `NOT_IMPLEMENTED` until the schema gains a baseline
// argument or the analytics package ships a baseline-free overload.
//
// `session.readiness` — `computeReadiness(actualVelocity, baselineVelocity)`
// takes two scalars; deriving them from a `sessionId` requires policy
// decisions (which set's first rep counts as "actual"? whose history is
// the baseline?). Returns `NOT_IMPLEMENTED` until the schema gains explicit
// scalar inputs or a session-level overload ships.

import {
  buildProfile,
  computeSessionFatigue,
  computeStrengthEstimate,
  computeVolume,
  getSetFatigueIndex,
  getSetMeanVelocity,
  getSetVelocitySummary,
  type LoadVelocityDataPoint,
  type Set as AnalyticsSet,
} from '@voltras/workout-analytics';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { MetricsComputeInput } from '../schemas/metrics.js';
import type { ServerState } from '../state/server-state.js';
import type { StoredSet } from '../store/types.js';
import { errorResult, textResult, wrapHandler, type ToolResult } from './helpers.js';

type MetricsComputeInputType = z.infer<typeof MetricsComputeInput>;

const TOOL_NAME = 'metrics.compute';

/**
 * Coerce a `StoredSet` row into the `Set` shape the analytics package
 * consumes. `StoredRep extends Rep` (compile-time guard in `store/types.ts`)
 * means the rep array passes through untouched; the `loadSettings` field is
 * intentionally omitted because session-level callers pass weights as a
 * parallel array argument.
 */
function toAnalyticsSet(stored: StoredSet): AnalyticsSet {
  return { reps: stored.reps };
}

/**
 * Build the parallel `weights` array the session-level analytics functions
 * accept, sourced from each `StoredSet.weightLbs`.
 */
function weightsOf(sets: readonly StoredSet[]): number[] {
  return sets.map((s) => s.weightLbs);
}

/**
 * Dispatch core. Returns either the analytics function's output (which
 * `wrapHandler` wraps in `textResult`) or a `ToolResult` error directly when
 * a pre-dispatch guard fails. Throwing a tagged error lets `wrapHandler`'s
 * existing `mapSdkError` path produce the structured `errorResult` for us
 * without a second control-flow channel.
 */
async function compute(state: ServerState, input: MetricsComputeInputType): Promise<unknown> {
  switch (input.pipeline) {
    case 'vbt.set': {
      const set = await state.store.getSet(input.setId);
      if (!set) throw notFound(`set '${input.setId}' not found`);
      return getSetVelocitySummary(toAnalyticsSet(set));
    }

    case 'vbt.profile': {
      const sets = await Promise.all(input.setIds.map((id: string) => state.store.getSet(id)));
      const missingIdx = sets.findIndex((s) => s === undefined);
      if (missingIdx >= 0) {
        throw notFound(`set '${input.setIds[missingIdx]}' not found`);
      }
      const points: LoadVelocityDataPoint[] = (sets as StoredSet[]).map((s) => ({
        load: s.weightLbs,
        velocity: getSetMeanVelocity(toAnalyticsSet(s)),
      }));
      return buildProfile(points);
    }

    case 'fatigue.set': {
      const set = await state.store.getSet(input.setId);
      if (!set) throw notFound(`set '${input.setId}' not found`);
      return getSetFatigueIndex(toAnalyticsSet(set));
    }

    case 'session.volume': {
      const sets = await state.store.getSetsForSession(input.sessionId);
      if (sets.length === 0) throw notFound(`session '${input.sessionId}' has no sets`);
      return computeVolume(sets.map(toAnalyticsSet), weightsOf(sets));
    }

    case 'session.fatigue': {
      const sets = await state.store.getSetsForSession(input.sessionId);
      if (sets.length === 0) throw notFound(`session '${input.sessionId}' has no sets`);
      return computeSessionFatigue(sets.map(toAnalyticsSet), weightsOf(sets));
    }

    case 'session.strength': {
      const sets = await state.store.getSetsForSession(input.sessionId);
      if (sets.length === 0) throw notFound(`session '${input.sessionId}' has no sets`);
      return computeStrengthEstimate(sets.map(toAnalyticsSet), weightsOf(sets));
    }

    case 'quality.rep':
      throw notImplemented(
        "pipeline 'quality.rep' requires a TechniqueBaseline argument not present in the schema",
      );

    case 'session.readiness':
      throw notImplemented(
        "pipeline 'session.readiness' requires actual+baseline velocity scalars not derivable from a session id",
      );
  }
}

class CodedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CodedError';
    this.code = code;
  }
}
const notFound = (msg: string): CodedError => new CodedError('NOT_FOUND', msg);
const notImplemented = (msg: string): CodedError => new CodedError('NOT_IMPLEMENTED', msg);

/**
 * Hot-swap the placeholder `metrics.compute` callback installed at server
 * startup with the live dispatcher. Mirrors the pattern Wave 1 documented
 * in `server.ts` and `state/server-state.ts`.
 */
export function registerMetricsTools(
  server: McpServer,
  state: ServerState,
  placeholders: Map<string, RegisteredTool>,
): void {
  void server; // `tool()` is only called via the placeholder's `update`.
  const placeholder = placeholders.get(TOOL_NAME);
  if (!placeholder) {
    throw new Error(`registerMetricsTools: missing '${TOOL_NAME}' placeholder`);
  }
  const handler: (args: unknown, extra?: unknown) => Promise<ToolResult> = wrapHandler(
    MetricsComputeInput,
    (input) => compute(state, input),
  );
  placeholder.update({ callback: handler });
}

// `errorResult` and `textResult` are referenced indirectly via `wrapHandler`
// and the `CodedError` → `mapSdkError` path; explicit re-export keeps the
// dependency graph obvious to downstream readers.
export const _internal = { errorResult, textResult };
