// Pure, unit-free readouts of mid-rep technique faults over the SDK's `Rep`
// shape (VMCP-06.02 / B12). w3-24 adds a bounce detector to this same file —
// keep new faults as another `REP_FAULT_MARGINS` entry plus a `detectX`
// function, so the table grows without restructuring what is here.
//
// EVERY margin below is a fraction of the rep's OWN range of motion or its
// OWN peak velocity — never an absolute metre or m/s figure (VW-160: this
// server's velocities carry a unit history, and a fraction is the only
// quantity that reads the same regardless of it).

import type { Rep } from '@voltras/workout-analytics';

/**
 * Per-fault relative margins. `romFractionMin`/`Max` bound the position
 * window, as a fraction of the concentric phase's own ROM, that counts as
 * "strictly inside" the rep (the ticket's own wording). 0.15/0.85 is the
 * ticket's own figure ("roughly 15% and 85%"), not an invented cut — outside
 * that band sits the top/bottom turnaround the phase segmenter already
 * treats as a HOLD (`getPhaseHoldDuration`), so a stall there is a normal
 * rep boundary, not a mid-rep fault.
 */
export const REP_FAULT_MARGINS = {
  hesitation: {
    romFractionMin: 0.15,
    romFractionMax: 0.85,
  },
} as const;

/** One velocity trough found in a rep's concentric phase. */
export interface HesitationCrossing {
  /** Position of the trough, as a fraction of the rep's own concentric ROM (0-1). */
  atRomFraction: number;
  /** Velocity at the trough, as a fraction of this rep's own peak concentric velocity. */
  velocityFractionOfPeak: number;
}

export interface RepHesitationReading {
  repNumber: number;
  crossings: HesitationCrossing[];
  /**
   * Always `null` (VMCP-06.02). Calling a trough a real hesitation rather
   * than measurement noise needs a "how deep counts as near-zero" cut. The
   * ticket gives no number for that — unlike the 15/85 ROM window above —
   * and no existing relative constant in this codebase measures the same
   * thing: `rep-eligibility.ts`'s ratios compare a rep against its
   * NEIGHBOURS, not a velocity dip within one rep. Per the no-invented-
   * margins rule, the raw crossing is reported and the verdict stays null
   * rather than guessing at a threshold.
   */
  hesitated: null;
}

/**
 * Per-rep hesitation readout: every velocity trough in the CONCENTRIC phase
 * that sits strictly inside the ROM window, plus a verdict that is always
 * null (see {@link RepHesitationReading.hesitated}).
 *
 * Eccentric is never examined — the ticket's fault is concentric-only.
 */
export function detectHesitation(rep: Rep): RepHesitationReading {
  const { romFractionMin, romFractionMax } = REP_FAULT_MARGINS.hesitation;
  const crossings = findVelocityTroughs(rep.concentric).filter(
    (c) => c.atRomFraction > romFractionMin && c.atRomFraction < romFractionMax,
  );
  return { repNumber: rep.repNumber, crossings, hesitated: null };
}

/**
 * Every local minimum of a phase's velocity trace: a sample slower than both
 * neighbours. This is the zero-crossing analogue for a magnitude-only signal
 * — `WorkoutSample.velocity` is always non-negative, direction is carried by
 * `phase`, not by sign — so a genuine mid-rep stall shows up as velocity
 * dipping and recovering, never as a literal sign flip. Finding a trough
 * needs no magnitude threshold: decrease-then-increase is a structural
 * property of three consecutive samples, not a distance from zero.
 *
 * `atRomFraction` is signed by (endPosition − startPosition) rather than by
 * `getPhaseRangeOfMotion`'s absolute value, so it lands in 0..1 for either
 * direction of travel without the caller having to know which way this
 * phase moves.
 */
function findVelocityTroughs(phase: Rep['concentric']): HesitationCrossing[] {
  const { samples, startPosition, endPosition, peakVelocity } = phase;
  const rom = endPosition - startPosition;
  if (rom === 0 || peakVelocity === 0) return [];
  const troughs: HesitationCrossing[] = [];
  for (let i = 1; i < samples.length - 1; i++) {
    const prev = samples[i - 1]!;
    const curr = samples[i]!;
    const next = samples[i + 1]!;
    if (curr.velocity < prev.velocity && curr.velocity < next.velocity) {
      troughs.push({
        atRomFraction: (curr.position - startPosition) / rom,
        velocityFractionOfPeak: curr.velocity / peakVelocity,
      });
    }
  }
  return troughs;
}
