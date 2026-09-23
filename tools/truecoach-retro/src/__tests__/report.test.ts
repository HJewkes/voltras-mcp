import { describe, expect, it } from 'vitest';

import { buildContext } from '../context.js';
import { renderReport } from '../report.js';

import { mapEntry, syntheticLog } from './fixtures.js';

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
