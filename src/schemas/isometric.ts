// Input schemas for the isometric assessment tools.
//
// The protocol parameters (defaults + clamps) come from
// coordination/research/isometric-protocol-2026-05-09.md. Each clamp here
// reflects a published evidence range — see the brief's "Recommended Voltra
// Protocol" section. Defaults match the unilateral baseline (5s holds × 3
// trials with 90s rest within side / 120s between sides, non-dominant first).

import { z } from 'zod';

import { SlotIdSchema } from './common.js';

/** Default hold duration per trial (5 seconds). */
export const DEFAULT_DURATION_MS = 5_000;
/** Default trials per side (3). */
export const DEFAULT_TRIALS = 3;
/** Default rest between trials within the same side (90 seconds). */
export const DEFAULT_REST_MS = 90_000;
/** Default rest between sides for the imbalance tool (120 seconds). */
export const DEFAULT_BETWEEN_SIDES_REST_MS = 120_000;

/**
 * Input for `isometric.measure_max` — measures one side. Caller composes
 * for bilateral via `isometric.measure_imbalance`.
 *
 * Clamps reflect published evidence:
 *   * `durationMs`: 3–10s (IMTP literature is 3–5s; allow up to 10s for
 *     strength-endurance variants).
 *   * `trials`: 2–5 (the brief specifies 3, with up to 4 if a replacement
 *     trial is needed; cap at 5 for safety / reasonableness).
 *   * `restMs`: 30s–5min (under 30s is sub-recovery for max-force testing;
 *     over 5min is impractical in a session flow).
 */
export const IsometricMeasureMaxInput = z.object({
  slot: SlotIdSchema,
  durationMs: z.number().int().min(3_000).max(10_000).optional().default(DEFAULT_DURATION_MS),
  trials: z.number().int().min(2).max(5).optional().default(DEFAULT_TRIALS),
  restMs: z.number().int().min(30_000).max(300_000).optional().default(DEFAULT_REST_MS),
});

/**
 * Input for `isometric.measure_imbalance` — measures both sides
 * sequentially with the configured between-sides rest, then computes the
 * asymmetry index.
 *
 * `primarySide` labels which physical side `primarySlot` refers to. The
 * caller is responsible for ensuring the labels match what's actually
 * connected; this tool uses them only for output labeling and for the
 * non-dominant-first reordering logic.
 *
 * `testNonDominantFirst` (default true) reorders the test sequence so the
 * non-dominant side goes first when `dominantSide` is known. This controls
 * for within-session fatigue asymmetry per the IMTP literature.
 */
export const IsometricMeasureImbalanceInput = z.object({
  primarySlot: z.string().min(1),
  secondarySlot: z.string().min(1),
  primarySide: z.enum(['left', 'right']).optional().default('left'),
  durationMs: z.number().int().min(3_000).max(10_000).optional().default(DEFAULT_DURATION_MS),
  trials: z.number().int().min(2).max(5).optional().default(DEFAULT_TRIALS),
  restMs: z.number().int().min(30_000).max(300_000).optional().default(DEFAULT_REST_MS),
  betweenSidesRestMs: z
    .number()
    .int()
    .min(60_000)
    .max(300_000)
    .optional()
    .default(DEFAULT_BETWEEN_SIDES_REST_MS),
  testNonDominantFirst: z.boolean().optional().default(true),
  dominantSide: z.enum(['left', 'right', 'unknown']).optional().default('unknown'),
});

export type IsometricMeasureMaxInputType = z.infer<typeof IsometricMeasureMaxInput>;
export type IsometricMeasureImbalanceInputType = z.infer<typeof IsometricMeasureImbalanceInput>;
