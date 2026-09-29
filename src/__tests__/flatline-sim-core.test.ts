// Unit tests for the flatline sim's light-lift candidate
// (scripts/lib/flatline-sim-core.mjs, VW-671).
import { describe, expect, it } from 'vitest';

import { STRATEGIES, WEEK_MS, readsFlat } from '../../scripts/lib/flatline-sim-core.mjs';

const wobblingFlat = (weeks: number) =>
  Array.from({ length: weeks }, (_, week) => ({ t: week * WEEK_MS, v: 40 + (week % 2) }));

describe('light_min_35d', () => {
  it('holds a wobbling 28-day run on a light step that the shipped row calls flat', () => {
    const points = wobblingFlat(5);

    expect(readsFlat(points, 1, STRATEGIES.rolling_top_2wk_min_21d_settled_1)).toBe(true);
    expect(readsFlat(points, 1, STRATEGIES.light_min_35d)).toBe(false);
  });

  it('calls a wobbling run flat on a light step once it spans 35 days', () => {
    expect(readsFlat(wobblingFlat(6), 1, STRATEGIES.light_min_35d)).toBe(true);
  });

  it('reads like the shipped row when the step is 2 lb a week or more', () => {
    const points = wobblingFlat(5);

    expect(readsFlat(points, 2.5, STRATEGIES.light_min_35d)).toBe(
      readsFlat(points, 2.5, STRATEGIES.rolling_top_2wk_min_21d_settled_1),
    );
    expect(readsFlat(points, 2.5, STRATEGIES.light_min_35d)).toBe(true);
  });
});
