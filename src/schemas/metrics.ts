// Input schema for `metrics.compute`.
//
// A discriminated union on `pipeline` makes the input target type-safe per
// pipeline kind. Each variant maps to a distinct analytics function in
// `@voltras/workout-analytics`; the Wave 3 handler dispatches based on the
// literal.
//
// `vbt.set` is fully resolved and merged: it dispatches to
// `getSetVelocitySummary(set)` in `@voltras/workout-analytics`, which returns
// the canonical single-set VBT result (first/last/best/mean/peak/lossPct/
// repCount). The PENDING/"undispatchable" note that used to live here was
// stale by the time it was read — see `metrics-tools.ts`'s `compute()`
// switch for the live dispatch.

import { z } from 'zod';
import { IdSchema } from './common.js';

/**
 * Input for `metrics.compute`. The `pipeline` literal selects which analytics
 * function the handler dispatches to.
 */
export const MetricsComputeInput = z.discriminatedUnion('pipeline', [
  // Single-set VBT metrics (velocity loss%, mean/peak velocity, ROM).
  z.object({ pipeline: z.literal('vbt.set'), setId: IdSchema }),

  // Multi-set load-velocity profile fitting + optional 1RM estimate.
  // Analytics: buildProfile(points) from @voltras/workout-analytics.
  //
  // `targetVelocity` (optional, m/s) inverts the fitted profile via
  // `estimateLoad` to recommend the load for that mean concentric velocity —
  // the load half of VBT that the warm-up ramp uses to size its next set. It
  // co-locates on this variant because the recommendation *requires* the
  // profile this pipeline already builds; a separate mode would have to rebuild
  // it. Omitted → the response is the bare profile (backward compatible).
  z.object({
    pipeline: z.literal('vbt.profile'),
    setIds: z.array(IdSchema).min(2),
    targetVelocity: z.number().positive().optional(),
  }),

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

  // Per-rep RIR (reps in reserve) from the VBT §5.3 regression (VW-134).
  // Analytics: estimateRIRWithProfile(inputs, profile) — DISTINCT from
  // `fatigue.set`'s RIR, which is the simpler velocity-loss interpolation.
  //
  // `targetReps` is the set's PLANNED length, which the model uses for its
  // rep-progress term (repIndex/repsInSet). Omitted → the actual rep count is
  // used, which makes the final rep's progress ratio exactly 1.0; supply the
  // prescribed target when there was one so a set cut short is not read as a
  // set taken to its planned end.
  z.object({
    pipeline: z.literal('vbt.rir'),
    setId: IdSchema,
    targetReps: z.number().int().positive().optional(),
  }),

  // Total session volume (load × reps) plus the B47 target-only set count.
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

  // Per-exercise first-vs-last working-set decay — B02's strength-loss half
  // (VMCP-06.10). `exerciseId` narrows the readout to one exercise; omitted →
  // every exercise the session recorded work for. A DISPLAYED metric: every
  // field is a ratio or a count, and nothing here is ever applied.
  z.object({
    pipeline: z.literal('session.perturbation'),
    sessionId: IdSchema,
    exerciseId: IdSchema.optional(),
  }),

  // Per-exercise retrospective junk-volume readout — the RETROSPECTIVE half of
  // B03 (VMCP-06.13). Reports each working set's within-set MEAN-concentric
  // loss beside its PEAK-based loss (the basis the live watch uses), and names
  // the first set past the mean-based junk threshold. `exerciseId` narrows as
  // above. Retrospective only: no push event, no watch change, no cue.
  z.object({
    pipeline: z.literal('session.junk_volume'),
    sessionId: IdSchema,
    exerciseId: IdSchema.optional(),
  }),

  // Per-rep mid-rep hesitation readout (VMCP-06.02 / B12). Analytics:
  // `detectHesitation(rep)` from `src/analytics/rep-faults.ts` — a velocity
  // trough strictly inside the concentric phase's own ROM window. A readout
  // only: no push event, no watch, no cue (see B14/VW-140-141).
  z.object({ pipeline: z.literal('quality.hesitation'), setId: IdSchema }),

  // Within-set ROM integrity readout (VW-93 / B09). Analytics:
  // `readRomIntegrity(reps)` from `src/analytics/rom-integrity.ts` — per-rep
  // ROM as a fraction of the set's own eligible median, first-to-last decay,
  // and a rep-to-rep coefficient of variation. The cross-session half
  // (`baseline.romVsBaselinePct`) is refused below a PROVISIONAL B57 baseline
  // and again when B15's `checkDriftGuard` says this set's session and the
  // reference session are not comparable, because a seat or attachment change
  // reads exactly like a ROM change. A readout only: no push event, no watch,
  // no cue.
  z.object({ pipeline: z.literal('quality.rom'), setId: IdSchema }),

  // Per-rep turnaround-dwell / eccentric-speed readout (VMCP-06.11 / B10).
  // Analytics: `detectBounce(rep)` from `src/analytics/rep-faults.ts`. A
  // readout only: no push event, no watch, no cue (see B14/VW-140-141).
  z.object({ pipeline: z.literal('quality.bounce'), setId: IdSchema }),

  // Cross-session trend + plateau for one exercise (VW-144/VW-145). Analytics:
  // buildTimeSeries + analyzeTrend + detectPlateau from @voltras/workout-analytics
  // over a ProcessedSession[] built from this exercise's own working,
  // owner-only sets (see `store/processed-session-mapper.ts`). `thresholdPct`/
  // `minDays`, when omitted, fall through to WA's OWN defaults (5, 14 —
  // trend.ts:202-206) — never redeclared here. Every plateau verdict carries
  // `phase: 'unknown'` until VW-150 decides diet-phase tagging: a fat-loss
  // phase can look like a plateau (B34).
  //
  // `history.weekly_volume` (VW-144's other half) does NOT exist yet:
  // `@voltras/workout-analytics@2.2.0`'s published root does not re-export
  // `getWeeklySummaries` / `getVolumeByMuscleGroup` (nor their `WeeklySummary`
  // / `VolumeByMuscleGroup` / `MetricKey` types) — only `buildTimeSeries` /
  // `analyzeTrend` / `detectPlateau` / `ProcessedSession` are public. It
  // follows once WA republishes with those exported; no local reimplementation
  // of WA's own aggregation logic in the meantime.
  z.object({
    pipeline: z.literal('history.trend'),
    exerciseId: IdSchema,
    weeks: z.number().int().positive().optional(),
    metric: z.enum(['topLoad', 'e1rm', 'volume']).optional(),
    thresholdPct: z.number().positive().optional(),
    minDays: z.number().int().positive().optional(),
  }),

  // Estimated 1RM (VW-142): three input shapes on one literal, all fields
  // optional at the schema level because which combination is valid is a
  // handler-level decision (see `metrics-tools.ts`'s `computeE1RM`):
  //   `{ load, reps }` — Epley formula, no baseline gate.
  //   `{ exerciseId }` — profile-based, built the same way `vbt.profile`
  //     builds its points, gated on `relative-signal` (the same gate
  //     `session.perturbation` / `session.junk_volume` use).
  //   both — hybrid, confidence-weighted combination of the two.
  // A lone `load` or a lone `reps`, or neither field present, is refused.
  z.object({
    pipeline: z.literal('strength.e1rm'),
    load: z.number().positive().optional(),
    reps: z.number().int().positive().optional(),
    exerciseId: IdSchema.optional(),
  }),
]);
