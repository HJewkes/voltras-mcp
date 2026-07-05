/**
 * Capacity-band view mapper — verifies the `/api/capacity-band` point series maps
 * onto titan `CapacityBandChart`'s `band` + `workouts` props with EXACT values and
 * correct dot-status classification (within / above / below the corridor).
 */
import { describe, expect, it } from 'vitest';
import { toCapacityBandChartData, type CapacityBandPoint } from '../spa/panels/capacity-band-view';

const point = (over: Partial<CapacityBandPoint>): CapacityBandPoint => ({
  date: '2026-05-01T00:00:00.000Z',
  estimate: 100,
  bandLow: 95,
  bandHigh: 105,
  e1rm: 100,
  ...over,
});

describe('toCapacityBandChartData', () => {
  it('splits the series into band bounds and workout dots, exact values through', () => {
    const points = [
      point({ date: 'd1', bandLow: 95, bandHigh: 105, e1rm: 100 }),
      point({ date: 'd2', bandLow: 96.5, bandHigh: 103.5, e1rm: 101.25 }),
    ];
    const { band, workouts } = toCapacityBandChartData(points);
    expect(band).toEqual([
      { date: 'd1', bandLow: 95, bandHigh: 105 },
      { date: 'd2', bandLow: 96.5, bandHigh: 103.5 },
    ]);
    // Exact e1RM passes through as the dot load — no rounding at the mapper.
    expect(workouts[0]?.load).toBe(100);
    expect(workouts[1]?.load).toBe(101.25);
  });

  it('classifies a dot as within when e1RM is inside the corridor', () => {
    const { workouts } = toCapacityBandChartData([
      point({ e1rm: 100, bandLow: 95, bandHigh: 105 }),
    ]);
    expect(workouts[0]?.status).toBe('within');
  });

  it('classifies a dot as above when e1RM exceeds bandHigh', () => {
    const { workouts } = toCapacityBandChartData([
      point({ e1rm: 110, bandLow: 95, bandHigh: 105 }),
    ]);
    expect(workouts[0]?.status).toBe('above');
  });

  it('classifies a dot as below when e1RM is under bandLow', () => {
    const { workouts } = toCapacityBandChartData([point({ e1rm: 90, bandLow: 95, bandHigh: 105 })]);
    expect(workouts[0]?.status).toBe('below');
  });

  it('treats the band edges as within (inclusive bounds)', () => {
    const low = toCapacityBandChartData([point({ e1rm: 95, bandLow: 95, bandHigh: 105 })]);
    const high = toCapacityBandChartData([point({ e1rm: 105, bandLow: 95, bandHigh: 105 })]);
    expect(low.workouts[0]?.status).toBe('within');
    expect(high.workouts[0]?.status).toBe('within');
  });

  it('maps an empty series to empty props (panel hides)', () => {
    expect(toCapacityBandChartData([])).toEqual({ band: [], workouts: [] });
  });

  it('truncates full ISO timestamps to titan calendar strings (YYYY-MM-DD)', () => {
    const { band, workouts } = toCapacityBandChartData([
      point({ date: '2026-04-06T00:00:00.000Z' }),
    ]);
    // titan splits `date` on "-" expecting YYYY-MM-DD; a full timestamp NaN-collapses
    // its axis, so the mapper must hand it the date component only.
    expect(band[0]?.date).toBe('2026-04-06');
    expect(workouts[0]?.date).toBe('2026-04-06');
  });
});
