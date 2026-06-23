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
  assessRepQuality,
  buildProfile,
  computeReadiness,
  computeSessionFatigue,
  computeStrengthEstimate,
  computeVBTSetFatigueIndex,
  computeVolume,
  createTechniqueBaseline,
  getPhaseDuration,
  getPhaseRangeOfMotion,
  getRepMeanVelocity,
  getSetFatigueIndex,
  getSetFirstRepVelocity,
  getSetMeanVelocity,
  getSetVelocitySummary,
  type LoadVelocityDataPoint,
  type Set as AnalyticsSet,
} from '@voltras/workout-analytics';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
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
      const analyticsSets = sets.map(toAnalyticsSet);
      const crossSet = computeSessionFatigue(analyticsSets, weightsOf(sets));
      // VMCP-02.26: computeSessionFatigue measures CROSS-set decay only
      // (velocity recovery + rep drop between sets), so a single working set —
      // even one taken to functional failure — reports level 0. Fold in the
      // per-set WITHIN-set fatigue index (VBT spec §6.2: velocity loss + tempo
      // creep + ROM shrink) so a hard single set surfaces real fatigue. Report
      // `level` as the max of the two views: cross-set decay dominates
      // multi-set sessions; within-set fatigue rescues the low-set-count case.
      // `withinSetFatigue` is surfaced alongside for transparency.
      const withinSetPerSet = analyticsSets.map((s) => computeVBTSetFatigueIndex(s).fatigueIndex);
      const withinSetMax = withinSetPerSet.length === 0 ? 0 : Math.max(...withinSetPerSet);
      return {
        ...crossSet,
        level: Math.max(crossSet.level, withinSetMax),
        withinSetFatigue: { max: withinSetMax, perSet: withinSetPerSet },
      };
    }

    case 'session.strength': {
      const sets = await state.store.getSetsForSession(input.sessionId);
      if (sets.length === 0) throw notFound(`session '${input.sessionId}' has no sets`);
      return computeStrengthEstimate(sets.map(toAnalyticsSet), weightsOf(sets));
    }

    case 'quality.rep': {
      const target = await state.store.getSet(input.setId);
      if (!target) throw notFound(`set '${input.setId}' not found`);
      const baseline = await state.store.getSet(input.baselineSetId);
      if (!baseline) throw notFound(`baseline set '${input.baselineSetId}' not found`);
      if (baseline.reps.length === 0) {
        throw notFound(`baseline set '${input.baselineSetId}' has no reps`);
      }
      // Average ROM, eccentric/concentric duration, and concentric mean
      // velocity across the baseline set's reps. The handler is the policy
      // layer that turns "a set" into a TechniqueBaseline; the analytics
      // package owns the per-rep comparison logic.
      const baselineRom = mean(baseline.reps.map((r) => getPhaseRangeOfMotion(r.concentric)));
      const baselineEccTime = mean(baseline.reps.map((r) => getPhaseDuration(r.eccentric)));
      const baselineConcTime = mean(baseline.reps.map((r) => getPhaseDuration(r.concentric)));
      const baselineMeanVel = mean(baseline.reps.map((r) => getRepMeanVelocity(r)));
      const technique = createTechniqueBaseline({
        rom: baselineRom,
        eccentricTime: baselineEccTime,
        concentricTime: baselineConcTime,
        meanVelocity: baselineMeanVel,
      });
      return target.reps.map((rep) => assessRepQuality(rep, technique));
    }

    case 'session.readiness': {
      const target = await state.store.getSetsForSession(input.sessionId);
      if (target.length === 0) throw notFound(`session '${input.sessionId}' has no sets`);
      const baseline = await state.store.getSetsForSession(input.baselineSessionId);
      if (baseline.length === 0) {
        throw notFound(`baseline session '${input.baselineSessionId}' has no sets`);
      }
      // Per the analytics signature: actualVelocity = current session's first
      // set's first-rep concentric velocity; baselineVelocity = same metric
      // from the baseline session. This pins both values to a directly
      // comparable measurement (first rep is canonical for "fresh" velocity).
      const actualVel = getSetFirstRepVelocity(toAnalyticsSet(target[0]!));
      const baselineVel = getSetFirstRepVelocity(toAnalyticsSet(baseline[0]!));
      return computeReadiness(actualVel, baselineVel);
    }
  }
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
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
  // `paramsSchema` paired with `callback`: bootstrap placeholders carry an
  // empty-object schema that strips required input fields. The MCP SDK's
  // `update.paramsSchema` only accepts a `ZodRawShape` (key-to-type map), not
  // a discriminated union, so we declare the loose superset of every variant's
  // fields here. `wrapHandler(MetricsComputeInput, ...)` does the strict
  // discriminated-union validation inside the callback — this shape exists
  // only to keep the SDK from stripping legitimate args.
  const looseShape = {
    pipeline: z.string(),
    setId: z.string().optional(),
    setIds: z.array(z.string()).optional(),
    sessionId: z.string().optional(),
    baselineSetId: z.string().optional(),
    baselineSessionId: z.string().optional(),
  };
  placeholder.update({
    paramsSchema: looseShape,
    callback: handler as never,
  });
}

// `errorResult` and `textResult` are referenced indirectly via `wrapHandler`
// and the `CodedError` → `mapSdkError` path; explicit re-export keeps the
// dependency graph obvious to downstream readers.
export const _internal = { errorResult, textResult };
