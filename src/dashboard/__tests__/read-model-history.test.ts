/**
 * Exercise-history read-models (VMCP-03.03). The pure derivations extracted from
 * server.ts: e1RM series, strength trend (running-max PR flags), Kalman capacity
 * band, and PR detection. Driven directly over plain `HistorySession[]` — no store
 * or HTTP.
 */
import { describe, expect, it } from 'vitest';

import {
  buildE1rmSeries,
  buildExerciseTrend,
  buildCapacityBand,
  buildPrHistory,
  fmtPrDate,
  MIN_CAPACITY_BAND_SESSIONS,
  type HistorySession,
} from '../read-models/exercise-history';
import type { Rep } from '@voltras/workout-analytics';

function rep(peakMms = 0): Rep {
  return { repNumber: 1, concentric: { peakVelocity: peakMms }, eccentric: {} } as unknown as Rep;
}

/** A session with `sets`, each described by its load, rep count, and (optional) peak velocity. */
function session(
  startedAt: string,
  sets: Array<{ weightLbs: number; reps: number; peak?: number }>,
): HistorySession {
  return {
    startedAt,
    sets: sets.map((s) => ({
      weightLbs: s.weightLbs,
      reps: Array.from({ length: s.reps }, () => rep(s.peak ?? 0)),
    })),
  };
}

describe('buildE1rmSeries', () => {
  it('emits one observation per scorable session, taking the best set', () => {
    const series = buildE1rmSeries([
      session('2026-01-01', [
        { weightLbs: 100, reps: 1 },
        { weightLbs: 140, reps: 1 }, // heavier set wins this session
      ]),
      session('2026-01-08', [{ weightLbs: 120, reps: 1 }]),
    ]);
    expect(series).toHaveLength(2);
    expect(series[0]!.date).toBe('2026-01-01');
    expect(series[1]!.date).toBe('2026-01-08');
    // the 140-lb set beat the 100-lb set in session 1
    expect(series[0]!.e1rm).toBeGreaterThan(series[1]!.e1rm);
  });

  it('skips sessions with no scorable set (empty or zero-rep)', () => {
    const series = buildE1rmSeries([
      session('2026-01-01', [{ weightLbs: 100, reps: 0 }]),
      session('2026-01-08', []),
      session('2026-01-15', [{ weightLbs: 100, reps: 3 }]),
    ]);
    expect(series).toHaveLength(1);
    expect(series[0]!.date).toBe('2026-01-15');
  });
});

describe('buildExerciseTrend', () => {
  it('rounds e1RM and flags PRs with a running max', () => {
    // weight-driven e1RM ordering: up, up, down → PR, PR, not-PR
    const points = buildExerciseTrend(
      buildE1rmSeries([
        session('d1', [{ weightLbs: 100, reps: 1 }]),
        session('d2', [{ weightLbs: 130, reps: 1 }]),
        session('d3', [{ weightLbs: 90, reps: 1 }]),
      ]),
    );
    expect(points.map((p) => p.isPR)).toEqual([true, true, false]);
    expect(points.every((p) => Number.isInteger(p.e1rm))).toBe(true);
  });

  it('is empty for an empty series', () => {
    expect(buildExerciseTrend([])).toEqual([]);
  });
});

describe('buildCapacityBand', () => {
  it(`returns none below the ${MIN_CAPACITY_BAND_SESSIONS}-session gate`, () => {
    const series = buildE1rmSeries([
      session('d1', [{ weightLbs: 100, reps: 1 }]),
      session('d2', [{ weightLbs: 110, reps: 1 }]),
    ]);
    expect(buildCapacityBand(series)).toEqual([]);
  });

  it('produces a corridor bracketing the estimate once enough history exists', () => {
    const series = buildE1rmSeries([
      session('d1', [{ weightLbs: 100, reps: 1 }]),
      session('d2', [{ weightLbs: 110, reps: 1 }]),
      session('d3', [{ weightLbs: 120, reps: 1 }]),
    ]);
    const band = buildCapacityBand(series);
    expect(band).toHaveLength(3);
    for (const p of band) {
      expect(p.bandLow).toBeLessThanOrEqual(p.estimate);
      expect(p.bandHigh).toBeGreaterThanOrEqual(p.estimate);
      expect(p.e1rm).toBeGreaterThan(0);
    }
  });
});

describe('buildPrHistory', () => {
  it('picks the best e1RM / weight / reps / velocity, each with its own date', () => {
    const records = buildPrHistory([
      session('2026-01-15T00:00:00.000Z', [{ weightLbs: 100, reps: 5, peak: 800 }]), // reps + velocity PRs
      session('2026-02-20T00:00:00.000Z', [{ weightLbs: 200, reps: 1, peak: 500 }]), // weight + e1RM PRs
    ]);
    const byType = Object.fromEntries(records.map((r) => [r.type, r]));

    expect(byType.weight).toMatchObject({ value: 200, unit: 'lbs', date: 'Feb 20' });
    expect(byType.reps).toMatchObject({ value: 5, date: 'Jan 15' });
    expect(byType.velocity).toMatchObject({ value: 0.8, date: 'Jan 15' });
    expect(byType.e1rm).toMatchObject({ unit: 'lbs', date: 'Feb 20' }); // 200×1 beats 100×5
    expect(byType.e1rm!.value).toBeGreaterThan(0);
  });

  it('omits categories that never scored', () => {
    expect(buildPrHistory([])).toEqual([]);
    const noVelocity = buildPrHistory([session('2026-01-01', [{ weightLbs: 100, reps: 2 }])]);
    expect(noVelocity.some((r) => r.type === 'velocity')).toBe(false);
  });
});

describe('fmtPrDate', () => {
  it('formats an ISO timestamp as "MMM D" (UTC)', () => {
    expect(fmtPrDate('2026-07-04T12:00:00.000Z')).toBe('Jul 4');
  });
  it('falls back to the raw string when unparseable', () => {
    expect(fmtPrDate('not-a-date')).toBe('not-a-date');
  });
});
