// VMCP-02.67 — bilateral L/R rep-count divergence reconciliation.
//
// A synchronized bilateral lift runs as TWO sessions (one per side / slot),
// started ~simultaneously. When both sides are tracking the same movement the
// per-set rep counts should match; a divergence of one rep or more is worth
// surfacing (a missed rep on one arm, or a side-count desync).
//
// Correlating the two sides is the hard part: there is no shared set id across
// slots, and one side can run extra solo sets (bench 2026-07-05: the right
// side continued with 80/115 lb sets the left never mirrored). This module
// pairs two set closes when they come from DIFFERENT slots and their set-START
// timestamps fall within `windowMs` of each other — the signature of two arms
// beginning the same paired set within a couple of seconds. Sequential sets on
// one side (minutes apart) and same-slot solo sets never pair.
//
// The reconciler is fed from the finalize path (`finalizeSet` in
// `src/tools/set-tools.ts`): every set close calls `record`, which either
// stashes the close awaiting its partner or, on a match, returns the
// divergence for the caller to publish as a `bilateral_divergence` channel
// event. It holds no device / protocol state — pure timeline bookkeeping.
//
// DESK vs BENCH: the pairing algorithm and the divergence rule are fully
// desk-validated against the recorded session timeline. The `windowMs` value
// itself (tolerance for how far apart the two arms may start a paired set) is
// tuned to the observed <1.2 s side-start skew of that one session and should
// be re-checked on the bench against real two-arm start jitter — too small
// yields false negatives (missed pairs), never false pairs.

/**
 * Maximum difference between the two sides' set-START timestamps for the sets
 * to be treated as the same paired bilateral set. The recorded session's
 * paired sets started ≤1.2 s apart while sequential sets were ≥90 s apart, so
 * 5 s cleanly separates a genuine pair from the next set. BENCH-TUNABLE — see
 * the module header.
 */
export const BILATERAL_PAIR_WINDOW_MS = 5000;

/** A finalized set close handed to the reconciler, one per slot per set. */
export interface BilateralSetClose {
  slotId: string;
  setId: string;
  sessionId: string;
  /** Set start time in epoch ms (the pairing key). */
  startedAtMs: number;
  repCount: number;
  weightLbs: number;
}

/**
 * A matched pair whose rep counts diverge. `a` is the close that triggered the
 * match (the second side to finalize); `b` is its earlier-pending partner.
 * `delta` is `a.repCount − b.repCount` (signed).
 */
export interface BilateralDivergence {
  a: BilateralSetClose;
  b: BilateralSetClose;
  delta: number;
}

/** Signed rep-count difference between two sides. */
export function repCountDelta(a: number, b: number): number {
  return a - b;
}

/** A bilateral set is divergent when the two sides differ by one rep or more. */
export function isRepCountDivergent(a: number, b: number): boolean {
  return Math.abs(a - b) >= 1;
}

/**
 * Pairs opposite-slot set closes by set-start proximity and reports rep-count
 * divergences. Single-slot (non-bilateral) sessions never emit — every close
 * shares one `slotId`, so the opposite-slot match never fires.
 */
export class BilateralReconciler {
  private pending: BilateralSetClose[] = [];

  constructor(private readonly windowMs: number = BILATERAL_PAIR_WINDOW_MS) {}

  /**
   * Record a set close. Returns a `BilateralDivergence` when this close pairs
   * with a pending opposite-slot close AND their rep counts differ; otherwise
   * stashes/consumes the close and returns `undefined`. Closes with a
   * non-finite start time are ignored (they can never pair).
   */
  record(close: BilateralSetClose): BilateralDivergence | undefined {
    if (!Number.isFinite(close.startedAtMs)) {
      return undefined;
    }
    this.evictStale(close.startedAtMs);
    const idx = this.pending.findIndex(
      (p) =>
        p.slotId !== close.slotId && Math.abs(p.startedAtMs - close.startedAtMs) <= this.windowMs,
    );
    if (idx === -1) {
      this.pending.push(close);
      return undefined;
    }
    const [partner] = this.pending.splice(idx, 1);
    if (!isRepCountDivergent(close.repCount, partner.repCount)) {
      return undefined;
    }
    return { a: close, b: partner, delta: repCountDelta(close.repCount, partner.repCount) };
  }

  /**
   * Drop pending closes whose start is more than `windowMs` before the
   * incoming close — since start times only advance, they can no longer pair.
   * Keeps the buffer bounded to the handful of in-flight unmatched closes.
   */
  private evictStale(nowStartMs: number): void {
    this.pending = this.pending.filter((p) => nowStartMs - p.startedAtMs <= this.windowMs);
  }

  /** Test-only: number of unmatched closes currently held. */
  size(): number {
    return this.pending.length;
  }
}
