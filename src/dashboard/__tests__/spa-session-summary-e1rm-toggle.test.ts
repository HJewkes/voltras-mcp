// Render test for the E1RM trend chart's display-unit toggle (VW-196, review-pr296
// finding 5): `E1RMTrend` fed the chart raw-lbs e1RM values and a hardcoded `unit="lbs"`
// regardless of the store's displayUnit. This mounts the real `StrengthTrendChart` (via
// `renderToStaticMarkup` under the react-native-web alias, same technique as
// `spa-display-unit-toggle.test.ts`) so a regression that leaves the chart on lbs shows
// up in the rendered markup, not just in a mapper-level assertion.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { E1RMTrend } from '../spa/planner/SessionSummaryPage.js';
import type { E1RMPoint } from '../spa/planner/planner-model.js';

const series: E1RMPoint[] = [
  { date: '2026-07-30T10:00:00.000Z', e1rm: 100, sessionLabel: 'Set 1' },
  { date: '2026-07-30T10:05:00.000Z', e1rm: 100, sessionLabel: 'Set 2' },
];

function render(displayUnit: 'lbs' | 'kg'): string {
  return renderToStaticMarkup(createElement(E1RMTrend, { series, changePct: 0, displayUnit }));
}

describe('E1RMTrend chart follows the display toggle (VW-196)', () => {
  it('renders the chart in lbs by default, unconverted', () => {
    const html = render('lbs');
    expect(html).toContain('Current: 100 lbs');
  });

  it('converts the e1RM point AND the unit label to kg with the toggle on', () => {
    // 100 lb × 0.45359237 ≈ 45.36 → the chart rounds to 45 (formatMass-style rounding
    // done by StrengthTrendChart itself; this layer passes it through convertMass,
    // unrounded, per the same EXACT-values contract as `exercise-hero-view.ts`).
    const html = render('kg');
    expect(html).toContain('Current: 45 kg');
    expect(html).not.toContain('Current: 100');
  });
});
