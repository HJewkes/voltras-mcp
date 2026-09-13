// A deliberately planted direct velocity-loss-to-RIR conversion (VW-302).
//
// POSITIVE CONTROL, not real code. A guard nobody ever watched catch a real
// hit is unproven — the same lesson VW-220 already paid for with a
// `[redacted]` marker sitting beside intact prose it did nothing to cover.
// This file exercises every shape `no-direct-vl-to-rir.test.ts` looks for: a
// function whose name and params pair RIR with velocity loss, a call into it,
// and a lookup table keyed the same way. Never imported by anything else.

export function estimateRirFromVelocityLoss(vlPct: number): number {
  return Math.max(0, 5 - vlPct / 5);
}

export function callTheEstimator(vlPct: number): number {
  return estimateRirFromVelocityLoss(vlPct);
}

export const VELOCITY_LOSS_TO_RIR_TABLE: Record<number, number> = {
  10: 4,
  20: 2,
  30: 0,
};
