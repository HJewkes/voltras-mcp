import { describe, expect, it } from 'vitest';

import { buildContext } from '../context.js';
import { addDays } from '../dates.js';
import { renderReport } from '../report.js';
import type { CheckinRecord } from '../types.js';

import { mapEntry, setRow } from './fixtures.js';

function syntheticLog() {
  const rows = Array.from({ length: 12 }, (_, i) => {
    const date = addDays('2030-01-07', 3 * i);
    return [1, 2, 3].map((set) =>
      setRow({ message_id: `m${i}`, workout_due_date: date, set_index: set, load: 100 + i }),
    );
  }).flat();
  const checkins: CheckinRecord[] = Array.from({ length: 6 }, (_, i) => ({
    field: 'Weight',
    workout_due_date: addDays('2030-01-07', 7 * i),
    email_date: null,
    value: 200 - i,
  }));
  return { rows, checkins };
}

describe('renderReport', () => {
  it('renders the six checks in the approved order and the two closing sections', () => {
    const { rows, checkins } = syntheticLog();
    const report = renderReport(buildContext(rows, checkins, [mapEntry()], null), '2030-03-01');
    const headings = report.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toEqual([
      '## The data',
      '## 1. Progression and plateaus per main lift',
      '## 2. Missed targets',
      '## 3. Weekly sets per muscle against the landmarks',
      '## 4. Deload cadence',
      '## 5. Adherence',
      '## 6. Bodyweight and waist against strength',
      '## What this cannot tell us',
      '## Suggested next checks',
    ]);
    expect(report).toContain('| Lift One | push | 5 | 12 |');
  });
});
