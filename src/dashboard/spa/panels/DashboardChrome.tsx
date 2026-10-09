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
 * ships four categories (Live · Review · Plan · Body); a nav button that does
 * nothing is worse chrome than no button, so an item appears only once its
 * route is in {@link NAV_ROUTES}. `body` joined them with VW-338; `goals`, which
 * titan's categories do not carry, joined with VW-845 on titan's target glyph.
 *
 * Chrome inputs (devices, session state) are read from the store here rather
 * than passed down, so a route that knows nothing about BLE still renders a
 * truthful TopBar.
 */
import React, { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import {
  DashboardShell,
  ScaleIcon,
  TargetIcon,
  workoutNavItems,
  type SessionState,
  type SideNavItem,
} from '@titan-design/react-ui';

import { dashboardStore } from '../store';
import { buildSessionState, buildTopBarDevices } from '../adapter';
import { routeHash, type Route } from '../routing';
import { PAGE_PADDING } from '../planner/PlanBuilderPage';
import { PinnedLiveStripSlot } from './PinnedLiveStripSlot';

/**
 * Nav key ⇄ route. The nav rail renders exactly these, in this order: what is
 * happening, what happened, the plan, the goals that plan serves, the weekly check-in, then the body.
 */
export const NAV_ROUTES: Record<string, Route> = {
  live: { name: 'live' },
  review: { name: 'summary', sessionId: 'latest' },
  program: { name: 'plan' },
  goals: { name: 'goals' },
  checkin: { name: 'checkin' },
  body: { name: 'body' },
};

const GOALS_NAV_ITEM: SideNavItem = {
  key: 'goals',
  label: 'Goals',
  icon: <TargetIcon size={20} color="currentColor" />,
};

const CHECKIN_NAV_ITEM: SideNavItem = {
  key: 'checkin',
  label: 'Check-in',
  icon: <ScaleIcon size={20} color="currentColor" />,
};

/** titan's categories plus Goals and Check-in, keyed and ordered by {@link NAV_ROUTES}. */
const NAV_ITEMS = Object.keys(NAV_ROUTES).flatMap((key) =>
  [...workoutNavItems, GOALS_NAV_ITEM, CHECKIN_NAV_ITEM].filter((item) => item.key === key),
);

/** The nav key a route highlights. Inverse of {@link NAV_ROUTES}. */
export function navKeyForRoute(route: Route): string {
  switch (route.name) {
    case 'plan':
      return 'program';
    case 'summary':
      return 'review';
    case 'live':
      return 'live';
    case 'body':
      return 'body';
    case 'goals':
      return 'goals';
    case 'checkin':
      return 'checkin';
  }
}

/**
 * The rail item that carries the live cue, or `null` for none (VW-121, VW-338).
 *
 * A set running while the operator is on another route is exactly what titan's
 * `liveKey` is for — the Live item picks up a quiet green cue instead of the
 * athlete's set going unannounced off-view. The route the operator is ON never
 * cues itself, which is also how the body page stays free of live telemetry
 * while a set runs (plan §3, NAV-D02).
 */
export function liveNavKey(state: SessionState, activeKey: string): string | null {
  return state === 'live' && activeKey !== 'live' ? 'live' : null;
}

/** Live and body are both read-at-a-distance wall surfaces; the rest are operator documents. */
function subtitleForRoute(route: Route): string {
  return route.name === 'live' || route.name === 'body' ? 'wall dashboard' : 'planning';
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

/** Inset on the page gutter, the same as the live strip, so both pinned rows line up. */
function PinnedHeader({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div style={{ padding: `${PAGE_PADDING}px ${PAGE_PADDING}px 0` }}>{children}</div>;
}

/**
 * Shell chrome around a route's content.
 *
 * `scroll` distinguishes the two deployments this shell now serves: the wall is
 * exactly one screen and must never scroll, while the operator surfaces are
 * documents. Both keep the same rail, so a wall that someone walks up to can
 * still reach the plan.
 *
 * `header` pins above the live strip on a scrolling route (VW-654): the page
 * says what it is about first, then the strip flags the running set.
 */
export function DashboardChrome(props: {
  route: Route;
  scroll?: boolean;
  header?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  const snapshot = useStore(dashboardStore, (s) => s.snapshot);
  const status = useStore(dashboardStore, (s) => s.status);

  const devices = snapshot ? buildTopBarDevices(snapshot, status) : [];
  const sessionState: SessionState = snapshot ? buildSessionState(snapshot) : 'idle';
  const activeKey = navKeyForRoute(props.route);
  const liveKey = liveNavKey(sessionState, activeKey);
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
        subtitle={subtitleForRoute(props.route)}
        onNavigate={(key) => {
          const target = NAV_ROUTES[key];
          if (target !== undefined) window.location.hash = routeHash(target);
        }}
      >
        {props.scroll === true ? (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            {props.header != null && <PinnedHeader>{props.header}</PinnedHeader>}
            <PinnedLiveStripSlot route={props.route} />
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
              {props.children}
            </div>
          </div>
        ) : (
          props.children
        )}
      </DashboardShell>
    </div>
  );
}
