// @vitest-environment happy-dom
//
// The session-complete ledger (VW-944), mounted with `react-dom/client` over the
// synthetic design fixtures, `fetch` stubbed to answer the summary route with one.
// Tips are not open on mount, so these read only what the wall shows at a glance.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionSummaryView } from '../read-models/session-summary-view.js';
import { loadSummary, type SummaryFixture } from './fixtures/session-summary/load.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Node 25 ships its own global `localStorage`, unusable without a file flag, and it
// shadows the DOM one; the store reads it at import, so this runs before any import.
vi.hoisted(() => {
  if (typeof globalThis.localStorage?.getItem === 'function') return;
  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, String(value)),
    removeItem: (key: string) => void items.delete(key),
    clear: () => items.clear(),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
});

// Driven by a mock, not `matchMedia`: happy-dom lays nothing out, so the test reads the
// layout the band asks for at each width rather than measured geometry.
vi.mock('../spa/use-viewport.js', () => ({ useIsNarrowViewport: vi.fn(() => false) }));

const { useIsNarrowViewport } = await import('../spa/use-viewport.js');
const { SessionSummaryPage } = await import('../spa/planner/SessionSummaryPage.js');
const { dashboardStore } = await import('../spa/store.js');

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  vi.mocked(useIsNarrowViewport).mockReturnValue(false);
  dashboardStore.getState().applyPlanner({ sessionSummary: null, plannerError: null });
  dashboardStore.getState().setDisplayUnit('lbs');
});

function mountFixture(name: SummaryFixture): Promise<HTMLElement> {
  return mountView(loadSummary(name));
}

async function mountView(view: SessionSummaryView): Promise<HTMLElement> {
  const body = JSON.stringify(view);
  vi.stubGlobal(
    'fetch',
    async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
  );
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(SessionSummaryPage, { sessionId: 'fixture' }));
  });
  await vi.waitFor(() => expect(container.textContent).not.toContain('Loading session summary'));
  return container;
}

function bands(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="summary-band"]')];
}

// The full session with one exercise's recommendation turned into a 5 lb step up.
function fullSessionAdding(exercise: string): SessionSummaryView {
  const view = loadSummary('2-full-session');
  const exercises = view.exercises.map((e) =>
    e.name === exercise && e.progression !== null
      ? { ...e, progression: { ...e.progression, delta: 5 } }
      : e,
  );
  return { ...view, exercises };
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('the session-complete ledger (VW-944)', () => {
  it('shows one band per exercise, in order, with its verdict and next load', async () => {
    const rows = bands(await mountFixture('2-full-session')).map((band) => band.textContent);

    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatch(/Cable Romanian Deadlift.*Slowing.*120 lb.*Hold/);
    expect(rows[1]).toMatch(/Seated Cable Row.*Good.*105 lb.*Add 5 lb/);
    expect(rows[2]).toMatch(/Standing Cable Chest Press.*Grinding.*75 lb.*Back off 5 lb/);
    expect(rows[3]).toMatch(/Face Pull.*Good.*No recommendation/);
  });

  it('claims no effort reading and no all-time record', async () => {
    const text = (await mountFixture('2-full-session')).textContent ?? '';

    expect(text).not.toMatch(/\bRPE\b/);
    expect(text).not.toMatch(/\bPR\b/);
    expect(text).toContain('RIR · Calibrating');
  });

  it('names a back-off beside a good verdict once, as a short label', async () => {
    const text = (await mountFixture('1-current')).textContent ?? '';

    expect(count(text, 'Moved well · missed reps')).toBe(1);
    // The sentence is the tip, never visible text (titan design floor).
    expect(text).not.toContain('Moved well, but missed reps.');
  });

  it('names no disagreement where the verdict and the plan agree', async () => {
    const text = (await mountFixture('2-full-session')).textContent ?? '';

    expect(text).not.toMatch(/Moved well ·|Struggled ·/);
  });

  it('reads a slowing bar beside a load step as no struggle', async () => {
    const text = (await mountView(fullSessionAdding('Cable Romanian Deadlift'))).textContent ?? '';

    expect(text).toContain('Slowing');
    expect(text).not.toContain('Struggled · plan adds');
  });

  it('names a load step taken while the bar was grinding', async () => {
    const view = fullSessionAdding('Standing Cable Chest Press');
    const text = (await mountView(view)).textContent ?? '';

    expect(count(text, 'Struggled · plan adds')).toBe(1);
  });

  it('paints the back-off chip and next load in no status colour', async () => {
    const chestPress = bands(await mountFixture('2-full-session'))[2]!;
    const chip = chestPress.querySelector('[aria-label="Back off 5 lb"]');
    // The verdict's own lights carry tone; the next-time column never does.
    const nextTime = chip?.closest<HTMLElement>('div[style*="width: 340px"]');

    expect(nextTime?.textContent).toContain('75 lb');
    expect(nextTime?.innerHTML).not.toMatch(/status-|error|warning|success/);
    expect(nextTime?.innerHTML).not.toMatch(/rgba\((209, 67, 67|224, 82, 84|249, 180, 21)/);
  });

  it('shows loads and steps in kg that agree with each other', async () => {
    dashboardStore.getState().setDisplayUnit('kg');
    const text = (await mountFixture('1-current')).textContent ?? '';

    expect(text).toContain('61 kg');
    expect(text).toContain('Back off 3 kg');
    expect(text).not.toMatch(/\d lb\b/);
  });

  it('marks an open session and gives it no duration', async () => {
    const container = await mountFixture('3-edges');
    const text = container.textContent ?? '';

    expect(text).toContain('Session still open');
    expect(text).not.toMatch(/\d+ min\b/);
  });

  it('heads a band with the display name and no raw catalog id', async () => {
    const facePull = bands(await mountFixture('2-full-session'))[3]!;

    expect(facePull.textContent).toContain('Face Pull');
    expect(facePull.textContent).not.toContain('face-pull');
  });
});

describe('the session-complete ledger on a phone (VW-955)', () => {
  it('reads a wall band left to right', async () => {
    const band = bands(await mountFixture('2-full-session'))[0]!;

    expect(band.style.flexDirection).toBe('row');
  });

  it('stacks verdict, evidence and next time at full width', async () => {
    vi.mocked(useIsNarrowViewport).mockReturnValue(true);
    const band = bands(await mountFixture('2-full-session'))[0]!;
    const [verdict, evidence, nextTime] = [...band.children] as HTMLElement[];

    expect(band.style.flexDirection).toBe('column');
    expect(verdict?.textContent).toContain('Slowing');
    expect(evidence?.textContent).toContain('VL 14%→23%');
    expect(nextTime?.textContent).toContain('NEXT TIME');
    expect([verdict?.style.width, nextTime?.style.width]).toEqual(['100%', '100%']);
  });

  it('wraps set columns at their own width rather than squeezing them', async () => {
    vi.mocked(useIsNarrowViewport).mockReturnValue(true);
    const container = await mountFixture('2-full-session');
    const columns = [
      ...container.querySelectorAll<HTMLElement>('[data-testid="summary-set-column"]'),
    ];

    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) expect(column.style.flexShrink).toBe('0');
    expect(columns[0]?.parentElement?.style.flexWrap).toBe('wrap');
  });

  it('scrolls the set table sideways', async () => {
    vi.mocked(useIsNarrowViewport).mockReturnValue(true);
    const container = await mountFixture('2-full-session');
    const table = container.querySelector<HTMLElement>('[data-testid="summary-set-table"]');

    expect(table?.style.overflowX).toBe('auto');
  });
});
