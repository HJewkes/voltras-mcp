// The `#/goals` route and the chrome's pinned header slot (VW-654, VW-466 slice 8).
//
// The route owns one poll whose result feeds both the page body and, from VW-655, the
// mesocycle header. The chrome renders header, live strip, scroll container in that order,
// and with no header it renders exactly what it rendered before the slot existed.
//
// The strip is mocked to a marker: its real render is `null` without a running set, which
// would leave nothing to order against. Rendered with `renderToStaticMarkup`, same technique
// as `spa-body-page.test.ts`.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../spa/panels/PinnedLiveStripSlot', () => ({
  PinnedLiveStripSlot: () => createElement('div', { 'data-slot': 'strip' }),
}));
vi.mock('../spa/goals/use-goals-poll.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useGoalsPoll: vi.fn(),
}));

import { DashboardChrome } from '../spa/panels/DashboardChrome.js';
import { GoalsRoute } from '../spa/goals/GoalsRoute.js';
import { loadGoalsPage, useGoalsPoll } from '../spa/goals/use-goals-poll.js';
import type { GoalPriorityRow } from '../goal-progress-api.js';
import type { MesocycleView } from '../read-models/index.js';

const MESOCYCLE: MesocycleView = {
  programName: 'Synthetic Program',
  blockId: 'block-1',
  blockName: 'Accumulation',
  focus: 'volume',
  blockIndex: 1,
  blockCount: 2,
  startsOn: '2026-09-07',
  endsOn: '2026-10-04',
  state: 'current',
  week: { n: 2, of: 4, isDeload: false },
  weeks: [1, 2, 3, 4].map((index) => ({ index, isDeload: index === 4, skipped: null })),
  nextBlock: null,
};

const PRIORITY_ROW = {
  priority: { id: 'pri-1' },
  targets: [],
  rollup: null,
} as unknown as GoalPriorityRow;

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string) => {
    const body = input.startsWith('/api/goals')
      ? { priorities: [PRIORITY_ROW], mesocycle: MESOCYCLE, review: null }
      : { targets: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function chrome(header?: React.ReactNode): string {
  return renderToStaticMarkup(
    createElement(DashboardChrome, {
      route: { name: 'goals' },
      scroll: true,
      header,
      children: createElement('div', { 'data-slot': 'page' }),
    }),
  );
}

const TODAYS_COLUMN =
  '<div style="height:100%;display:flex;flex-direction:column">' +
  '<div data-slot="strip"></div>' +
  '<div style="flex:1;min-height:0;overflow-y:auto;overflow-x:hidden">' +
  '<div data-slot="page"></div></div></div>';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(useGoalsPoll).mockReset();
});

describe('one goals fetch feeds the page and the header', () => {
  it('reads priorities and the mesocycle from a single /api/goals call', async () => {
    const fetchMock = stubFetch();

    const data = await loadGoalsPage();

    const goalsCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/goals');
    expect(goalsCalls).toHaveLength(1);
    expect(data.priorities).toEqual([PRIORITY_ROW]);
    expect(data.mesocycle).toEqual(MESOCYCLE);
    expect(data.progress).toEqual({ 'pri-1': [] });
  });

  it('renders the page from the route’s one poll inside the scrolling chrome', () => {
    vi.mocked(useGoalsPoll).mockReturnValue({
      data: { priorities: [], progress: {}, mesocycle: MESOCYCLE },
      error: null,
    });

    const html = renderToStaticMarkup(createElement(GoalsRoute));

    expect(useGoalsPoll).toHaveBeenCalledTimes(1);
    expect(html).toContain('data-slot="strip"');
    expect(html).toContain('No priorities declared');
  });

  it('shows the fetch error in the page body', () => {
    vi.mocked(useGoalsPoll).mockReturnValue({ data: null, error: 'HTTP 500' });

    const html = renderToStaticMarkup(createElement(GoalsRoute));

    expect(html).toContain('HTTP 500');
  });
});

describe('the chrome header slot', () => {
  it('pins the header above the strip, above the scroll container', () => {
    const html = chrome(createElement('div', { 'data-slot': 'header' }));

    const header = html.indexOf('data-slot="header"');
    const strip = html.indexOf('data-slot="strip"');
    const scroll = html.indexOf('overflow-y:auto');
    expect(header).toBeGreaterThan(-1);
    expect(header).toBeLessThan(strip);
    expect(strip).toBeLessThan(scroll);
    expect(scroll).toBeLessThan(html.indexOf('data-slot="page"'));
  });

  it('insets the header on the page gutter, like the strip', () => {
    const html = chrome(createElement('div', { 'data-slot': 'header' }));

    expect(html).toMatch(/<div style="padding:\d+px \d+px 0"><div data-slot="header">/);
  });

  it('keeps today’s DOM with no header', () => {
    expect(chrome()).toContain(TODAYS_COLUMN);
    expect(chrome(null)).toBe(chrome());
  });
});
