import { describe, expect, it } from 'vitest';

import { underperformanceRuns, type MuscleVerdict } from '../underperformance.js';

const v = (date: string, verdict: MuscleVerdict['verdict'], muscle = 'chest'): MuscleVerdict => ({
  muscle,
  date,
  verdict,
});

describe('underperformanceRuns', () => {
  it('flags two consecutive missed sessions on one muscle', () => {
    const runs = underperformanceRuns([v('2030-01-07', 'miss'), v('2030-01-10', 'miss')]);
    expect(runs).toEqual([
      {
        muscle: 'chest',
        startDate: '2030-01-07',
        endDate: '2030-01-10',
        sessions: 2,
        dates: ['2030-01-07', '2030-01-10'],
      },
    ]);
  });

  it('does not flag a single miss', () => {
    expect(underperformanceRuns([v('2030-01-07', 'miss'), v('2030-01-10', 'hit')])).toEqual([]);
  });

  it('breaks a run at a session that hit', () => {
    const verdicts = [v('2030-01-07', 'miss'), v('2030-01-10', 'hit'), v('2030-01-14', 'miss')];
    expect(underperformanceRuns(verdicts)).toEqual([]);
  });

  it('counts a session as missed when any block on the muscle missed', () => {
    const verdicts = [v('2030-01-07', 'hit'), v('2030-01-07', 'miss'), v('2030-01-10', 'miss')];
    expect(underperformanceRuns(verdicts)).toHaveLength(1);
  });

  it('skips sessions with no target rather than breaking the run', () => {
    const verdicts = [
      v('2030-01-07', 'miss'),
      v('2030-01-09', 'no-target'),
      v('2030-01-10', 'miss'),
    ];
    expect(underperformanceRuns(verdicts)[0]?.sessions).toBe(2);
  });

  it('keeps muscles apart', () => {
    const verdicts = [v('2030-01-07', 'miss', 'chest'), v('2030-01-10', 'miss', 'quads')];
    expect(underperformanceRuns(verdicts)).toEqual([]);
  });
});
