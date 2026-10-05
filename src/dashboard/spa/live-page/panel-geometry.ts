/**
 * What the live stage and the IDLE stage share about `LiveFatiguePanel` that titan does not
 * export. Padding, gap, card width and the hero/card split come from titan's `panelLayout` and
 * `panelBodySplit`, called by both stages; only the stage-side body-height rule stays local.
 *
 * Pure constants — no `react-native` import — so the node-side vitest run can assert on them
 * (see `spa-panel-geometry.test.ts`); anything defined in a `.tsx` here is untestable.
 */

/** Stays local: titan sizes `bodyHeight` inside its padding but exports no stage-side chrome. */
export const FATIGUE_PANEL_CHROME = 48;

/** Stays local: titan's `bodyHeight` default (508) is a parameter default, not an export. */
export const FATIGUE_PANEL_FALLBACK_BODY = 508;

/**
 * The panel body height for a measured stage height, matching what `SingleFatigueStage` feeds
 * `LiveFatiguePanel`. An unmeasured stage (0, before the first `onLayout`) falls back to
 * titan's own default rather than collapsing to nothing.
 */
export function panelBodyHeight(stageHeight: number): number {
  if (stageHeight <= 0) return FATIGUE_PANEL_FALLBACK_BODY;
  return Math.max(0, stageHeight - FATIGUE_PANEL_CHROME);
}
