// Render tests for the lbs/kg display toggle on the live page (VW-63).
//
// The store, mapper, and WA stay in lbs — `mass.ts` converts only at render time. These
// mount the actual `ExerciseHeader` / `RestView` (`renderToStaticMarkup` under the
// react-native-web alias, same technique as `spa-rest-recap.test.ts`) with `displayUnit`
// toggled, so a regression that leaves a readout on lbs regardless of the toggle shows up
// in the rendered markup, not just in a mapper-level assertion.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ExerciseHeader } from '../spa/live-page/LiveView.js';
import { RestView } from '../spa/live-page/RestView.js';
import type {
  CompletedSet,
  DashboardModel,
  PlannedExerciseModel,
  SessionModel,
} from '../spa/live-page/model.js';

function sessionModel(over: Partial<SessionModel> = {}): SessionModel {
  return {
    hasSession: true,
    exerciseName: 'Cable Chest Press',
    title: null,
    lifter: null,
    weightLbs: 100,
    unit: 'lbs',
    completedSets: [],
    plannedExercises: [],
    restSec: null,
    plannedSets: 2,
    targetReps: 8,
    ...over,
  };
}

function planned(over: Partial<PlannedExerciseModel> = {}): PlannedExerciseModel {
  return {
    name: 'Cable Chest Press',
    plannedSets: 2,
    targetReps: 8,
    repsLabel: '8',
    weightLbs: 100,
    active: true,
    ...over,
  };
}

function completed(weightLbs: number | null, reps: number[]): CompletedSet {
  return {
    exerciseName: 'Cable Chest Press',
    weightLbs,
    mode: 'weight',
    repCount: reps.length,
    reps,
    peakForceLbs: null,
  };
}

/** Text of a `data-testid`-marked subtree, tags stripped, whitespace collapsed. */
function textOf(html: string, testId: string): string {
  const marker = html.indexOf(`data-testid="${testId}"`);
  expect(marker).toBeGreaterThan(-1);
  const start = html.indexOf('>', marker) + 1;
  const depth = { open: 1 };
  let i = start;
  while (depth.open > 0 && i < html.length) {
    const nextOpen = html.indexOf('<', i);
    if (html.startsWith('</', nextOpen)) depth.open--;
    else if (html[nextOpen + 1] !== '/' && html[nextOpen + 1] !== undefined) depth.open++;
    i = html.indexOf('>', nextOpen) + 1;
  }
  return html
    .slice(start, i)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('ExerciseHeader load readout follows the display toggle (VW-63)', () => {
  function renderHeader(session: SessionModel, displayUnit?: 'lbs' | 'kg'): string {
    const model: DashboardModel = { live: null, session, restElapsedMs: null };
    return renderToStaticMarkup(
      createElement(ExerciseHeader, displayUnit ? { model, displayUnit } : { model }),
    );
  }

  it('defaults to lbs with no toggle argument', () => {
    const session = sessionModel({ plannedExercises: [planned({ weightLbs: 100 })] });
    expect(textOf(renderHeader(session), 'sets-reps-load')).toBe('2 × 8 @ 100 lbs');
  });

  it('converts the SAME prescribed load to kg when displayUnit is kg', () => {
    const session = sessionModel({ plannedExercises: [planned({ weightLbs: 100 })] });
    // 100 lb × 0.45359237 ≈ 45.36 → rounds to 45 (formatMass, VW-63).
    expect(textOf(renderHeader(session, 'kg'), 'sets-reps-load')).toBe('2 × 8 @ 45 kg');
  });
});

describe('RestView recap/verdict readouts follow the display toggle; velocity does not (VW-63)', () => {
  function renderRest(session: SessionModel, displayUnit?: 'lbs' | 'kg'): string {
    const model: DashboardModel = { live: null, session, restElapsedMs: null };
    return renderToStaticMarkup(
      createElement(RestView, displayUnit ? { model, displayUnit } : { model }),
    );
  }

  it('converts the recap heading load to kg', () => {
    const session = sessionModel({
      plannedExercises: [planned({ weightLbs: 100 })],
      completedSets: [completed(100, [0.6, 0.5])],
    });
    expect(textOf(renderRest(session, 'lbs'), 'recap-card-heading')).toContain('100 lbs');
    expect(textOf(renderRest(session, 'kg'), 'recap-card-heading')).toContain('45 kg');
  });

  it('leaves the velocity-loss verdict identical while the load verdict tile converts', () => {
    // (0.8 - 0.6) / 0.8 × 100 = 25% — unit-invariant, so this string must be the same
    // in both renders even though the load tile beside it converts.
    const session = sessionModel({
      plannedExercises: [planned({ weightLbs: 100 })],
      completedSets: [completed(100, [0.8, 0.6])],
    });
    const lbsHtml = renderRest(session, 'lbs');
    const kgHtml = renderRest(session, 'kg');
    expect(lbsHtml).toContain('25%');
    expect(kgHtml).toContain('25%');
    expect(lbsHtml).toContain('100');
    expect(kgHtml).toContain('45');
    expect(kgHtml).not.toMatch(/>\s*100\s*</);
  });
});
