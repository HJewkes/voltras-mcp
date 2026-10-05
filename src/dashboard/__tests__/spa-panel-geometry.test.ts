// Unit tests for the shared live-panel geometry.
//
// The IDLE stage and the LIVE stage size themselves from ONE geometry — titan's `panelLayout`
// and `panelBodySplit` — so entering the first set of a session does not relayout the wall.
// `panel-geometry.ts` keeps only the stage-side body-height rule; the rows below pin the values
// titan hands both stages, so a titan bump that moves them is a visible diff here.

import { HERO_EYEBROW_ALLOWANCE, panelBodySplit, panelLayout } from '@titan-design/react-ui';
import { describe, expect, it } from 'vitest';

import {
  FATIGUE_PANEL_CHROME,
  FATIGUE_PANEL_FALLBACK_BODY,
  panelBodyHeight,
} from '../spa/live-page/panel-geometry.js';

describe('panelBodyHeight', () => {
  it('subtracts the panel padding from a measured stage', () => {
    expect(panelBodyHeight(800)).toBe(800 - FATIGUE_PANEL_CHROME);
  });

  it('falls back to titan’s own default before the stage has been measured', () => {
    expect(panelBodyHeight(0)).toBe(FATIGUE_PANEL_FALLBACK_BODY);
  });

  it('never returns a negative body for a stage shorter than its own chrome', () => {
    expect(panelBodyHeight(20)).toBe(0);
  });
});

describe('titan panel geometry the idle stage prefigures', () => {
  it('lays a wall-width stage out side by side with titan’s gap and fluid card', () => {
    const layout = panelLayout(1920);

    expect(layout.stacked).toBe(false);
    expect(layout.gap).toBe(16);
    expect(layout.cardWidth).toBe(422);
  });

  it('splits a side-by-side body into a full-height card and an eyebrow-trimmed hero', () => {
    const split = panelBodySplit(508, panelLayout(1920));

    expect(split).toEqual({ heroHeight: 508 - HERO_EYEBROW_ALLOWANCE, cardHeight: 508 });
  });

  it('stacks a phone-width stage with a full-content-width card', () => {
    const layout = panelLayout(390);
    const split = panelBodySplit(508, layout);

    expect(layout.stacked).toBe(true);
    expect(layout.cardWidth).toBe(390 - layout.padding * 2);
    expect(split.cardHeight).toBeGreaterThan(split.heroHeight);
  });
});
