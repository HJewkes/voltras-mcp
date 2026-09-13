// `rir_velocity.fit` and `rir_velocity.target` handlers (VW-298).
//
// The pair exists because fitting and reading are different operations with
// different costs: `fit` walks every working set for an exercise and rewrites
// the stored curve, `target` reads one row. Merging them would make every
// prescription lookup re-run a regression over the lifter's whole history.
//
// `target` NEVER FALLS BACK TO A GROUP CURVE. Jukic et al. 2024 found general
// models failed at 70% 1RM — the part of the band most working sets sit in — so
// the honest answer with no fitted curve is the stated caveat and no number.
// See `analytics/rir-velocity.ts`.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import {
  GENERAL_MODEL_CAVEAT,
  JUKIC_2024_CITATION,
  JUKIC_2024_FINDING,
  velocityForRir,
  type RirVelocityModel,
} from '../analytics/rir-velocity.js';
import { RirVelocityFitInput, RirVelocityTargetInput } from '../schemas/rir-velocity.js';
import type { ServerState } from '../state/server-state.js';
import { LOCAL_USER_ID } from '../store/types.js';
import type { SessionStore } from '../store/types.js';
import { wrapHandler } from './helpers.js';

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

const FIT_DESCRIPTION =
  "Re-fit this lifter's own RIR-velocity curve for one exercise from their recorded working " +
  'sets, and store it. Qualifying sets are those in the 70-90% band of estimated 1RM that ended ' +
  'at failure or carry a self-reported reps-in-reserve; every rep in such a set is one point, ' +
  'with reps in reserve counted back from the last rep. Returns `fitted`, a `reason` naming ' +
  'either what the fit stands on or which minimum was not met, the `model` itself when one ' +
  'stands (a linear fit, with `r2` and `rirErrorReps` — the residual error expressed in reps, ' +
  'the unit the source paper reports), and a `qualification` count of sets, sessions and reps ' +
  'considered. A fit that fails its minimums DELETES any previously stored curve rather than ' +
  'leaving a stale one readable. Individual curves are the whole point: ' +
  JUKIC_2024_FINDING;

const TARGET_DESCRIPTION =
  "Convert a reps-in-reserve prescription into this lifter's own velocity target for one " +
  'exercise. Returns `velocityTargetMps` from their fitted curve, plus `withinFittedRange` — ' +
  'false means the requested reps-in-reserve sits outside the range the curve was fitted over, ' +
  'so the number is an extrapolation. With NO fitted curve, `velocityTargetMps` is null and ' +
  '`caveat` carries the stated general-model text: this server does not substitute a group ' +
  'curve, because general models failed at 70% of 1RM, which is where most working sets sit. ' +
  'Run `rir_velocity.fit` first after recording new qualifying sets — this tool reads the ' +
  'stored curve and never re-fits. ' +
  JUKIC_2024_FINDING;

/** Hot-swap the `rir_velocity.*` placeholders with their real handlers. */
export function registerRirVelocityTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
  install(
    placeholders,
    'rir_velocity.fit',
    RirVelocityFitInput,
    wrapHandler(RirVelocityFitInput, (input) => fit(state, input)),
    FIT_DESCRIPTION,
  );
  install(
    placeholders,
    'rir_velocity.target',
    RirVelocityTargetInput,
    wrapHandler(RirVelocityTargetInput, (input) =>
      resolveRirVelocityTarget(state.store, input.exerciseId, input.rir),
    ),
    TARGET_DESCRIPTION,
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

async function fit(
  state: ServerState,
  input: z.infer<typeof RirVelocityFitInput>,
): Promise<{
  exerciseId: string;
  fitted: boolean;
  reason: string;
  model: RirVelocityModel | null;
  qualification: Record<string, number>;
}> {
  const result = await state.store.refitRirVelocityModel(LOCAL_USER_ID, input.exerciseId);
  return {
    exerciseId: input.exerciseId,
    fitted: result.model !== null,
    reason: result.reason,
    model: result.model,
    qualification: { ...result.qualification },
  };
}

/** What a caller gets when asking a reps-in-reserve prescription for a velocity. */
export interface RirVelocityTargetResult {
  exerciseId: string;
  rir: number;
  /** Null exactly when this lifter has no fitted curve for the exercise. */
  velocityTargetMps: number | null;
  /** Null when there is no curve; false when the answer extrapolates past it. */
  withinFittedRange: boolean | null;
  /** The stored fit's R², or null when there is no curve. */
  fitQuality: number | null;
  /** The fit's error in reps in reserve, the unit Jukic 2024 reports. */
  rirErrorReps: number | null;
  /** The general-model text, present exactly when there is no curve. */
  caveat: string | null;
  citation: string;
}

/**
 * The one conversion from a reps-in-reserve prescription to a velocity, shared
 * by `rir_velocity.target` and `coaching.explain` so the two can never answer
 * the same question differently.
 */
export async function resolveRirVelocityTarget(
  store: SessionStore,
  exerciseId: string,
  rir: number,
): Promise<RirVelocityTargetResult> {
  const stored = await store.getRirVelocityModel(LOCAL_USER_ID, exerciseId);
  const base = { exerciseId, rir, citation: JUKIC_2024_CITATION };
  if (stored === undefined) {
    return {
      ...base,
      velocityTargetMps: null,
      withinFittedRange: null,
      fitQuality: null,
      rirErrorReps: null,
      caveat: GENERAL_MODEL_CAVEAT,
    };
  }
  const model = stored.model as unknown as RirVelocityModel;
  const target = velocityForRir(model, rir);
  return {
    ...base,
    velocityTargetMps: target.velocityMps,
    withinFittedRange: target.withinFittedRange,
    fitQuality: stored.fitQuality,
    rirErrorReps: model.rirErrorReps,
    caveat: null,
  };
}
