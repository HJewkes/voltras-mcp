// Unit tests for the flatline sim's light-lift candidate
// (scripts/lib/flatline-sim-core.mjs, VW-671) and its historical recall mode (VW-672).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectPlateau } from '@voltras/workout-analytics';
import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  STRATEGIES,
  WEEK_MS,
  loadRetro,
  parseRetro,
  readsFlat,
  recallLine,
  retroRecall,
} from '../../scripts/lib/flatline-sim-core.mjs';
import { plateauReferenceStepLbs } from '../analytics/stall-step.js';

const wobblingFlat = (weeks: number) =>
  Array.from({ length: weeks }, (_, week) => ({ t: week * WEEK_MS, v: 40 + (week % 2) }));

describe('light_min_35d', () => {
  it('holds a wobbling 28-day run on a light step that the shipped row calls flat', () => {
    const points = wobblingFlat(5);

    expect(readsFlat(points, 1, STRATEGIES.rolling_top_2wk_min_21d_settled_1)).toBe(true);
    expect(readsFlat(points, 1, STRATEGIES.light_min_35d)).toBe(false);
  });

  it('calls a wobbling run flat on a light step once it spans 35 days', () => {
    expect(readsFlat(wobblingFlat(6), 1, STRATEGIES.light_min_35d)).toBe(true);
  });

  it('reads like the shipped row when the step is 2 lb a week or more', () => {
    const points = wobblingFlat(5);

    expect(readsFlat(points, 2.5, STRATEGIES.light_min_35d)).toBe(
      readsFlat(points, 2.5, STRATEGIES.rolling_top_2wk_min_21d_settled_1),
    );
    expect(readsFlat(points, 2.5, STRATEGIES.light_min_35d)).toBe(true);
  });
});

// Synthetic retro data only: invented lifts, loads and dates, one session a week from a Monday.
const dayOf = (week: number) =>
  new Date(Date.parse('2031-03-03T00:00:00.000Z') + week * WEEK_MS).toISOString().slice(0, 10);
const weekly = (e1rms: number[]) =>
  e1rms.map((e1rm, week) => ({ date: dayOf(week), topLoad: e1rm * 0.8, e1rm, sets: 3 }));
const window = (from: number, to: number, rule: string) => ({
  start: dayOf(from),
  end: dayOf(to),
  sessions: to - from + 1,
  rule,
  outcome: 'log ends',
});

const flatLift = {
  lift: 'Synthetic Press A',
  family: 'press',
  sessions: weekly([100, 101, 100, 101, 100, 101, 100, 101]),
  plateaus: [window(2, 7, 'flatline')],
};
const climbingLift = {
  lift: 'Synthetic Squat B',
  family: 'squat',
  sessions: weekly([200, 210, 220, 230, 240, 250, 260, 270]),
  plateaus: [window(3, 6, 'flatline'), window(0, 2, 'wa_window')],
};
const retroData = { meta: { unit: 'lb' }, lifts: [flatLift, climbingLift] };

type RetroCase = { loadLbs: number; rampClass: string };
function referenceFires(points: { t: number; v: number }[], retroCase: RetroCase): boolean {
  const step = plateauReferenceStepLbs(retroCase.loadLbs);
  const series = points.map((p) => ({ ts: new Date(p.t).toISOString(), value: p.v }));
  const shipped = detectPlateau(series, { expectedRatePerWeek: step, minDays: 14 }).isPlateau;
  expect(readsFlat(points, step, STRATEGIES.rolling_top_2wk_min_21d_settled_1)).toBe(shipped);
  return shipped;
}

const scratch = mkdtempSync(join(tmpdir(), 'flatline-retro-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function malformedWith(mutate: (data: typeof retroData) => unknown): string {
  const data = structuredClone(retroData);
  const mutated = mutate(data);
  const text = typeof mutated === 'string' ? mutated : JSON.stringify(mutated ?? data);
  try {
    parseRetro(text);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('parseRetro accepted a malformed file');
}

describe('historical recall (--retro)', () => {
  it('counts the flatline windows the rule fires on, and prints nothing while it does', () => {
    const path = join(scratch, 'retro.json');
    writeFileSync(path, JSON.stringify(retroData));
    const log = vi.spyOn(console, 'log');
    const write = vi.spyOn(process.stdout, 'write');

    const recall = retroRecall(loadRetro(path), referenceFires);

    expect(recall).toEqual({ fired: 1, total: 2 });
    expect(log).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    log.mockRestore();
    write.mockRestore();
  });

  it('reports only the count line, with no lift, load or date in it', () => {
    const line = recallLine(
      retroRecall(parseRetro(JSON.stringify(retroData)), referenceFires),
      'reference',
    );

    expect(line).toBe('1 of 2 historical flatlines fire (--rule reference)');
    expect(line).not.toMatch(/Synthetic|press|squat|2031|100/);
  });

  it('maps squat and deadlift to the lower compound class and every other family to upper', () => {
    const classes = parseRetro(JSON.stringify(retroData)).map((c: RetroCase) => c.rampClass);

    expect(classes).toEqual(['upper_compound', 'lower_compound']);
  });

  it('fails with a clear error naming no path when the file is missing', () => {
    const missing = join(scratch, 'absent-retro.json');

    expect(() => loadRetro(missing)).toThrow('retro file: cannot read the --retro path (ENOENT)');
    expect(() => loadRetro(missing)).not.toThrow(/absent-retro/);
  });

  it.each([
    ['text that is not JSON', () => 'not json', /not valid JSON/],
    ['no lifts array', () => ({ lifts: {} }), /lifts must be an array/],
    [
      'a session day that is not a date',
      (d: typeof retroData) => {
        d.lifts[0]!.sessions[1]!.date = 'Tuesday';
      },
      /lifts\[0\]\.sessions\[1\]\.date/,
    ],
    [
      'sessions out of order',
      (d: typeof retroData) => {
        d.lifts[1]!.sessions.reverse();
      },
      /must come after/,
    ],
    [
      'an e1rm that is a string',
      (d: typeof retroData) => {
        (d.lifts[0]!.sessions[2] as { e1rm: unknown }).e1rm = '101';
      },
      /sessions\[2\]\.e1rm/,
    ],
    [
      'an unknown plateau rule',
      (d: typeof retroData) => {
        d.lifts[1]!.plateaus[1]!.rule = 'plateau';
      },
      /plateaus\[1\]\.rule/,
    ],
    [
      'a flatline window with no session inside it',
      (d: typeof retroData) => {
        d.lifts[0]!.plateaus[0] = window(20, 22, 'flatline');
      },
      /covers no valued session/,
    ],
    [
      'no flatline window at all',
      (d: typeof retroData) => {
        for (const lift of d.lifts) lift.plateaus = [];
      },
      /hold no flatline window/,
    ],
  ])('fails closed on %s, echoing no value', (_name, mutate, expected) => {
    const message = malformedWith(mutate as (data: typeof retroData) => unknown);

    expect(message).toMatch(expected);
    expect(message).not.toMatch(/Tuesday|'101'|plateau'|Synthetic/);
  });
});
