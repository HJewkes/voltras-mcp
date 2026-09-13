// The isometric verdict card's read-model (VW-264): what the wall shows after an
// assessment closes, and for how long.
//
// Pure and node-testable, the same posture as `diverging-stage-model.ts` — the component
// below it renders whatever this returns and decides nothing. Every dismissal rule lives
// here, so "why did the card go away" has exactly one file to read.

import type { LiveIsometricResultSignal, LiveIsometricSignal } from '../../../state/live-signal';

/**
 * How long the card stays up, in ms.
 *
 * A lifter reads this standing at the rig, having just released a maximal hold — they are
 * breathing hard and not close enough to touch anything. Twenty seconds is long enough to
 * read two peaks and a percentage twice over, and short enough that the wall is a live
 * dashboard again before the next hold is set up (the between-sides rest in
 * `isometric.measure_imbalance` defaults well above it). Nothing validates this number; it
 * is a dwell chosen to be read, not a measurement.
 */
export const VERDICT_CARD_DWELL_MS = 20_000;

/** One side as the card prints it. */
export interface VerdictCardSide {
  /** `LEFT` / `RIGHT`, or the slot name when the run declared no limb. */
  label: string;
  peakForceLbs: number | null;
}

export interface IsometricVerdictCardModel {
  sides: readonly VerdictCardSide[];
  asymmetryPct: number | null;
  verdict: 'flagged' | 'meaningful' | null;
  /** The assessment's own sentence, printed under the numbers. */
  reason: string;
  /**
   * Set when the setup-geometry gate withheld the verdict (VW-284). The card prints this
   * INSTEAD of a verdict — a withheld answer is not a weak answer, and showing a verdict
   * chip next to the reason it cannot be trusted would read as a decision someone made.
   */
  withheldReason: string | null;
}

export interface IsometricVerdictInput {
  /** The latest assessment echo, or null if none has arrived this session. */
  result: LiveIsometricResultSignal | null;
  /** The walkthrough state — non-null means a hold is in progress right now. */
  hold: LiveIsometricSignal | null;
  /** Unix-ms the open set began, or null while none is open (`accumulator.setStartMs`). */
  setStartMs: number | null;
  /** The store's 1 Hz clock. */
  nowMs: number;
}

/**
 * Decide whether the verdict card shows, and what it says.
 *
 * Three ways it ends, all of them "the lifter has moved on":
 *   - the dwell elapsed;
 *   - a set opened AFTER the result landed — the athlete is lifting again, and a stale
 *     assessment must not sit over a live set. A set that was already open when the
 *     result arrived does NOT dismiss it, or an assessment run mid-session would never
 *     be visible at all;
 *   - a new hold began — the walkthrough owns that corner of the wall, and the result
 *     the athlete is about to replace is not the one to be reading.
 */
export function deriveIsometricVerdictCard(input: IsometricVerdictInput): {
  visible: boolean;
  card: IsometricVerdictCardModel | null;
} {
  const { result, hold, setStartMs, nowMs } = input;
  if (result === null) return { visible: false, card: null };
  if (nowMs - result.occurredAt >= VERDICT_CARD_DWELL_MS) return { visible: false, card: null };
  if (setStartMs !== null && setStartMs > result.occurredAt) return { visible: false, card: null };
  if (hold !== null) return { visible: false, card: null };
  return { visible: true, card: toCard(result) };
}

function toCard(result: LiveIsometricResultSignal): IsometricVerdictCardModel {
  const withheld = result.comparability === 'setup_confounded';
  return {
    sides: result.sides.map((side) => ({
      label: side.side === null ? side.slot.toUpperCase() : side.side.toUpperCase(),
      peakForceLbs: side.peakForceLbs,
    })),
    asymmetryPct: result.asymmetryPct,
    verdict: withheld ? null : result.verdict,
    reason: result.reason,
    withheldReason: withheld ? (result.setupReason ?? result.reason) : null,
  };
}
