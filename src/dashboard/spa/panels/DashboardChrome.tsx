/**
 * The one piece of chrome every dashboard route renders (VW-120 follow-up).
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The live page has mounted titan's `DashboardShell` — a `SideNav` rail + a
 * `TopBar` — since VW-38, but its nav was inert ("single-view; nav is a no-op
 * for now"). The planner pages then shipped their own hand-rolled `<nav>` of
 * `<a>` tags. So the wall already carried a rail that could not navigate, while
 * a second, unstyled nav existed three routes away.
 *
 * This collapses both into titan's real `SideNav`: ONE `DashboardShell` wraps
 * every route, and `onNavigate` drives the hash router. Nothing new appears on
 * the wall — the rail was always there — it just stops being decorative.
 *
 * The rail is deliberately narrowed to the routes that EXIST. `defaultNavItems`
 * ships four categories (Live · Review · Plan · Body); `Body` has no route, and
 * a nav button that does nothing is worse chrome than no button. Adding it back
 * is one entry in {@link NAV_ITEMS} when the body view lands.
 *
 * Chrome inputs (devices, session state) are read from the store here rather
 * than passed down, so a route that knows nothing about BLE still renders a
 * truthful TopBar.
 */
import React, { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { DashboardShell, defaultNavItems, type SessionState } from '@titan-design/react-ui';

import { dashboardStore } from '../store';
import { buildSessionState, buildTopBarDevices } from '../adapter';
import { routeHash, type Route } from '../routing';

/** Nav key ⇄ route. The nav rail renders exactly these, in this order. */
const NAV_ROUTES: Record<string, Route> = {
  live: { name: 'live' },
  program: { name: 'plan' },
  review: { name: 'summary', sessionId: 'latest' },
};

/** titan's default categories, filtered to the ones that route somewhere. */
const NAV_ITEMS = defaultNavItems.filter((item) => item.key in NAV_ROUTES);

/** The nav key a route highlights. Inverse of {@link NAV_ROUTES}. */
export function navKeyForRoute(route: Route): string {
  switch (route.name) {
    case 'plan':
      return 'program';
    case 'summary':
      return 'review';
    case 'live':
      return 'live';
  }
}

/**
 * Reflect the active route onto the nav rail's `aria-selected` (VW-121 / D4).
 *
 * ── Why this is a DOM shim and not a prop ─────────────────────────────────
 * titan's `NavItem` already declares `accessibilityState={{ selected: active }}`
 * — but react-native-web 0.19 DROPPED `accessibilityState`, mapping only
 * `aria-selected` / `accessibilitySelected` (see its `createDOMProps`). So every
 * rail item renders `role="tab"` with no selected state and a screen-reader user
 * cannot tell which route they are on. `SideNav` exposes no per-item aria
 * override, so there is nothing to pass down.
 *
 * The tabs are matched by their `aria-label` (titan sets it from the item label),
 * NOT by index, so a future reordering of `NAV_ITEMS` can't silently mark the
 * wrong tab. Delete this the moment titan's NavItem emits `aria-selected` itself.
 */
function useNavSelectedShim(activeKey: string): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (root === null) return;
    for (const item of NAV_ITEMS) {
      const tab = root.querySelector(`[role="tab"][aria-label="${item.label}"]`);
      tab?.setAttribute('aria-selected', String(item.key === activeKey));
    }
  }, [activeKey]);
  return ref;
}

/**
 * Shell chrome around a route's content.
 *
 * `scroll` distinguishes the two deployments this shell now serves: the wall is
 * exactly one screen and must never scroll, while the operator surfaces are
 * documents. Both keep the same rail, so a wall that someone walks up to can
 * still reach the plan.
 */
export function DashboardChrome(props: {
  route: Route;
  scroll?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const snapshot = useStore(dashboardStore, (s) => s.snapshot);
  const status = useStore(dashboardStore, (s) => s.status);

  const devices = snapshot ? buildTopBarDevices(snapshot, status) : [];
  const sessionState: SessionState = snapshot ? buildSessionState(snapshot) : 'idle';
  const activeKey = navKeyForRoute(props.route);
  // A set running while the operator is on a planner route is exactly what
  // `liveKey` is for — the Live item picks up a quiet green cue instead of the
  // athlete's set going unannounced off-view.
  const liveKey = sessionState === 'live' && activeKey !== 'live' ? 'live' : null;
  const shellRef = useNavSelectedShim(activeKey);

  return (
    <div
      ref={shellRef}
      style={{ height: '100vh', width: '100vw', display: 'flex', overflow: 'hidden' }}
    >
      <DashboardShell
        activeKey={activeKey}
        navItems={NAV_ITEMS}
        liveKey={liveKey}
        state={sessionState}
        devices={devices}
        subtitle={props.route.name === 'live' ? 'wall dashboard' : 'planning'}
        onNavigate={(key) => {
          const target = NAV_ROUTES[key];
          if (target !== undefined) window.location.hash = routeHash(target);
        }}
      >
        {props.scroll === true ? (
          <div style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden' }}>
            {props.children}
          </div>
        ) : (
          props.children
        )}
      </DashboardShell>
    </div>
  );
}
