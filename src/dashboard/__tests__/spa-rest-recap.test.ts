// Render tests for the REST recap card's prescription heading (VMCP-03.05).
//
// The regression: the recap heading read `2 × — @ 0 lbs` for a set whose attached plan said
// `2 × 12–15 @ 45 lbs`. Only the recap STRIP had been routed through the shared prescription
// helper; the heading kept its own path and formatted `session.weightLbs ?? 0`, so a load the
// store did not know printed as a real, fabricated zero.
//
// These mount the actual `RestView` (`renderToStaticMarkup` under the react-native-web alias)
// rather than asserting on the mapper alone: the fabricated zero was titan's own
// `summary?.weight ?? 0` inside `ExerciseCard`, which no mapper-level assertion can see.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RestView } from '../spa/live-page/RestView.js';
import {
  deriveRecapPrescription,
  type CompletedSet,
  type DashboardModel,
  type PlannedExerciseModel,
  type SessionModel,
} from '../spa/live-page/model.js';

function sessionModel(over: Partial<SessionModel> = {}): SessionModel {
  return {
    hasSession: true,
    exerciseName: 'Cable Chest Press',
    title: null,
    weightLbs: null,
    unit: 'lbs',
    completedSets: [],
    plannedExercises: [],
    restSec: null,
    plannedSets: null,
    targetReps: null,
    ...over,
  };
}

function planned(over: Partial<PlannedExerciseModel> = {}): PlannedExerciseModel {
  return {
    name: 'Cable Chest Press',
    plannedSets: 2,
    targetReps: 12,
    repsLabel: '12–15',
    weightLbs: 45,
    active: true,
    ...over,
  };
}

function completed(weightLbs: number | null): CompletedSet {
  return {
    exerciseName: 'Cable Chest Press',
    weightLbs,
    mode: 'weight',
    repCount: 12,
    reps: [0.62, 0.55],
    peakForceLbs: null,
  };
}

/** The rest stage as it renders on the wall, with two logged sets of the active exercise. */
function renderRest(session: SessionModel): string {
  const model: DashboardModel = { live: null, session, restElapsedMs: null };
  return renderToStaticMarkup(createElement(RestView, { model }));
}

/**
 * The visible TEXT of the recap heading's subtree — the prescription lockup only, cut before
 * the per-set rows so a row's own load cannot stand in for the heading's.
 */
function headingText(html: string): string {
  const marker = html.indexOf('data-testid="recap-card-heading"');
  expect(marker).toBeGreaterThan(-1);
  const start = html.indexOf('>', marker) + 1;
  const rows = html.indexOf('data-testid="table-header"', start);
  expect(rows).toBeGreaterThan(start);
  // Back up to that tag's own `<` so the slice never ends mid-tag (an unclosed opening tag
  // survives the strip below and its attributes would land in the "text").
  const end = html.lastIndexOf('<', rows);
  return html
    .slice(start, end)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('rest recap heading — the prescription, never a fabricated zero (VMCP-03.05)', () => {
  it('reads the attached plan', () => {
    const html = renderRest(
      sessionModel({
        plannedSets: 2,
        plannedExercises: [planned()],
        completedSets: [completed(45), completed(45)],
      }),
    );
    // The exact line the 2026-07-28 demo should have shown instead of `2 × — @ 0 lbs`.
    expect(headingText(html)).toBe('Cable Chest Press 2 × 12–15 @ 45 lbs');
  });

  it('reads an em-dash load when neither the plan nor the cascade states one', () => {
    const html = renderRest(
      sessionModel({ weightLbs: null, completedSets: [completed(null), completed(null)] }),
    );
    // The sets cell stays a real count (two sets were logged); the two cells the store
    // cannot state read as gaps. No `0` anywhere.
    expect(headingText(html)).toBe('Cable Chest Press 2 × — @ — lbs');
  });

  it('falls back to the live cascade weight, never to zero', () => {
    const html = renderRest(
      sessionModel({ weightLbs: 45, completedSets: [completed(45), completed(45)] }),
    );
    expect(headingText(html)).toBe('Cable Chest Press 2 × — @ 45 lbs');
  });
});

describe('deriveRecapPrescription — the cells behind that heading', () => {
  it('states the plan when one is attached', () => {
    expect(
      deriveRecapPrescription(sessionModel({ plannedSets: 2, plannedExercises: [planned()] }), 2),
    ).toEqual({ sets: 2, reps: '12–15', load: 45, unit: 'lbs' });
  });

  it('degrades reps and load to the em-dash with no plan and no cascade weight', () => {
    expect(deriveRecapPrescription(sessionModel({ weightLbs: null }), 2)).toEqual({
      sets: 2,
      reps: '—',
      load: '—',
      unit: 'lbs',
    });
  });

  it('shows the live cascade weight when only that is known', () => {
    expect(deriveRecapPrescription(sessionModel({ weightLbs: 45 }), 2).load).toBe(45);
  });

  it('keeps the sets cell on the prescribed total when the plan states one', () => {
    // titan's `SetsRepsLoadProps.sets` is `number` — only `reps`/`load` take a placeholder —
    // so this cell must always be a count the store actually knows.
    expect(deriveRecapPrescription(sessionModel({ plannedSets: 4, targetReps: 8 }), 1).sets).toBe(
      4,
    );
  });

  it('converts the load to the display unit', () => {
    expect(deriveRecapPrescription(sessionModel({ weightLbs: 100 }), 1, 'kg')).toEqual({
      sets: 1,
      reps: '—',
      load: 45,
      unit: 'kg',
    });
  });
});
