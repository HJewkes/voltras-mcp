// What `npm run dashboard:preview -- summary` shows (VW-943).
//
// The seed writes sets only; the verdicts and deltas on the page are derived at
// read time. So the seed runs into a real store and its session goes through the
// same `buildSessionSummary` the page's route calls, and the mix the preview
// exists to show is asserted on what comes out.

import { describe, expect, it } from 'vitest';

import {
  SUMMARY_PREVIEW_EXERCISES,
  SUMMARY_PREVIEW_SESSION_ID,
  seedSummaryPreview,
} from '../../docs/summary-preview-seed.js';
import { PREVIEW_PAGES } from '../../docs/preview-seeds.js';
import { buildSessionSummary, type SessionSummaryView } from '../read-models/session-summary.js';
import { openTestStore } from '../../store/__tests__/open-test-store.js';

const nameOf = (id: string): string | undefined =>
  SUMMARY_PREVIEW_EXERCISES.find((lift) => lift.exercise.id === id)?.exercise.name;

async function seededSummary(): Promise<SessionSummaryView> {
  const store = openTestStore();
  try {
    const { sessionId } = await seedSummaryPreview(store, new Date());
    const summary = await buildSessionSummary({ store, nameOf }, sessionId);
    if (summary === undefined) throw new Error('the seeded session did not resolve');
    return summary;
  } finally {
    store.close();
  }
}

describe('summary preview seed', () => {
  it('ends a session holding all four exercises, in the order they were lifted', async () => {
    const summary = await seededSummary();

    expect(summary.session.endedAt).not.toBeNull();
    expect(summary.exercises.map((e) => e.name)).toEqual([
      'Cable Romanian Deadlift',
      'Cable Row',
      'Cable Chest Press',
      'Cable Face Pull',
    ]);
  });

  it('derives a different verdict and an add, a hold and a back-off', async () => {
    const summary = await seededSummary();

    expect(summary.exercises.map((e) => e.verdict?.state)).toEqual([
      'slowing',
      'good',
      'grinding',
      'good',
    ]);
    expect(summary.exercises.map((e) => e.progression?.delta ?? null)).toEqual([0, 5, -5, null]);
  });

  it('keeps warm-ups out of the working count on every loaded lift', async () => {
    const summary = await seededSummary();

    expect(summary.exercises.map((e) => [e.setCount, e.workingSetCount])).toEqual([
      [5, 3],
      [4, 3],
      [4, 3],
      [2, 2],
    ]);
  });

  it('shows the damper lift with no load and outside the program', async () => {
    const facePull = (await seededSummary()).exercises[3]!;

    expect(facePull.topWeightLbs).toBeNull();
    expect(facePull.sets.map((s) => s.loadLabel)).toEqual(['damper 5', 'damper 5']);
    expect(facePull.progressionNote).toMatch(/Not in your current program/);
  });

  it('routes the summary page to the seeded session', () => {
    const page = PREVIEW_PAGES.find((p) => p.name === 'summary');

    expect(page?.route).toBe(`/app#/summary/${SUMMARY_PREVIEW_SESSION_ID}`);
  });
});
