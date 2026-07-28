// Unit tests for the shared live-panel geometry.
//
// The point of `panel-geometry.ts` is that the IDLE stage and the LIVE stage size themselves
// from ONE set of numbers, so entering the first set of a session does not relayout the wall.
// These assert the derivations both stages call — the constants themselves are the contract
// with titan's `LiveFatiguePanel` and are checked by rendering, not here.

import { describe, expect, it } from 'vitest';

import {
  FATIGUE_CARD_WIDTH,
  FATIGUE_PANEL_CHROME,
  FATIGUE_PANEL_FALLBACK_BODY,
  HERO_EYEBROW_ALLOWANCE,
  PANEL_COLUMN_GAP,
  PANEL_PAD,
  heroPlotHeight,
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

describe('heroPlotHeight', () => {
  it('reserves the eyebrow allowance above the plot', () => {
    expect(heroPlotHeight(508)).toBe(508 - HERO_EYEBROW_ALLOWANCE);
  });

  it('floors at zero rather than inverting on a tiny body', () => {
    expect(heroPlotHeight(10)).toBe(0);
  });
});

describe('panel column geometry', () => {
  it('matches the LiveFatiguePanel body row the idle stage prefigures', () => {
    // Changing any of these without changing titan is what makes the empty→live transition
    // jump, so they are pinned rather than merely exported.
    expect(PANEL_PAD).toBe(24);
    expect(PANEL_COLUMN_GAP).toBe(18);
    expect(FATIGUE_CARD_WIDTH).toBe(318);
    expect(FATIGUE_PANEL_CHROME).toBe(PANEL_PAD * 2);
  });
});
