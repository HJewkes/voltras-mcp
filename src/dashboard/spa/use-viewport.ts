/**
 * Viewport breakpoint hook for the operator routes (VW-121).
 *
 * ── Why a JS media query and not a CSS one ────────────────────────────────
 * The rule this SPA inherits from the live page is that LAYOUT goes through
 * `style`, never `className` — titan components are react-native-web Views,
 * which silently drop Tailwind layout utilities. That rules out `sm:flex-col`
 * and every other class-based breakpoint, so the breakpoint has to be a value
 * the component branches on. `matchMedia` is that value.
 *
 * `useSyncExternalStore` rather than `useState` + a resize listener: the width
 * is external mutable state, and the concurrent-safe subscription is three
 * lines here versus an effect that renders one frame at the wrong layout.
 *
 * The wall runs at desktop width and never resizes, so this costs it one
 * `matchMedia` call and no listeners that ever fire.
 */
import { useSyncExternalStore } from 'react';

/**
 * Below this width the two-column planner stacks. 768px is the tablet-portrait
 * boundary: at 390px (iPhone) the right column collapsed to ~110px and wrapped
 * caption text one character per line, and anything under ~768 is squeezed
 * enough that two columns of cards is worse than one.
 */
export const NARROW_BREAKPOINT_PX = 768;

const QUERY = `(max-width: ${NARROW_BREAKPOINT_PX - 1}px)`;

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const list = window.matchMedia(QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

function snapshot(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(QUERY).matches;
}

/** True when the viewport is narrower than {@link NARROW_BREAKPOINT_PX}. */
export function useIsNarrowViewport(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
