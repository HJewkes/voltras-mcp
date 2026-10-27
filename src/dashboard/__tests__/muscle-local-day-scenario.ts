// Shared scenario for the muscle local-day tests (VW-918). Each test file pins its own zone
// before importing this, so nothing here builds a Date at import time.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { BodyView } from '../spa/body/BodyView.js';
import { buildMusclePlanView } from '../read-models/muscle-plan.js';
import { buildMuscleWeekView } from '../read-models/muscle-week.js';
import { MUSCLE_MAP_VERSION } from '../../exercises/muscle-map.js';
import type { StoredSet } from '../../store/types.js';

/** Two sets on one local day whose UTC dates differ, and an instant inside that local week. */
export interface LocalDayScenario {
  now: string;
  sameLocalDay: [string, string];
}

const catalog = (id: string) =>
  id === 'chest-press' ? { name: 'Chest Press', muscleGroups: ['chest'] } : undefined;

function workingSet(startedAt: string): StoredSet {
  return {
    id: `set-${startedAt}`,
    sessionId: 'sess-1',
    startedAt,
    endedAt: startedAt,
    partial: false,
    reps: [],
    exerciseId: 'chest-press',
    firmwareRepCount: 8,
  };
}

function weekView(scenario: LocalDayScenario) {
  const sets = scenario.sameLocalDay.map(workingSet);
  return buildMuscleWeekView({ sets, catalog, now: new Date(scenario.now) });
}

export function chestSessions(scenario: LocalDayScenario): number | undefined {
  return weekView(scenario).muscles.find((m) => m.muscle === 'chest')?.sessions;
}

export function chestObservedDays(scenario: LocalDayScenario): number | undefined {
  const view = buildMusclePlanView({
    week: { id: 'wk-1', blockId: 'blk-1', orderIndex: 0, isDeload: false },
    templates: [],
    plannedExercises: [],
    completedSets: scenario.sameLocalDay.map(workingSet),
    catalog,
    now: new Date(scenario.now),
  });
  return view.muscles.find((m) => m.muscle === 'chest')?.frequency.observedThisWeek;
}

export function bodyWeekLabel(scenario: LocalDayScenario): string | undefined {
  const strength = {
    muscleMapVersion: MUSCLE_MAP_VERSION,
    agreementBasis: '',
    earlyPhaseBasis: '',
    muscles: [],
  };
  const data = { week: weekView(scenario), strength, plan: null, recovery: null };
  const html = renderToStaticMarkup(createElement(BodyView, { data }));
  return /Week of \d{4}-\d{2}-\d{2}/.exec(html)?.[0];
}
