// `plan.warmup_ramp` — the RP warm-up ramp, generated instead of invented
// (VMCP-06.08 / B25).
//
// The pt-session skill made up a warm-up every session, and the 2026-09-07
// dogfood found those improvised rungs polluting baselines (VW-168). The ramp
// itself is not a judgement call: 12 reps at roughly 30RM, 8 at roughly 20RM,
// 4 at roughly 10RM before the FIRST exercise for a muscle group, then a
// single brief feel set for later exercises on a muscle that is already warm.
// That shape is the one number the RP corpus verifies TIER-INVARIANT, and
// `coaching.explain live.warmup_protocol` carries the same prose.
//
// A READ, and only a read. It returns rows; the agent starts each one with
// `set.start { setPurpose: 'warmup' }` and may skip or shorten the ramp on the
// lifter's say-so (backlog Addendum 4 decision 2: advisory, never blocking).
//
// OUT OF SCOPE, deliberately: per-user/per-exercise deviation learning. Warm-up
// SET COUNT is individual (2 to 5 sets), but learning an individual's count
// waits on B56 baselines reaching PROVISIONAL for the exercise. v1 ships the
// population ramp, widened or narrowed only by the tier signal.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { estimateE1RMFromReps } from '@voltras/workout-analytics';

import { PlanWarmupRampInput } from '../schemas/plan.js';
import type { ServerState } from '../state/server-state.js';
import { PRIMARY_SLOT } from '../state/server-state.js';
import { setPurposeOf } from '../store/set-purpose.js';
import type { StoredSet } from '../store/types.js';
import { getTierSignal, type Tier } from './tier-signal.js';
import { wrapHandler } from './helpers.js';

/**
 * The device takes integer pounds — `device.set_weight` is
 * `z.number().int().min(5).max(200)` (src/schemas/device.ts). The SDK's
 * `getAvailableWeights()` enumerates the same integer ladder, so 1 lb is the
 * real step rather than a fallback.
 */
const DEVICE_LOAD_STEP_LBS = 1;

/** `device.set_weight`'s own floor. A rung below it is not settable. */
const DEVICE_MIN_LOAD_LBS = 5;

/**
 * What rep-max the working load is treated as, to anchor the ramp's e1RM.
 *
 * The caller gives a load, not the reps they will get on it, so an assumption
 * is unavoidable. Reading it as the HEAVIEST plausible reading — a 5RM at the
 * top of a 5-10 hypertrophy band — puts the ramp on the light side, which is
 * the safe direction to be wrong about a warm-up. Replaced by the real
 * per-exercise number once B56 baselines reach PROVISIONAL.
 */
const WORKING_LOAD_ASSUMED_RM = 5;

export interface WarmupRampRow {
  order: number;
  reps: number;
  weightLbs: number;
  setPurpose: 'warmup';
  focus: string;
}

export interface WarmupRamp {
  rows: WarmupRampRow[];
  feelSetOnly: boolean;
  reason: string;
}

class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ToolError';
  }
}

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

export const PLAN_WARMUP_RAMP_DESCRIPTION =
  'Propose a warm-up ramp for one exercise at one working load. READ-ONLY: it returns rows, ' +
  'writes nothing, and never starts a set — you start each row yourself with ' +
  '`set.start { setPurpose: "warmup" }`, and you may skip or shorten the ramp if the lifter ' +
  "says they are already warm. The ramp is RP's: 12 reps at roughly 30RM, 8 at roughly 20RM, " +
  '4 at roughly 10RM before the FIRST exercise for a muscle group, then a single 3-6 rep feel ' +
  'set at the working load for later exercises on a muscle that is already warm (call ' +
  '`coaching.explain { topic: "live.warmup_protocol" }` for the sourced prose). Each row ' +
  'carries its OWN coaching focus — cadence, then position, then bracing and eccentric ' +
  'control — rather than generic "warming up" copy. Loads are derived from ' +
  '`workingWeightLbs` via the e1RM helpers, rounded DOWN to the device load step and never ' +
  'above the working load. `feelSetOnly: true` means the muscle was already warmed by an ' +
  'earlier exercise in the active session, and `reason` says which. The experience tier ' +
  'changes only the set COUNT (a beginner gets one extra practice rung, an advanced lifter ' +
  'drops the 12-rep rung); the percentages are tier-invariant. Per-lifter, per-exercise ' +
  'deviations are NOT modelled yet — that needs the exercise baseline at PROVISIONAL — so ' +
  'treat the count as a population starting point and adjust on what the lifter tells you.';

export function registerWarmupRampTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
  const tool = placeholders.get('plan.warmup_ramp');
  if (tool === undefined) {
    throw new Error('tool placeholder not registered: plan.warmup_ramp');
  }
  tool.update({
    paramsSchema: PlanWarmupRampInput.shape,
    callback: wrapHandler(PlanWarmupRampInput, (input: z.infer<typeof PlanWarmupRampInput>) =>
      buildWarmupRamp(state, input),
    ) as never,
    description: PLAN_WARMUP_RAMP_DESCRIPTION,
  } as never);
}

/**
 * Invert the Epley estimate the analytics package applies forward.
 *
 * `estimateE1RMFromReps` is `e1RM = load * (1 + reps / 30)` and the package
 * publishes no inverse, so this is that one line solved for `load`. The
 * round-trip is covered by a table test against the forward helper — the two
 * must never drift into two different formulas.
 */
export function loadForReps(e1rm: number, reps: number): number {
  return e1rm / (1 + reps / 30);
}

/** The RM anchor and coaching focus of each rung, heaviest last. */
const RAMP_RUNGS: ReadonlyArray<{ reps: number; anchorRm: number; focus: string }> = [
  {
    reps: 12,
    anchorRm: 30,
    focus: 'Establish cadence: deliberate pauses, the tempo you intend to hold all session.',
  },
  {
    reps: 8,
    anchorRm: 20,
    focus: 'Find your position over the target muscle and micro-adjust it.',
  },
  {
    reps: 4,
    anchorRm: 10,
    focus: 'Brace, and control the eccentric — the last rung before the working load.',
  },
];

/** The beginner's extra rung: the same load again, practising the pattern. */
const BEGINNER_PRACTICE_RUNG = {
  reps: 8,
  anchorRm: 20,
  focus: 'Repeat the same load — practise the groove. No new information, just reps.',
} as const;

const FEEL_SET_REPS = 5;

const FEEL_SET_FOCUS =
  'One brief feel set at the working load — the muscle is already warm; confirm the groove.';

/**
 * Which rungs this tier performs. The RAMP is tier-invariant; only how many
 * times the lifter climbs it is not (audit §2a). A beginner gets one extra
 * practice rung at an existing load, an advanced lifter skips the lightest.
 */
function rungsForTier(
  tier: Tier,
): ReadonlyArray<{ reps: number; anchorRm: number; focus: string }> {
  if (tier === 'advanced') return RAMP_RUNGS.slice(1);
  if (tier === 'beginner') {
    return [RAMP_RUNGS[0]!, BEGINNER_PRACTICE_RUNG, RAMP_RUNGS[1]!, RAMP_RUNGS[2]!];
  }
  return RAMP_RUNGS;
}

/**
 * Round a computed rung load onto the device's ladder.
 *
 * DOWN, never up: a warm-up rung that lands above its target is a warm-up
 * doing working-set damage. Clamped below the working load for the same
 * reason, and up to the device's minimum settable weight.
 */
function toDeviceLoad(raw: number, workingWeightLbs: number): number {
  const ceiling = workingWeightLbs - DEVICE_LOAD_STEP_LBS;
  const stepped = Math.floor(raw / DEVICE_LOAD_STEP_LBS) * DEVICE_LOAD_STEP_LBS;
  return Math.max(DEVICE_MIN_LOAD_LBS, Math.min(stepped, ceiling));
}

/**
 * The rungs themselves, for one load and one tier.
 *
 * Exported because `getTierSignal` currently clamps its ceiling at
 * `'intermediate'` (tier-signal.ts — the MVP has no advanced derivation), so
 * the advanced shape is only reachable directly until that lands.
 */
export function rampRows(workingWeightLbs: number, tier: Tier): WarmupRampRow[] {
  const e1rm = estimateE1RMFromReps(workingWeightLbs, WORKING_LOAD_ASSUMED_RM).e1RM;
  return rungsForTier(tier).map((rung, index) => ({
    order: index + 1,
    reps: rung.reps,
    weightLbs: toDeviceLoad(loadForReps(e1rm, rung.anchorRm), workingWeightLbs),
    setPurpose: 'warmup' as const,
    focus: rung.focus,
  }));
}

function feelSetRows(workingWeightLbs: number): WarmupRampRow[] {
  return [
    {
      order: 1,
      reps: FEEL_SET_REPS,
      weightLbs: workingWeightLbs,
      setPurpose: 'warmup' as const,
      focus: FEEL_SET_FOCUS,
    },
  ];
}

/** The whole tool, minus the MCP envelope. */
export async function buildWarmupRamp(
  state: ServerState,
  input: z.infer<typeof PlanWarmupRampInput>,
): Promise<WarmupRamp> {
  const exercise = state.exercises.getById(input.exerciseId);
  if (exercise === undefined) {
    throw new ToolError('NOT_FOUND', `No exercise with id "${input.exerciseId}" exists.`);
  }
  const warmedBy = await findWarmingExercise(state, input.slot, exercise.muscleGroups);
  if (warmedBy !== null) {
    return {
      rows: feelSetRows(input.workingWeightLbs),
      feelSetOnly: true,
      reason: `${warmedBy} already warmed ${exercise.muscleGroups.join('/')} this session, so one 3-6 rep feel set at the working load is enough.`,
    };
  }
  const { tier } = await getTierSignal(state);
  const rows = rampRows(input.workingWeightLbs, tier);
  return {
    rows,
    feelSetOnly: false,
    reason: `First exercise for ${exercise.muscleGroups.join('/')} this session — full ramp, ${rows.length} rungs at the ${tier} set count.`,
  };
}

/**
 * The display name of an exercise that already warmed one of `muscleGroups`
 * in the active session, or `null` when the muscle is cold.
 *
 * "Warmed" means a COMPLETED WORKING set: a warm-up rung does not warm the
 * next exercise (it is the ramp we are deciding about), a probe is one heavy
 * effort rather than a warm-up, and a set still in progress has not happened
 * yet.
 */
async function findWarmingExercise(
  state: ServerState,
  slotId: string | undefined,
  muscleGroups: string[],
): Promise<string | null> {
  const sessionId = activeSessionId(state, slotId);
  if (sessionId === null) return null;
  const wanted = new Set(muscleGroups);
  for (const set of await state.store.getSetsForSession(sessionId)) {
    if (!isCompletedWorkingSet(set) || set.exerciseId === undefined) continue;
    const prior = state.exercises.getById(set.exerciseId);
    if (prior?.muscleGroups.some((group) => wanted.has(group)) === true) return prior.name;
  }
  return null;
}

function isCompletedWorkingSet(set: StoredSet): boolean {
  return set.endedAt !== undefined && set.reps.length > 0 && setPurposeOf(set) === 'working';
}

/**
 * The session the "already warm" check reads. A named `slot` is answered by
 * that slot alone; without one, any slot holding a session counts — a lifter
 * working one exercise bilaterally has two slots and one warm muscle.
 */
function activeSessionId(state: ServerState, slotId: string | undefined): string | null {
  if (slotId !== undefined) {
    return state.slots.get(slotId)?.live.session?.sessionId ?? null;
  }
  const primary = state.slots.get(PRIMARY_SLOT)?.live.session?.sessionId;
  if (primary !== undefined) return primary;
  for (const slot of state.slots.values()) {
    const sessionId = slot.live.session?.sessionId;
    if (sessionId !== undefined) return sessionId;
  }
  return null;
}
