/**
 * Meso-overview derivation + view mapper. Covers the pure block-relative week
 * math (`deriveMesoWeekViews`) — volume normalization, deload/current flags,
 * workout-status tagging — and the titan `WeekRow` prop mapping.
 */
import { describe, expect, it } from 'vitest';
import { deriveMesoWeekViews, type RawMesoWeek } from '../read-models/meso-overview';
import { toWeekRowPropsList, type MesoOverviewView } from '../spa/panels/meso-overview-view';

const week = (over: Partial<RawMesoWeek> & { orderIndex: number }): RawMesoWeek => ({
  volume: 0,
  templates: [],
  ...over,
});

describe('deriveMesoWeekViews', () => {
  it('normalizes each week volume to the block peak for the intensity bar', () => {
    const views = deriveMesoWeekViews([
      week({ orderIndex: 0, volume: 10, templates: [{ name: 'A', done: false }] }),
      week({ orderIndex: 1, volume: 20, templates: [{ name: 'B', done: false }] }),
      week({ orderIndex: 2, volume: 15, templates: [{ name: 'C', done: false }] }),
    ]);
    expect(views.map((w) => w.intensityLevel)).toEqual([0.5, 1, 0.75]);
  });

  it('avoids divide-by-zero when the block has no planned volume', () => {
    const views = deriveMesoWeekViews([
      week({ orderIndex: 0, volume: 0, templates: [{ name: 'A', done: false }] }),
    ]);
    expect(views[0]?.intensityLevel).toBe(0);
  });

  it('flags deload weeks by name (case-insensitive), not others', () => {
    const views = deriveMesoWeekViews([
      week({ orderIndex: 0, name: 'Week 1', volume: 10, templates: [{ name: 'A', done: false }] }),
      week({ orderIndex: 1, name: 'DELOAD', volume: 5, templates: [{ name: 'B', done: false }] }),
    ]);
    expect(views[0]?.isDeload).toBe(false);
    expect(views[1]?.isDeload).toBe(true);
  });

  it('marks the first week with unfinished work current and tags the next workout', () => {
    const views = deriveMesoWeekViews([
      week({
        orderIndex: 0,
        volume: 10,
        templates: [
          { name: 'A', done: true },
          { name: 'B', done: true },
        ],
      }),
      week({
        orderIndex: 1,
        volume: 10,
        templates: [
          { name: 'C', done: false },
          { name: 'D', done: false },
        ],
      }),
      week({ orderIndex: 2, volume: 10, templates: [{ name: 'E', done: false }] }),
    ]);
    expect(views.map((w) => w.isCurrent)).toEqual([false, true, false]);
    // Week 0 both done; week 1 first-unfinished is the live 'current', rest upcoming.
    expect(views[0]?.workouts.map((w) => w.status)).toEqual(['completed', 'completed']);
    expect(views[1]?.workouts.map((w) => w.status)).toEqual(['current', 'upcoming']);
    expect(views[2]?.workouts.map((w) => w.status)).toEqual(['upcoming']);
  });

  it('marks no week current and all workouts completed when the block is finished', () => {
    const views = deriveMesoWeekViews([
      week({ orderIndex: 0, volume: 10, templates: [{ name: 'A', done: true }] }),
      week({ orderIndex: 1, volume: 10, templates: [{ name: 'B', done: true }] }),
    ]);
    expect(views.every((w) => !w.isCurrent)).toBe(true);
    expect(views.flatMap((w) => w.workouts.map((x) => x.status))).toEqual([
      'completed',
      'completed',
    ]);
  });

  it('sorts weeks by orderIndex regardless of input order', () => {
    const views = deriveMesoWeekViews([
      week({ orderIndex: 2, volume: 5, templates: [{ name: 'C', done: false }] }),
      week({ orderIndex: 0, volume: 5, templates: [{ name: 'A', done: false }] }),
      week({ orderIndex: 1, volume: 5, templates: [{ name: 'B', done: false }] }),
    ]);
    expect(views.map((w) => w.weekNumber)).toEqual([1, 2, 3]);
  });
});

describe('toWeekRowPropsList', () => {
  const meso: MesoOverviewView = {
    mesoName: 'Hypertrophy Block',
    focus: 'hypertrophy',
    totalWeeks: 4,
    weeks: [
      {
        weekNumber: 2,
        isCurrent: true,
        isDeload: false,
        intensityLevel: 0.75,
        workouts: [{ name: 'Upper', status: 'current' }],
      },
    ],
  };

  it('threads block totalWeeks onto each row and passes values through', () => {
    const rows = toWeekRowPropsList(meso);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      weekNumber: 2,
      totalWeeks: 4,
      intensityLevel: 0.75,
      isCurrent: true,
      isDeload: false,
      workouts: [{ name: 'Upper', status: 'current' }],
    });
  });

  it('maps an empty meso to no rows (panel hides)', () => {
    expect(toWeekRowPropsList({ ...meso, weeks: [] })).toEqual([]);
  });
});
