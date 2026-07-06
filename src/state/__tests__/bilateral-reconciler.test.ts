import { describe, it, expect } from 'vitest';

import {
  BilateralReconciler,
  isRepCountDivergent,
  repCountDelta,
  type BilateralSetClose,
} from '../bilateral-reconciler.js';

function close(
  slotId: string,
  startedAt: string,
  repCount: number,
  weightLbs = 50,
): BilateralSetClose {
  return {
    slotId,
    setId: `${slotId}-${startedAt}`,
    sessionId: `sess-${slotId}`,
    startedAtMs: Date.parse(startedAt),
    repCount,
    weightLbs,
  };
}

describe('repCountDelta / isRepCountDivergent', () => {
  it('is divergent at a one-rep gap or more', () => {
    expect(isRepCountDivergent(12, 11)).toBe(true);
    expect(isRepCountDivergent(9, 10)).toBe(true);
    expect(isRepCountDivergent(10, 10)).toBe(false);
    expect(repCountDelta(12, 11)).toBe(1);
    expect(repCountDelta(9, 10)).toBe(-1);
  });
});

describe('BilateralReconciler.record — pairing', () => {
  it('flags an opposite-slot pair that starts within the window and diverges', () => {
    const r = new BilateralReconciler();
    expect(r.record(close('left', '2026-07-05T18:36:51.227Z', 12))).toBeUndefined();
    const div = r.record(close('right', '2026-07-05T18:36:51.969Z', 11));
    expect(div).toBeDefined();
    expect(div!.a.repCount).toBe(11);
    expect(div!.b.repCount).toBe(12);
    expect(div!.delta).toBe(-1);
    expect(r.size()).toBe(0);
  });

  it('consumes a matching pair silently when the counts are equal', () => {
    const r = new BilateralReconciler();
    r.record(close('left', '2026-07-05T18:33:58.849Z', 10));
    expect(r.record(close('right', '2026-07-05T18:33:59.291Z', 10))).toBeUndefined();
    expect(r.size()).toBe(0);
  });

  it('never pairs two closes from the SAME slot (single-device session)', () => {
    const r = new BilateralReconciler();
    r.record(close('primary', '2026-07-05T18:36:51.000Z', 12));
    expect(r.record(close('primary', '2026-07-05T18:36:51.200Z', 5))).toBeUndefined();
    // Both remain unmatched — a single-slot session emits nothing.
    expect(r.size()).toBe(2);
  });

  it('does not pair opposite-slot closes started beyond the window', () => {
    const r = new BilateralReconciler(5000);
    r.record(close('left', '2026-07-05T18:36:51.000Z', 12));
    // 7s later — outside the 5s window; the stale left close is evicted.
    expect(r.record(close('right', '2026-07-05T18:36:58.000Z', 11))).toBeUndefined();
    expect(r.size()).toBe(1);
  });

  it('ignores a close with a non-finite start time', () => {
    const r = new BilateralReconciler();
    expect(r.record(close('left', 'not-a-date', 12))).toBeUndefined();
    expect(r.size()).toBe(0);
  });
});

// The full recorded-session timeline: two sides run four paired sets, then the
// right side continues solo (50/80/115). Feeding every close in start order
// must surface EXACTLY the two Δ1 pairs and pair nothing with the solo sets.
const TIMELINE: BilateralSetClose[] = [
  close('left', '2026-07-05T18:32:03.694Z', 0, 30),
  close('right', '2026-07-05T18:32:04.403Z', 0, 30),
  close('left', '2026-07-05T18:33:58.849Z', 10, 30),
  close('right', '2026-07-05T18:33:59.291Z', 10, 30),
  close('left', '2026-07-05T18:36:51.227Z', 12, 30), // ← Δ1 pair
  close('right', '2026-07-05T18:36:51.969Z', 11, 30),
  close('left', '2026-07-05T18:40:33.898Z', 10, 50), // ← Δ1 pair
  close('right', '2026-07-05T18:40:35.032Z', 9, 50),
  close('right', '2026-07-05T18:46:01.237Z', 0, 50), // solo from here down
  close('right', '2026-07-05T18:50:45.534Z', 9, 50),
  close('right', '2026-07-05T18:54:11.825Z', 11, 80),
  close('right', '2026-07-05T18:57:20.958Z', 13, 115),
  close('right', '2026-07-05T19:01:47.645Z', 0, 115),
];

describe('BilateralReconciler.record — recorded session timeline', () => {
  it('surfaces exactly the two Δ1 pairs and never mispairs a solo set', () => {
    const r = new BilateralReconciler();
    const divergences = TIMELINE.map((c) => r.record(c)).filter((d) => d !== undefined);
    expect(divergences).toHaveLength(2);

    const [thirty, fifty] = divergences;
    expect(thirty!.a.weightLbs).toBe(30);
    expect([thirty!.a.repCount, thirty!.b.repCount].sort((x, y) => x - y)).toEqual([11, 12]);
    expect(Math.abs(thirty!.delta)).toBe(1);

    expect(fifty!.a.weightLbs).toBe(50);
    expect([fifty!.a.repCount, fifty!.b.repCount].sort((x, y) => x - y)).toEqual([9, 10]);
    expect(Math.abs(fifty!.delta)).toBe(1);
  });
});
