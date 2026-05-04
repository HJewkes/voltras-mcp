// Input schema for `metrics.compute`.
//
// A discriminated union on `pipeline` makes the input target type-safe per
// pipeline kind. Each variant maps to a distinct analytics function in
// `@voltras/workout-analytics`; the Wave 3 handler dispatches based on the
// literal.
//
// PENDING: verify backing function with WA owner before Wave 3.
// The `vbt.set` variant has no known set-level VBT function in
// `@voltras/workout-analytics` (the VBT module is profile/rep-scoped:
// `buildProfile`, `fitLVProfile`, `predictVelocity`, `estimateLoad`, etc.).
// Per critic-report.md, this variant is undispatchable as currently designed.
// Wave 3 (metrics-tools.ts) MUST resolve one of:
//   (a) confirm an existing WA function that produces a set-level VBT result;
//   (b) compose a set-level VBT result from rep-level fields without
//       reimplementing analytics logic in this repo;
//   (c) remove the `vbt.set` variant from this union.
// Do not merge PR 3 until this is resolved.

import { z } from 'zod';
import { IdSchema } from './common.js';

/**
 * Input for `metrics.compute`. The `pipeline` literal selects which analytics
 * function the handler dispatches to.
 */
export const MetricsComputeInput = z.discriminatedUnion('pipeline', [
  // PENDING: verify backing function with WA owner before Wave 3.
  // Single-set VBT metrics (velocity loss%, mean/peak velocity, ROM).
  z.object({ pipeline: z.literal('vbt.set'), setId: IdSchema }),

  // Multi-set load-velocity profile fitting + optional 1RM estimate.
  // Analytics: buildProfile(points) from @voltras/workout-analytics.
  z.object({ pipeline: z.literal('vbt.profile'), setIds: z.array(IdSchema).min(2) }),

  // Per-rep quality flags. Requires a baseline set whose reps establish
  // the expected ROM / phase timings / mean velocity. The handler builds
  // a TechniqueBaseline from the baseline set's reps and calls
  // assessRepQuality(rep, baseline) for each rep in the target set.
  z.object({
    pipeline: z.literal('quality.rep'),
    setId: IdSchema,
    baselineSetId: IdSchema,
  }),

  // Set-level fatigue index (RPE, RIR, confidence).
  // Analytics: getSetFatigueIndex(set) from @voltras/workout-analytics.
  z.object({ pipeline: z.literal('fatigue.set'), setId: IdSchema }),

  // Total session volume (load × reps).
  // Analytics: computeVolume(session) from @voltras/workout-analytics.
  z.object({ pipeline: z.literal('session.volume'), sessionId: IdSchema }),

  // Session readiness score. Requires a baseline session whose first
  // set's first rep mean velocity is the reference; the handler reads
  // the same metric off the target session and calls
  // computeReadiness(actualVel, baselineVel).
  z.object({
    pipeline: z.literal('session.readiness'),
    sessionId: IdSchema,
    baselineSessionId: IdSchema,
  }),

  // Session fatigue accumulation.
  // Analytics: computeSessionFatigue(session) from @voltras/workout-analytics.
  z.object({ pipeline: z.literal('session.fatigue'), sessionId: IdSchema }),

  // Strength estimate from session data.
  // Analytics: computeStrengthEstimate(session) from @voltras/workout-analytics.
  z.object({ pipeline: z.literal('session.strength'), sessionId: IdSchema }),
]);
