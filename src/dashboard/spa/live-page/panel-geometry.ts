/**
 * The geometry of titan's `LiveFatiguePanel`, in one place.
 *
 * The live stage and the IDLE stage have to agree on these numbers to the pixel: the empty
 * stage PREFIGURES the panel (same padding, same column gap, same card width, same body
 * height), so that the first set of a session settles into place instead of relayouting a
 * centred blob into a two-column panel. Two copies of these numbers is how the two stages
 * end up one refactor apart, so they live here rather than inline in either `.tsx`.
 *
 * Pure constants — no `react-native` import — so the node-side vitest run can assert on them
 * (see `spa-panel-geometry.test.ts`); anything defined in a `.tsx` here is untestable.
 *
 * Source of truth: `LiveFatiguePanel` in @titan-design/react-ui — its body row is
 * `{ padding: 24, flexDirection: 'row', gap: 18 }`, its card column is a fixed 318 wide, and
 * its hero is `bodyHeight - 26` tall (the 26 is the eyebrow above the plot).
 */

/** The panel body row's uniform padding, px. */
export const PANEL_PAD = 24;

/** The gap between the hero column and the fatigue-card column, px. */
export const PANEL_COLUMN_GAP = 18;

/** titan's fixed fatigue-card column width, px (`LiveFatiguePanelProps.cardWidth` default). */
export const FATIGUE_CARD_WIDTH = 318;

/**
 * Vertical chrome the panel adds around its body: `LiveFatiguePanel` pads its content
 * region by {@link PANEL_PAD} top and bottom, and `bodyHeight` sizes the content INSIDE that
 * padding. Subtracting it keeps the panel exactly one stage tall instead of overflowing by 48px.
 */
export const FATIGUE_PANEL_CHROME = PANEL_PAD * 2;

/** titan's own `bodyHeight` default — used until the stage has been measured once. */
export const FATIGUE_PANEL_FALLBACK_BODY = 508;

/** What the panel reserves above the velocity plot for its `VELOCITY · this set` eyebrow, px. */
export const HERO_EYEBROW_ALLOWANCE = 26;

/**
 * The panel body height for a measured stage height, matching what `SingleFatigueStage` feeds
 * `LiveFatiguePanel`. An unmeasured stage (0, before the first `onLayout`) falls back to
 * titan's own default rather than collapsing to nothing.
 */
export function panelBodyHeight(stageHeight: number): number {
  if (stageHeight <= 0) return FATIGUE_PANEL_FALLBACK_BODY;
  return Math.max(0, stageHeight - FATIGUE_PANEL_CHROME);
}

/** The plot height inside the hero column for a given panel body height. */
export function heroPlotHeight(bodyHeight: number): number {
  return Math.max(0, bodyHeight - HERO_EYEBROW_ALLOWANCE);
}
