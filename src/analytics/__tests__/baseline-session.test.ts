// The day-1 baseline session after a break (VW-982).

import { describe, expect, it } from 'vitest';

import { REDUCED_SCOPE_MINUTES } from '../../coach-copy/composer.js';
import {
  selectBaselineSession,
  type BaselineHistory,
  type BaselineSession,
  type BaselineTemplateExercise,
} from '../baseline-session.js';
import { RE_ENTRY_RULES } from '../re-entry.js';

const MEDIUM = RE_ENTRY_RULES.medium.value;
const SHORT = RE_ENTRY_RULES.short.value;
const LONG = RE_ENTRY_RULES.long.value;
const MINUTES = REDUCED_SCOPE_MINUTES.value;

const TEMPLATE: BaselineTemplateExercise[] = [
  { exerciseId: 'goblet-squat', targetRepsLow: 8, targetRepsHigh: 10, trainingIntent: 'strength' },
  { exerciseId: 'chest-press', targetRepsLow: 8, targetRepsHigh: 12 },
  { exerciseId: 'seated-row', targetRepsLow: 10, targetRepsHigh: 12 },
  { exerciseId: 'lateral-raise', targetRepsLow: 12, targetRepsHigh: 15 },
];

function history(entries: Record<string, number>): Map<string, BaselineHistory> {
  return new Map(Object.entries(entries).map(([id, topLoadLbs]) => [id, { topLoadLbs }]));
}

const FULL_HISTORY = history({
  'goblet-squat': 20,
  'chest-press': 120,
  'seated-row': 100,
  'lateral-raise': 30,
});

function workingRelativeLoads(session: BaselineSession): number[] {
  return session.sets.map((set) => set.relativeLoad);
}

describe('selectBaselineSession', () => {
  it('orders the sets so relative load never rises and the last set is the lightest', () => {
    const session = selectBaselineSession(TEMPLATE, FULL_HISTORY, MEDIUM, MINUTES)!;

    const loads = workingRelativeLoads(session);
    expect(loads).toEqual([...loads].sort((a, b) => b - a));
    expect(loads.at(-1)).toBeLessThan(Math.min(...loads.slice(0, -1)));
  });

  it('ends a medium-band session on a back-off set of the first lift at 80% of its load', () => {
    const session = selectBaselineSession(
      TEMPLATE,
      history({ 'chest-press': 120, 'seated-row': 90 }),
      MEDIUM,
      MINUTES,
    )!;

    expect(
      session.sets.map(({ exerciseId, role, loadLbs }) => [exerciseId, role, loadLbs]),
    ).toEqual([
      ['chest-press', 'working', 40],
      ['seated-row', 'working', 30],
      ['chest-press', 'back_off', 30],
    ]);
  });

  it('fits the reduced-scope minutes with default rests', () => {
    const session = selectBaselineSession(TEMPLATE, FULL_HISTORY, MEDIUM, MINUTES)!;

    expect(session.estimatedMinutes).toBeLessThanOrEqual(20);
    expect(session.minutes).toBe(20);
    expect(session.sets.at(-1)!.restSeconds).toBe(0);
    expect(session.sets[0].restSeconds).toBe(120);
  });

  it('drops a lift rather than run past a tight budget', () => {
    const session = selectBaselineSession(TEMPLATE, FULL_HISTORY, MEDIUM, 10)!;

    expect(new Set(session.sets.map((set) => set.exerciseId)).size).toBe(2);
    expect(session.estimatedMinutes).toBeLessThanOrEqual(10);
  });

  it('takes at most three lifts, and only lifts with history', () => {
    const session = selectBaselineSession(
      TEMPLATE,
      history({ 'chest-press': 120, 'lateral-raise': 30, 'leg-press': 300 }),
      MEDIUM,
      MINUTES,
    )!;
    const full = selectBaselineSession(TEMPLATE, FULL_HISTORY, MEDIUM, MINUTES)!;

    expect(new Set(session.sets.map((set) => set.exerciseId))).toEqual(
      new Set(['chest-press', 'lateral-raise']),
    );
    expect(new Set(full.sets.map((set) => set.exerciseId)).size).toBe(3);
  });

  it('gives every medium-band set the 20 to 30 rep range at one third of the last load', () => {
    const session = selectBaselineSession(TEMPLATE, FULL_HISTORY, MEDIUM, MINUTES)!;

    for (const set of session.sets) {
      expect(set).toMatchObject({ repsLow: 20, repsHigh: 30 });
    }
    const working = session.sets.filter((set) => set.role === 'working');
    expect(working.map((set) => set.loadLbs)).toEqual([40, 30, 5]);
  });

  it('keeps the plan rep target and the 0.8 load in the short band', () => {
    const session = selectBaselineSession(
      TEMPLATE,
      history({ 'chest-press': 120, 'seated-row': 100 }),
      SHORT,
      MINUTES,
    )!;

    expect(session.label).toBe('baseline session');
    expect(session.sets[0]).toMatchObject({
      exerciseId: 'seated-row',
      loadLbs: 80,
      repsLow: 10,
      repsHigh: 12,
    });
    expect(session.sets.at(-1)).toMatchObject({ exerciseId: 'seated-row', role: 'back_off' });
  });

  it('gives null when no template lift has history', () => {
    expect(selectBaselineSession(TEMPLATE, new Map(), MEDIUM, MINUTES)).toBeNull();
  });

  it('gives null after a long break, where no old load is scaled', () => {
    expect(selectBaselineSession(TEMPLATE, FULL_HISTORY, LONG, MINUTES)).toBeNull();
  });
});
