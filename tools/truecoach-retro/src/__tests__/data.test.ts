import { describe, expect, it } from 'vitest';

import { buildContext } from '../context.js';
import { buildRetroData, RETRO_DATA_KEYS } from '../data.js';
import { isoWeekStart } from '../dates.js';

import { mapEntry, syntheticLog } from './fixtures.js';

/** The synthetic log, optionally with two more exercises written out beside the main lift. */
function data(extraExercises = false) {
  const log = syntheticLog();
  const extra = ['Lift Two', 'Lift Three'].flatMap((name) =>
    log.rows.map((row) => ({ ...row, exercise_name: name, exercise_label: name })),
  );
  const rows = extraExercises ? [...log.rows, ...extra] : log.rows;
  const checkins = log.checkins;
  const json = JSON.stringify(
    buildRetroData(buildContext(rows, checkins, [mapEntry()], null), '2030-03-01'),
  );
  return JSON.parse(json) as Record<string, unknown>;
}

interface SegmentsJson {
  weeks: { week: string; label: string }[];
  sessions: { date: string; week: string; label: string }[];
  decisions: { present: boolean };
  comparisons: Record<string, { figure: string; all: string; regular: string }[]>;
}

describe('buildRetroData', () => {
  it('carries every top-level key the page builder reads, in order', () => {
    expect(Object.keys(data())).toEqual([...RETRO_DATA_KEYS]);
  });

  it('keeps per-session numbers unrounded with sets and total reps', () => {
    const lifts = data().lifts as {
      sessions: { e1rm: number; sets: number; totalReps: number }[];
    }[];
    expect(lifts[0]!.sessions).toHaveLength(12);
    expect(lifts[0]!.sessions[0]).toMatchObject({
      sets: 3,
      totalReps: 15,
      e1rm: 100 * (1 + 5 / 30),
    });
  });

  it('lists one block row per judged block with prescription and done counts', () => {
    const blocks = (data().misses as { blocks: Record<string, unknown>[] }).blocks;
    expect(blocks).toHaveLength(12);
    expect(blocks[0]).toMatchObject({
      prescribedSets: 3,
      prescribedReps: 5,
      doneSets: 3,
      minReps: 5,
      missed: false,
    });
  });

  it('labels every session with its week and says when no boundary decisions were read', () => {
    const segments = data().segments as SegmentsJson;
    const labelOf = new Map(segments.weeks.map((w) => [w.week, w.label]));
    expect(segments.sessions).toHaveLength(12);
    for (const session of segments.sessions) expect(session.label).toBe(labelOf.get(session.week));
    expect(segments.decisions.present).toBe(false);
    expect(Object.keys(segments.comparisons)).toEqual([
      'progression',
      'misses',
      'volume',
      'adherence',
    ]);
  });

  it('computes the regular-only checks over regular-week sessions alone', () => {
    const json = data(true);
    const regularWeeks = new Set(
      (json.segments as SegmentsJson).weeks.filter((w) => w.label === 'regular').map((w) => w.week),
    );
    const lifts = (json.regularOnly as { lifts: { sessions: { date: string }[] }[] }).lifts;
    const dates = lifts.flatMap((lift) => lift.sessions.map((s) => s.date));
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.length).toBeLessThan(12);
    for (const date of dates) expect(regularWeeks.has(isoWeekStart(date))).toBe(true);
  });
});
