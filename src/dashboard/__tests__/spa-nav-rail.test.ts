// The dashboard nav rail (VW-845): every route the SPA serves highlights a rail
// item that exists, and the Goals page is reachable from the rail rather than by
// URL only.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DashboardChrome, NAV_ROUTES, navKeyForRoute } from '../spa/panels/DashboardChrome.js';
import { parseRoute, routeHash, type Route } from '../spa/routing.js';

/** One route per name; the `Record` makes a new route name fail to compile here. */
const EVERY_ROUTE: Record<Route['name'], Route> = {
  live: { name: 'live' },
  plan: { name: 'plan' },
  summary: { name: 'summary', sessionId: 'latest' },
  goals: { name: 'goals' },
  body: { name: 'body' },
  checkin: { name: 'checkin' },
};

function renderRail(route: Route): string {
  return renderToStaticMarkup(createElement(DashboardChrome, { route, children: null }));
}

describe('the dashboard nav rail', () => {
  it.each(Object.values(EVERY_ROUTE))('highlights a rail entry on the $name route', (route) => {
    expect(Object.keys(NAV_ROUTES)).toContain(navKeyForRoute(route));
  });

  it('sends the Goals entry to the goals page', () => {
    expect(navKeyForRoute({ name: 'goals' })).toBe('goals');
    expect(routeHash(NAV_ROUTES.goals)).toBe('#/goals');
  });

  it('round-trips the check-in route through its hash', () => {
    expect(routeHash({ name: 'checkin' })).toBe('#/checkin');
    expect(parseRoute('#/checkin')).toEqual({ name: 'checkin' });
    expect(parseRoute(routeHash(NAV_ROUTES.checkin))).toEqual({ name: 'checkin' });
  });

  it('highlights the Check-in entry on the check-in route', () => {
    expect(navKeyForRoute({ name: 'checkin' })).toBe('checkin');
    expect(renderRail({ name: 'checkin' })).toContain('aria-label="Check-in"');
  });

  it('shows Goals between Plan and Check-in, then Body', () => {
    const markup = renderRail({ name: 'live' });
    const order = ['Live', 'Review', 'Plan', 'Goals', 'Check-in', 'Body'].map((label) =>
      markup.indexOf(`aria-label="${label}"`),
    );

    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
