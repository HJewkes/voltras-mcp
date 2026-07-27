// VMCP-05.14 regression: the same rep reported a POSITIVE eccentric peak
// velocity on the live `rep_finalized` event and a NEGATIVE one on `set_ended`,
// with `velocity_drop_pct` collapsing 97.2 → 0 alongside it.
//
// Root cause is a single one: the finalize-time peak recompute (VMCP-02.69a)
// runs on the STORE path only and used to keep the sample's sign, while the
// live event publishes the raw analytics rep whose `peakVelocity` aggregate is
// a magnitude. The zeroed drop percentage is downstream of the same flip —
// `getPhaseVelocityDropPct` returns 0 for any non-positive peak — so the two
// symptoms are asserted separately here to keep that link honest.
//
// Every number below is a real captured value from the 2026-07-26 bench
// session (see the fixture module).

import { describe, expect, it } from 'vitest';
import type { Rep } from '@voltras/workout-analytics';

import { buildRepFinalizedPayload } from '../channel-payloads.js';
import { finalizeReps } from '../rep-finalize.js';
import { benchDevice, benchSet, capturedRep1 } from './fixtures/bench-2026-07-26.js';

function eccentricOf(rep: Rep): { peak_velocity: number; velocity_drop_pct: number } {
  const content = buildRepFinalizedPayload(rep, 0, benchSet, benchDevice, 2).content;
  return (
    JSON.parse(content) as {
      rep: { eccentric: { peak_velocity: number; velocity_drop_pct: number } };
    }
  ).rep.eccentric;
}

describe('VMCP-05.14: eccentric peak velocity agrees across live and stored paths', () => {
  it('reports the same eccentric peak velocity before and after finalize', () => {
    const rep = capturedRep1();
    const [finalized] = finalizeReps([rep]);

    expect(eccentricOf(rep).peak_velocity).toBe(1.137);
    // Read -1.137 before the fix.
    expect(eccentricOf(finalized).peak_velocity).toBe(1.137);
  });

  it('preserves the eccentric velocity drop across finalize', () => {
    const rep = capturedRep1();
    const [finalized] = finalizeReps([rep]);

    expect(eccentricOf(rep).velocity_drop_pct).toBe(97.2);
    // Read 0 before the fix — the negative peak tripped WA's guard clause.
    expect(eccentricOf(finalized).velocity_drop_pct).toBe(97.2);
  });

  it('still re-derives the peak from the samples rather than trusting the aggregate', () => {
    // The point of the finalize-time recompute is that the running aggregate
    // can go stale relative to the samples it holds. Keep that behaviour: a
    // deliberately-wrong stored aggregate must be corrected to the largest
    // sample magnitude, not passed through.
    const rep = capturedRep1();
    const stale: Rep = { ...rep, eccentric: { ...rep.eccentric, peakVelocity: 9999 } };

    expect(finalizeReps([stale])[0].eccentric.peakVelocity).toBe(1137);
  });
});
