// A deliberately planted direct velocity-loss-to-RIR conversion (VW-302).
//
// POSITIVE CONTROL, not real code. A guard nobody ever watched catch a real
// hit is unproven — the same lesson VW-220 already paid for with a
// `[redacted]` marker sitting beside intact prose it did nothing to cover.
// This file exercises every shape `no-direct-vl-to-rir.test.ts` looks for: a
// function whose name and params pair RIR or RPE with velocity loss, a call into
// it, a lookup table keyed the same way, and an import of workout-analytics' own
// conversions, named and by namespace. Never imported by anything else.

import * as analytics from '@voltras/workout-analytics';
import { estimateSetRpe } from '@voltras/workout-analytics/view';

export function estimateRirFromVelocityLoss(vlPct: number): number {
  return Math.max(0, 5 - vlPct / 5);
}

export function callTheEstimator(vlPct: number): number {
  return estimateRirFromVelocityLoss(vlPct);
}

export function statedRpeFromVelocityLoss(velocityLossPct: number): number {
  return 10 - velocityLossPct / 10;
}

export const plantedSetRpe = estimateSetRpe;
export const plantedSetSummary = analytics.getSetFatigueSummary;

export const VELOCITY_LOSS_TO_RIR_TABLE: Record<number, number> = {
  10: 4,
  20: 2,
  30: 0,
};
