// VMCP-05.13 regression: the mid-set VBT summary counted the in-flight rep as
// the set's last rep, reporting 60.4% velocity loss on a set that was still
// accelerating. The same set's `set_ended` payload read 8.9%.
//
// Every number below is a real captured value from the 2026-07-26 bench
// session (see the fixture module).

import { describe, expect, it } from 'vitest';

import { summarizeSetForTrigger } from '../channel-payloads.js';
import type { ActiveSet } from '../live-state.js';
import {
  ACCELERATING_PEAKS,
  benchDevice,
  benchSet,
  completedRep,
  inFlightRep,
} from './fixtures/bench-2026-07-26.js';

describe('VMCP-05.13: mid-set VBT summary excludes the in-flight rep', () => {
  const midSet: ActiveSet = {
    ...benchSet,
    reps: [...ACCELERATING_PEAKS.map((peak, i) => completedRep(i + 1, peak)), inFlightRep(6)],
  };

  it('reads the last COMPLETED rep as last_rep_v, not the partial one', () => {
    // Before the fix this read 0.821 — the in-flight rep's partial peak.
    expect(summarizeSetForTrigger(midSet, benchDevice).vbt_summary.last_rep_v).toBe(2.071);
  });

  it('does not report velocity loss on a set that is still accelerating', () => {
    const { vbt_summary } = summarizeSetForTrigger(midSet, benchDevice);
    // Before the fix this read 60.4%.
    expect(vbt_summary.velocity_loss_pct).toBe(0);
    expect(vbt_summary.peak_rep_v).toBe(2.071);
    expect(vbt_summary.peak_rep_number).toBe(5);
  });

  it('omits the in-flight rep from the mid-set rep array', () => {
    const { reps } = summarizeSetForTrigger(midSet, benchDevice);
    expect(reps).toHaveLength(5);
    expect(reps.at(-1)?.rep_number).toBe(5);
  });

  it('keeps a trailing rep whose eccentric has started', () => {
    const complete: ActiveSet = {
      ...benchSet,
      reps: ACCELERATING_PEAKS.map((peak, i) => completedRep(i + 1, peak)),
    };
    expect(summarizeSetForTrigger(complete, benchDevice).reps).toHaveLength(5);
  });
});
