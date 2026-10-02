// Render + model tests for the `#/body` wall page (VW-338, plan D1).
//
// The week fixture is built with `buildMuscleWeekView` — the same function
// `/api/muscle-week` calls — so it is exactly the shape the route returns. The
// strength and plan fixtures are typed literals of their view interfaces, which
// gives the same guarantee for routes whose builders need a store-shaped input.
//
// `BodyView` is then rendered with `renderToStaticMarkup`, same technique as
// `spa-goals-page.test.ts`. The chrome half asserts the two route-level
// done_whens: the nav rail carries `body`, and a set running while the page is
// open shows on the LIVE item rather than anywhere on the body page.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultNavItems } from '@titan-design/react-ui';

import { BodyView, type BodyViewProps } from '../spa/body/BodyView.js';
import {
  bindIdleHeal,
  bodyDrillHandlers,
  bodyHashFor,
  initialBodyStack,
  openMuscle,
  syncToRoute,
} from '../spa/body/body-drill.js';
import { drillStackReducer, type DrillAction, type DrillStack } from '../spa/drill/drill-stack.js';
import { IDLE_HEAL_MS } from '../spa/drill/idle-heal.js';
import { loadBodyPage } from '../spa/body/BodyPage.js';
import {
  bodyMapData,
  muscleStripData,
  nextUpRows,
  prRows,
  prValueText,
  weekSummary,
  type BodyPageData,
} from '../spa/body/body-model.js';
import { DashboardChrome, liveNavKey, navKeyForRoute } from '../spa/panels/DashboardChrome.js';
import { buildMuscleWeekView, type MuscleWeekRows } from '../read-models/muscle-week.js';
import { e1rmBand } from '../../tools/e1rm-band.js';
import type {
  MusclePlanView,
  MuscleRecoveryView,
  MuscleStrengthBestE1rm,
  MuscleStrengthView,
} from '../read-models/index.js';
import { MUSCLE_MAP_VERSION, TITAN_MUSCLE_GROUPS } from '../../exercises/muscle-map.js';
import type { StoredSet } from '../../store/types.js';

const NOW = new Date('2026-07-08T12:00:00.000Z'); // Wednesday
const MONDAY = '2026-07-06T00:00:00.000Z';

const CATALOG = [
  { id: 'chest-press', name: 'Chest Press', muscleGroups: ['chest'] },
  { id: 'cable-row', name: 'Cable Row', muscleGroups: ['back'] },
];
const catalog: MuscleWeekRows['catalog'] = (id) => CATALOG.find((e) => e.id === id);

let nextSetId = 0;
function set(exerciseId: string): StoredSet {
  nextSetId += 1;
  return {
    id: `set-${nextSetId}`,
    sessionId: 'sess-1',
    startedAt: MONDAY,
    endedAt: MONDAY,
    partial: false,
    reps: [],
    exerciseId,
    firmwareRepCount: 8,
  };
}

/**
 * 16 chest sets — inside chest's productive band (mav 14 / mrv 20) and under the
 * 0.85 intensity that would make it `approaching` — and 3 back sets, which is
 * below the mev 8 that lats and upper_back share.
 */
function weekView(): ReturnType<typeof buildMuscleWeekView> {
  nextSetId = 0;
  const sets = [
    ...Array.from({ length: 16 }, () => set('chest-press')),
    ...Array.from({ length: 3 }, () => set('cable-row')),
  ];
  return buildMuscleWeekView({ sets, catalog, now: NOW });
}

/** The route's own e1RM shape, with the real band builder rather than a made-up one. */
function bestE1rm(value: number, confidence: number): MuscleStrengthBestE1rm {
  return { value, band: e1rmBand(value, 'reps'), method: 'reps', confidence };
}

/** The recency fields (VW-558) this page does not read yet. */
const NO_RECENCY = {
  setCount: 0,
  currentLevel: null,
  relativeIndex: null,
  daysSinceTrained: null,
  recency: null,
} as const;

const STRENGTH: MuscleStrengthView = {
  muscleMapVersion: MUSCLE_MAP_VERSION,
  agreementBasis: 'two exercises trending the same way',
  earlyPhaseBasis: 'under 6 months of training history',
  muscles: [
    {
      muscle: 'chest',
      agreement: 'stronger',
      earlyPhase: false,
      relativeIndexBySide: {},
      daysSinceTrained: null,
      exercises: [
        {
          exerciseId: 'chest-press',
          name: 'Chest Press',
          side: null,
          bestE1rm: bestE1rm(182.5, 0.8),
          slopePctPerWeek: 1.4,
          rSquared: 0.7,
          isPR: true,
          priorBest: 175,
          plateau: 'none',
          ...NO_RECENCY,
        },
      ],
    },
    {
      // The same exercise filed under a second muscle — `prRows` must not list it twice.
      muscle: 'lats',
      agreement: 'insufficient',
      earlyPhase: false,
      relativeIndexBySide: {},
      daysSinceTrained: null,
      exercises: [
        {
          exerciseId: 'chest-press',
          name: 'Chest Press',
          side: null,
          bestE1rm: bestE1rm(182.5, 0.8),
          slopePctPerWeek: 1.4,
          rSquared: 0.7,
          isPR: true,
          priorBest: 175,
          plateau: 'none',
          ...NO_RECENCY,
        },
        {
          exerciseId: 'cable-row',
          name: 'Cable Row',
          side: null,
          bestE1rm: bestE1rm(160, 0.7),
          slopePctPerWeek: 0.4,
          rSquared: 0.5,
          isPR: false,
          priorBest: 165,
          plateau: 'none',
          ...NO_RECENCY,
        },
      ],
    },
  ],
};

const PLAN: MusclePlanView = {
  weekStart: MONDAY,
  weekIndex: 3,
  isDeload: false,
  muscleMapVersion: MUSCLE_MAP_VERSION,
  muscles: [
    {
      muscle: 'chest',
      plannedSetsThisWeek: 12,
      doneSetsThisWeek: 9,
      frequency: { plannedPerWeek: 2, observedThisWeek: 1 },
      plannedRemaining: [
        { workoutName: 'Push A', exerciseId: 'chest-press', exerciseName: 'Chest Press', sets: 3 },
      ],
    },
    {
      // Same lift, second muscle — `nextUpRows` folds it to one row.
      muscle: 'triceps',
      plannedSetsThisWeek: 3,
      doneSetsThisWeek: 0,
      frequency: { plannedPerWeek: 2, observedThisWeek: 1 },
      plannedRemaining: [
        { workoutName: 'Push A', exerciseId: 'chest-press', exerciseName: 'Chest Press', sets: 3 },
      ],
    },
    {
      muscle: 'lats',
      plannedSetsThisWeek: 9,
      doneSetsThisWeek: 3,
      frequency: { plannedPerWeek: 2, observedThisWeek: 1 },
      plannedRemaining: [
        { workoutName: 'Pull A', exerciseId: 'cable-row', exerciseName: 'Cable Row', sets: 6 },
      ],
    },
  ],
};

/** No muscle trained yet: the page does not render recovery until the sheet (VW-339 S3). */
const RECOVERY: MuscleRecoveryView = {
  muscleMapVersion: MUSCLE_MAP_VERSION,
  muscles: TITAN_MUSCLE_GROUPS.map((muscle) => ({
    muscle,
    lastTrainedAt: null,
    daysSince: null,
    lastEntryDepression: null,
    lastSessionMatchedPrior: null,
    reason: 'insufficient history',
  })),
};

function pageData(over: Partial<BodyPageData> = {}): BodyPageData {
  return { week: weekView(), strength: STRENGTH, plan: PLAN, recovery: RECOVERY, ...over };
}

function markup(data: BodyPageData, drill: Omit<BodyViewProps, 'data'> = {}): string {
  return renderToStaticMarkup(createElement(BodyView, { data, ...drill }));
}

/** Rendered text with runs of whitespace collapsed, same normalisation the captures use. */
function text(data: BodyPageData, drill: Omit<BodyViewProps, 'data'> = {}): string {
  return markup(data, drill)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('the body page model', () => {
  it('omits untrained muscles from the figure so they keep the outline fill', () => {
    const painted = bodyMapData(weekView()).map((d) => d.muscleGroup);
    expect(painted.sort()).toEqual(['chest', 'lats', 'upper_back']);
  });

  it('paints a muscle inside the productive band as a target status', () => {
    const chest = bodyMapData(weekView()).find((d) => d.muscleGroup === 'chest');
    expect(chest?.weeklySets).toBe(16);
    expect(chest?.volumeStatus).toBe('target');
  });

  it('seeds every titan group into the strip, untrained ones included', () => {
    const strip = muscleStripData(weekView());
    expect(Object.keys(strip)).toHaveLength(15);
    // The route already carries every group with zeros, so an untrained muscle
    // keeps its own MAV target; the all-15 seed is the guard for one it drops.
    expect(strip.quads).toEqual({ sets: 0, target: 12, volumeStatus: 'untrained' });
    // Target is MAV, the week a chip is measured against — not the MRV ceiling.
    expect(strip.chest).toEqual({ sets: 16, target: 14, volumeStatus: 'target' });
  });

  it('counts sets per muscle, so a lift training two muscles counts in both', () => {
    // 16 chest sets + 3 back sets, and `back` maps to BOTH lats and upper_back,
    // so the set total is 16 + 3 + 3. `under` includes the untrained muscles,
    // minus abs and obliques, whose mev of 0 nothing can fall below, and glutes,
    // lats and upper back, whose landmarks draw no verdict (VW-561).
    expect(weekSummary(weekView())).toEqual({
      totalSets: 22,
      trainedMuscles: 3,
      productive: 1,
      under: 9,
      over: 0,
    });
  });

  it('paints a trained muscle with a withheld verdict in the neutral fill (VW-561)', () => {
    const week = weekView();
    const withGlutes = {
      ...week,
      muscles: week.muscles.map((m) => (m.muscle === 'glutes' ? { ...m, sets: 5 } : m)),
    };
    const glutes = bodyMapData(withGlutes).find((d) => d.muscleGroup === 'glutes');
    expect(glutes?.volumeStatus).toBe('ontrack');
    expect(weekSummary(withGlutes)).toMatchObject({ productive: 1, under: 9, over: 0 });
  });

  it('folds one planned lift owed to several muscles into a single next-up row', () => {
    expect(nextUpRows(PLAN)).toEqual([
      { exerciseId: 'chest-press', exerciseName: 'Chest Press', workoutName: 'Push A', sets: 3 },
      { exerciseId: 'cable-row', exerciseName: 'Cable Row', workoutName: 'Pull A', sets: 6 },
    ]);
  });

  it('renders no next-up rows when no training week is active', () => {
    expect(nextUpRows(null)).toEqual([]);
  });

  it('lists a PR once even when the lift is filed under two muscles', () => {
    const rows = prRows(STRENGTH);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.exerciseName).toBe('Chest Press');
    expect(prValueText(rows[0]!)).toBe('182.5 lb (+7.5)');
  });
});

describe('the body page render', () => {
  it('shows the week summary tiles against their own labels', () => {
    const rendered = text(pageData());
    // Each label with ITS value, not the five numbers anywhere on the page:
    // swapping two tiles' data sources leaves every number present.
    expect(rendered).toContain('Sets 22');
    expect(rendered).toContain('Muscles 3');
    expect(rendered).toContain('Productive 1');
    expect(rendered).toContain('Below MEV 9');
    expect(rendered).toContain('Over MRV 0');
  });

  it('labels the landmarks as a population default rather than this athletes own', () => {
    expect(text(pageData())).toContain('Landmarks: population-default');
  });

  it('renders both figures, the strip and the status legend', () => {
    const rendered = text(pageData());
    expect(rendered).toContain('Weekly sets by muscle');
    expect(rendered).toContain('Legend');
    // `BodyMap`'s own per-muscle legend chips carry the set counts; two figures
    // means the chest chip appears twice, once per face.
    expect(rendered.split('Chest').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('shows the next-up lifts and the PR list', () => {
    const rendered = text(pageData());
    expect(rendered).toContain('Next up');
    expect(rendered).toContain('Chest Press');
    expect(rendered).toContain('Pull A');
    expect(rendered).toContain('Recent PRs');
    expect(rendered).toContain('182.5 lb (+7.5)');
  });

  it('empties both rails rather than erroring with no plan and no PRs', () => {
    const rendered = text(
      pageData({
        plan: null,
        strength: { ...STRENGTH, muscles: [] },
      }),
    );
    expect(rendered).toContain('No planned week');
    expect(rendered).toContain('No PRs yet');
  });
});

describe('the body page load', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Serves each `/api/muscle-*` route from its fixture, failing the ones named. */
  function stubRoutes(failing: readonly string[]): void {
    const bodies: Record<string, unknown> = {
      '/api/muscle-week': weekView(),
      '/api/muscle-strength': STRENGTH,
      '/api/muscle-plan': PLAN,
      '/api/muscle-recovery': RECOVERY,
    };
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        failing.includes(url)
          ? new Response(JSON.stringify({ message: 'store unavailable' }), { status: 500 })
          : new Response(JSON.stringify(bodies[url]), { status: 200 }),
      ),
    );
  }

  it('still renders the glance when only the recovery route fails', async () => {
    stubRoutes(['/api/muscle-recovery']);

    const data = await loadBodyPage();

    expect(data.recovery).toBeNull();
    const rendered = text(data);
    expect(rendered).toContain('Weekly sets by muscle');
    expect(rendered).not.toContain('store unavailable');
  });

  it('still fails the page when the week route fails', async () => {
    stubRoutes(['/api/muscle-week']);

    await expect(loadBodyPage()).rejects.toThrow('store unavailable');
  });
});

describe('the body route in the shell chrome', () => {
  it('is a nav key titan already ships an item for', () => {
    expect(navKeyForRoute({ name: 'body' })).toBe('body');
    expect(defaultNavItems.map((item) => item.key)).toContain('body');
  });

  it('renders the nav rail item now that the route exists', () => {
    const markup = renderToStaticMarkup(
      createElement(DashboardChrome, { route: { name: 'body' }, children: null }),
    );
    expect(markup).toContain('aria-label="Body"');
  });

  it('cues the Live rail item while a set runs with the body page open', () => {
    // Asserted on the pure function rather than the rendered chrome: zustand's
    // `useStore` serves `getInitialState` under `renderToStaticMarkup`, so a
    // store write is invisible to an SSR render (the shell would report `idle`
    // however live the session is).
    expect(liveNavKey('live', 'body')).toBe('live');
    expect(liveNavKey('rest', 'body')).toBeNull();
    // The live page never cues itself — that is the same branch that keeps the
    // body page's live signal on the rail and off the page.
    expect(liveNavKey('live', 'live')).toBeNull();
  });
});

/** Chest trained two days ago, so the sheet has a "Last trained" line to show. */
const CHEST_TRAINED: MuscleRecoveryView = {
  ...RECOVERY,
  muscles: RECOVERY.muscles.map((row) =>
    row.muscle === 'chest'
      ? {
          ...row,
          lastTrainedAt: MONDAY,
          daysSince: 2,
          lastSessionMatchedPrior: true,
          reason: null,
        }
      : row,
  ),
};

describe('the body page drill', () => {
  const chestOpen = initialBodyStack('chest');

  it('renders the chest sheet over the glance when the stack holds chest', () => {
    const rendered = text(pageData({ recovery: CHEST_TRAINED }), { stack: chestOpen });

    expect(rendered).toContain('Chest');
    expect(rendered).toContain('Chest target met ×');
    expect(rendered).toContain('2 days ago · matched last session');
    // The sheet slides over the glance; the glance headers stay rendered beneath it.
    expect(rendered).toContain('Weekly sets by muscle');
    expect(markup(pageData(), { stack: chestOpen })).toContain('aria-label="Chest volume details"');
  });

  it('renders no sheet with an empty stack', () => {
    expect(markup(pageData())).not.toContain('volume details');
  });

  /** Each figure's legend chip for a muscle, as its opening tag. */
  function chips(html: string, name: string): string[] {
    return html.match(new RegExp(`<[^>]*aria-label="${name}, [^>]*>`, 'g')) ?? [];
  }

  it('highlights the open muscle on both figures', () => {
    const open = markup(pageData(), { stack: chestOpen });

    expect(chips(open, 'Chest').filter((tag) => tag.includes('aria-pressed="true"'))).toHaveLength(
      2,
    );
    expect(chips(open, 'Lats').some((tag) => tag.includes('aria-pressed="true"'))).toBe(false);
    expect(
      chips(markup(pageData()), 'Chest').some((tag) => tag.includes('aria-pressed="true"')),
    ).toBe(false);
  });

  it('draws no sheet for a muscle the week does not carry', () => {
    const week = weekView();
    const noChest = { ...week, muscles: week.muscles.filter((m) => m.muscle !== 'chest') };

    expect(markup(pageData({ week: noChest }), { stack: chestOpen })).not.toContain(
      'volume details',
    );
  });
});

describe('the body drill handlers', () => {
  /** Runs handler calls through the real reducer, the way `useReducer` would. */
  function drive(start: DrillStack, act: (h: ReturnType<typeof bodyDrillHandlers>) => void) {
    let stack = start;
    act(bodyDrillHandlers((action: DrillAction) => (stack = drillStackReducer(stack, action))));
    return stack;
  }

  it('opens the pressed muscle on an empty stack', () => {
    expect(openMuscle(drive([], (h) => h.onMusclePress('lats')))).toBe('lats');
  });

  it('replaces the open sheet when a second muscle is pressed', () => {
    const stack = drive(initialBodyStack('chest'), (h) => h.onMusclePress('lats'));

    expect(stack).toEqual([{ lineage: 'muscle', id: 'lats' }]);
  });

  it('pops the sheet on the panel onClose, which Escape and the close button both call', () => {
    expect(drive(initialBodyStack('chest'), (h) => h.onClose())).toEqual([]);
  });

  it('starts closed with no deep link and open on one', () => {
    expect(initialBodyStack(undefined)).toEqual([]);
    expect(openMuscle(initialBodyStack('quads'))).toBe('quads');
  });

  it('names the open sheet in the hash and drops it once closed', () => {
    expect(bodyHashFor(initialBodyStack('upper_back'))).toBe('#/body/upper_back');
    expect(bodyHashFor([])).toBe('#/body');
  });

  it('follows a hash change the stack did not make, and ignores one it did', () => {
    const chest = initialBodyStack('chest');

    expect(syncToRoute(chest, 'chest')).toBeNull();
    expect(syncToRoute([], undefined)).toBeNull();
    expect(syncToRoute(chest, undefined)).toEqual({ type: 'reset' });
    expect(syncToRoute(chest, 'lats')).toEqual({
      type: 'open',
      layer: { lineage: 'muscle', id: 'lats' },
    });
  });
});

describe('the body drill idle heal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A deep-linked chest sheet with the heal bound to a stand-in document. */
  function openSheet() {
    const doc = new EventTarget();
    let stack: DrillStack = initialBodyStack('chest');
    const bound = bindIdleHeal(doc, (action) => (stack = drillStackReducer(stack, action)));
    bound.heal.setActive(true);
    return { doc, bound, stack: () => stack };
  }

  it('returns the page to the glance after 60 s with no input', () => {
    const { stack } = openSheet();

    vi.advanceTimersByTime(IDLE_HEAL_MS);

    expect(stack()).toEqual([]);
  });

  it('keeps the sheet open while the lifter keeps touching the wall', () => {
    const { doc, stack } = openSheet();

    vi.advanceTimersByTime(IDLE_HEAL_MS - 1_000);
    doc.dispatchEvent(new Event('pointerdown'));
    vi.advanceTimersByTime(IDLE_HEAL_MS - 1_000);

    expect(openMuscle(stack())).toBe('chest');
  });

  it('stops listening and never heals once unbound', () => {
    const { doc, bound, stack } = openSheet();

    bound.unbind();
    bound.heal.setActive(true);
    doc.dispatchEvent(new Event('keydown'));
    vi.advanceTimersByTime(IDLE_HEAL_MS * 2);

    expect(openMuscle(stack())).toBe('chest');
    expect(vi.getTimerCount()).toBe(0);
  });
});
