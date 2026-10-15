// @vitest-environment happy-dom
//
// The `#/body` drill wired end to end in a DOM (VW-713): `BodyPage` mounted with
// `react-dom/client`, its four routes served from synthetic fixtures. The static
// render tests in `spa-body-page.test.ts` cannot see a handler or an effect, so
// this file is what proves a press opens the sheet, the panel's own dismiss
// pops it, the hash and the stack follow each other, and the idle heal arms.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BodyPage } from '../spa/body/BodyPage.js';
import { IDLE_HEAL_MS } from '../spa/drill/idle-heal.js';
import { buildMuscleWeekView, type MuscleWeekRows } from '../read-models/muscle-week.js';
import type { MuscleStrengthView } from '../read-models/index.js';
import { MUSCLE_MAP_VERSION } from '../../exercises/muscle-map.js';
import type { StoredSet } from '../../store/types.js';

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

const NOW = new Date('2026-07-08T12:00:00.000Z');
const MONDAY = '2026-07-06T00:00:00.000Z';
const catalog: MuscleWeekRows['catalog'] = (id) =>
  id === 'chest-press' ? { id, name: 'Chest Press', muscleGroups: ['chest'] } : undefined;

function chestSet(n: number): StoredSet {
  return {
    id: `set-${n}`,
    sessionId: 'sess-1',
    startedAt: MONDAY,
    endedAt: MONDAY,
    partial: false,
    reps: [],
    exerciseId: 'chest-press',
    firmwareRepCount: 8,
  };
}

/** Six chest sets; every other muscle at zero, except calves, which the week omits. */
function week() {
  const view = buildMuscleWeekView({
    sets: Array.from({ length: 6 }, (_, n) => chestSet(n)),
    catalog,
    now: NOW,
  });
  return { ...view, muscles: view.muscles.filter((m) => m.muscle !== 'calves') };
}

const STRENGTH: MuscleStrengthView = {
  muscleMapVersion: MUSCLE_MAP_VERSION,
  agreementBasis: 'two exercises trending the same way',
  earlyPhaseBasis: 'under 6 months of training history',
  muscles: [],
};

/** Week and strength answer; plan 404s (no active week) and recovery fails. */
function stubRoutes(): void {
  vi.stubGlobal('fetch', (url: string) => {
    if (url === '/api/muscle-week') return Promise.resolve(Response.json(week()));
    if (url === '/api/muscle-strength') return Promise.resolve(Response.json(STRENGTH));
    return Promise.resolve(new Response('{}', { status: url === '/api/muscle-plan' ? 404 : 500 }));
  });
}

let container: HTMLDivElement;
let root: Root;

/** Runs `run` inside `act`, so React flushes its renders and effects before the next line. */
async function inAct(run: () => unknown): Promise<void> {
  await act(async () => {
    await run();
  });
}

/** Mounts the page and lets the first poll land. */
async function mount(muscle?: string): Promise<void> {
  await inAct(() => root.render(createElement(BodyPage, { muscle })));
  await inAct(() => vi.advanceTimersByTimeAsync(0));
}

/** A new route prop, as `main.tsx` passes on a hashchange. */
async function rerender(muscle?: string): Promise<void> {
  await inAct(() => root.render(createElement(BodyPage, { muscle })));
}

function sheet(): Element | null {
  return container.querySelector('[aria-label$=" volume details"]');
}

function sheetTitle(): string | null {
  return sheet()?.getAttribute('aria-label') ?? null;
}

function byTestId(id: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
}

/** The strip chip for one muscle, found by the label it reads out. */
function stripChip(name: string): HTMLElement {
  const chip = byTestId('muscle-group-chip-pressable').find((el) =>
    el.getAttribute('aria-label')!.startsWith(`${name} `),
  );
  if (chip === undefined) throw new Error(`no strip chip for ${name}`);
  return chip;
}

async function press(el: HTMLElement): Promise<void> {
  await inAct(() => el.click());
}

async function elapse(ms: number): Promise<void> {
  await inAct(() => vi.advanceTimersByTimeAsync(ms));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  stubRoutes();
  window.location.hash = '#/body';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await inAct(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the body page drill in a DOM', () => {
  it('opens the sheet from a press on either figure and names it in the hash', async () => {
    await mount();
    const [front, back] = byTestId('body-map-muscle-chest');

    await press(front!);
    expect(sheetTitle()).toBe('Chest volume details');
    expect(window.location.hash).toBe('#/body/chest');

    await press(byTestId('body-map-detail-panel-close')[0]!);
    await press(back!);
    expect(sheetTitle()).toBe('Chest volume details');
  });

  it('opens the sheet from a strip chip, replacing an open one', async () => {
    await mount('chest');

    await press(stripChip('Lats'));

    expect(sheetTitle()).toBe('Lats volume details');
    expect(container.querySelectorAll('[aria-label$=" volume details"]')).toHaveLength(1);
    expect(window.location.hash).toBe('#/body/lats');
  });

  it('pops the sheet from the panel close button and puts the hash back', async () => {
    await mount();
    await press(stripChip('Chest'));

    await press(byTestId('body-map-detail-panel-close')[0]!);

    expect(sheet()).toBeNull();
    expect(window.location.hash).toBe('#/body');
  });

  it('pops the sheet on Escape', async () => {
    await mount('chest');

    await inAct(() => {
      sheet()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(sheet()).toBeNull();
    expect(window.location.hash).toBe('#/body');
  });

  it('follows a hash change it did not make', async () => {
    await mount();

    await rerender('lats');
    expect(sheetTitle()).toBe('Lats volume details');

    await rerender(undefined);
    expect(sheet()).toBeNull();
  });

  it('keeps the sheet open across polls', async () => {
    await mount('chest');

    await elapse(5_000);

    expect(sheetTitle()).toBe('Chest volume details');
  });

  it('returns to the glance after 60 s with no input', async () => {
    await mount('chest');

    await elapse(IDLE_HEAL_MS);

    expect(sheet()).toBeNull();
    expect(window.location.hash).toBe('#/body');
  });

  it('holds the sheet open while the lifter keeps touching the wall', async () => {
    await mount('chest');

    await elapse(IDLE_HEAL_MS - 1_000);
    await inAct(() => {
      document.dispatchEvent(new Event('pointerdown'));
    });
    await elapse(IDLE_HEAL_MS - 1_000);

    expect(sheetTitle()).toBe('Chest volume details');
  });

  it('drops a deep link to a muscle the week cannot draw', async () => {
    window.location.hash = '#/body/calves';

    await mount('calves');

    expect(sheet()).toBeNull();
    expect(window.location.hash).toBe('#/body');
  });
});
