/**
 * The `#/body` drill wiring (VW-713, VW-339 slice S3): which muscle sheet the
 * shell's drill stack has open, and the actions a press or a dismiss sends it.
 *
 * Pure, so the press-opens and close-pops rules are asserted without a DOM.
 * The stack keys on the muscle slug, never on the fetched numbers, so a 2 s
 * poll re-derives the open sheet without closing or re-animating it.
 */
import {
  EMPTY_DRILL_STACK,
  type DrillAction,
  type DrillLayer,
  type DrillStack,
} from '../drill/drill-stack.js';
import { createIdleHeal, IDLE_ACTIVITY_EVENTS, type IdleHeal } from '../drill/idle-heal.js';
import { routeHash } from '../routing.js';
import type { BodyPageData } from './body-model.js';
import { muscleSheetProps } from './body-sheet-model.js';

/** The lineage every muscle sheet shares, so a second press replaces rather than stacks. */
export const MUSCLE_LINEAGE = 'muscle';

function muscleLayer(slug: string): DrillLayer {
  return { lineage: MUSCLE_LINEAGE, id: slug };
}

/** The stack a page load starts with: the deep-linked muscle's sheet, or nothing. */
export function initialBodyStack(muscle: string | undefined): DrillStack {
  return muscle === undefined ? EMPTY_DRILL_STACK : [muscleLayer(muscle)];
}

/** The slug whose sheet is open, or null when the page is the glance. */
export function openMuscle(stack: DrillStack): string | null {
  return stack.find((layer) => layer.lineage === MUSCLE_LINEAGE)?.id ?? null;
}

/** The hash that names the open sheet, so a reload or a shared link reopens it. */
export function bodyHashFor(stack: DrillStack): string {
  const muscle = openMuscle(stack);
  return routeHash(muscle === null ? { name: 'body' } : { name: 'body', muscle });
}

/**
 * The action that brings the stack in line with a hash the lifter changed
 * (back button, typed URL), or null when the two already agree.
 */
export function syncToRoute(stack: DrillStack, muscle: string | undefined): DrillAction | null {
  if ((muscle ?? null) === openMuscle(stack)) return null;
  return muscle === undefined ? { type: 'reset' } : { type: 'open', layer: muscleLayer(muscle) };
}

/**
 * A reset when the open sheet names a muscle the loaded week cannot draw, so a
 * deep link to it does not hold an invisible stack (and its hash) open.
 */
export function undrawableSheetAction(
  stack: DrillStack,
  data: BodyPageData | null,
): DrillAction | null {
  const muscle = openMuscle(stack);
  if (data === null || muscle === null) return null;
  return muscleSheetProps(muscle, data) === null ? { type: 'reset' } : null;
}

export interface BodyDrillHandlers {
  /** A figure or strip press: open that muscle's sheet, replacing any open one. */
  onMusclePress: (slug: string) => void;
  /** The sheet's own dismiss (close button, backdrop, Escape): pop the top layer. */
  onClose: () => void;
}

export function bodyDrillHandlers(dispatch: (action: DrillAction) => void): BodyDrillHandlers {
  return {
    onMusclePress: (slug) => dispatch({ type: 'open', layer: muscleLayer(slug) }),
    onClose: () => dispatch({ type: 'close' }),
  };
}

/**
 * An idle heal that clears the whole stack, restarted by lifter input on
 * `target` (the document). `unbind` removes the listeners and disposes the heal.
 */
export function bindIdleHeal(
  target: EventTarget,
  dispatch: (action: DrillAction) => void,
): { heal: IdleHeal; unbind: () => void } {
  const heal = createIdleHeal({ onIdle: () => dispatch({ type: 'reset' }) });
  const onActivity = (): void => heal.activity();
  for (const name of IDLE_ACTIVITY_EVENTS) {
    target.addEventListener(name, onActivity, { capture: true, passive: true });
  }
  const unbind = (): void => {
    for (const name of IDLE_ACTIVITY_EVENTS) {
      target.removeEventListener(name, onActivity, { capture: true });
    }
    heal.dispose();
  };
  return { heal, unbind };
}
