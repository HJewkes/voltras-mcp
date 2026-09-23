import { describe, expect, it } from 'vitest';

import { boundariesOf, confirmedBoundaries, decisionsFinding } from '../checks/deload.js';
import { buildContext } from '../context.js';
import type { BoundaryDecision } from '../segmentation.js';

import { mapEntry, setRow } from './fixtures.js';

/** Two sessions, a 25-day gap, two more: one gap boundary in the week of 2030-02-04. */
const DATES = ['2030-01-07', '2030-01-10', '2030-02-04', '2030-02-07'];

function context(decisions: BoundaryDecision[] | null) {
  const rows = DATES.map((date, i) => setRow({ message_id: `m${i}`, workout_due_date: date }));
  return buildContext(rows, [], [mapEntry()], null, decisions);
}

describe('confirmed boundaries', () => {
  it('drops a boundary the human marked not a boundary and keeps a life gap', () => {
    expect(boundariesOf(context(null)).map((b) => b.week)).toEqual(['2030-02-04']);
    const dropped = context([{ week: '2030-02-04', choice: 'not_a_boundary' }]);
    const kept = context([{ week: '2030-02-04', choice: 'life_gap' }]);
    expect(confirmedBoundaries(dropped)).toEqual([]);
    expect(confirmedBoundaries(kept).map((b) => b.week)).toEqual(['2030-02-04']);
  });
});

describe('decisionsFinding', () => {
  it('says plainly when the human marked no planned deload', () => {
    const ctx = context([{ week: '2030-02-04', choice: 'unplanned_drop' }]);
    expect(decisionsFinding(ctx, boundariesOf(ctx))).toContain(
      'The human marked all 1 boundaries (1 unplanned drop). The human marked zero planned deloads',
    );
  });

  it('is absent when no decisions file was read', () => {
    const ctx = context(null);
    expect(decisionsFinding(ctx, boundariesOf(ctx))).toBeNull();
  });
});
