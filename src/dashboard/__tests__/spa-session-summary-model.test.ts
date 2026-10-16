// The session-completion page's derivation layer (VW-937), over the synthetic
// design fixtures in `fixtures/session-summary/`.

import { describe, expect, it } from 'vitest';

import {
  absentReason,
  bestE1rmIndex,
  disagreement,
  displayDelta,
  e1rmBySet,
  fatigueFact,
  headerTotals,
  nextLoad,
  nextTimeChip,
  repMarks,
  repScheme,
  serverProse,
  setKind,
  strengthFact,
  usualRange,
  verdictKicker,
} from '../spa/planner/session-summary-model.js';
import type { SessionSummaryExercise } from '../read-models/session-summary-view.js';
import { loadSummary, summaryExercise } from './fixtures/session-summary/load.js';

const chestFly = (): SessionSummaryExercise => summaryExercise('1-current', 'Cable Chest Fly');
const fullSession = (name: string): SessionSummaryExercise =>
  summaryExercise('2-full-session', name);
const edges = (name: string): SessionSummaryExercise => summaryExercise('3-edges', name);
const formBreakdown = (name: string): SessionSummaryExercise =>
  summaryExercise('4-form-breakdown', name);

function withRepCounts(exercise: SessionSummaryExercise, counts: number[]): SessionSummaryExercise {
  return { ...exercise, sets: exercise.sets.map((set, i) => ({ ...set, repCount: counts[i] })) };
}

describe('next load', () => {
  it('moves from the top working load, not from the planned load', () => {
    const exercise = chestFly();

    expect(exercise.progression?.targetWeightLbs).toBe(140);
    expect(nextLoad(exercise)).toBe(135);
  });

  it('adds the delta to the top working load', () => {
    expect(nextLoad(fullSession('Seated Cable Row'))).toBe(105);
  });

  it('has no load to move from without a progression', () => {
    expect(nextLoad(fullSession('Face Pull'))).toBeNull();
  });
});

describe('display delta', () => {
  it('is the difference of the two displayed kg numbers, so 140 to 135 lb reads -3 kg', () => {
    expect(displayDelta(chestFly(), 'kg')).toBe(-3);
  });

  it('is the raw delta in lb', () => {
    expect(displayDelta(chestFly(), 'lbs')).toBe(-5);
  });

  it('is zero for a hold', () => {
    expect(displayDelta(fullSession('Cable Romanian Deadlift'), 'kg')).toBe(0);
  });

  it('is null with no progression', () => {
    expect(displayDelta(fullSession('Face Pull'), 'kg')).toBeNull();
  });
});

describe('rep marks', () => {
  it('marks every working set short of the band as under', () => {
    expect(repMarks(chestFly())).toEqual([
      { index: 1, repCount: 5, mark: 'under' },
      { index: 2, repCount: 5, mark: 'under' },
    ]);
  });

  it('skips warm-ups and marks the top of the band as over', () => {
    expect(repMarks(fullSession('Cable Romanian Deadlift')).map((m) => m.mark)).toEqual([
      'over',
      'in',
      'in',
    ]);
  });

  it('scores band sets when no set of the exercise recorded a load', () => {
    expect(repMarks(formBreakdown('Band Pull-Apart'))).toEqual([
      { index: 5, repCount: 15, mark: 'over' },
      { index: 6, repCount: 13, mark: 'in' },
    ]);
  });

  it('drops a band set beside a loaded one, as the server tally does', () => {
    expect(repMarks(edges('Cable Biceps Curl'))).toEqual([
      { index: 3, repCount: 12, mark: 'over' },
    ]);
  });

  it('is empty when nothing is prescribed', () => {
    expect(repMarks(fullSession('Face Pull'))).toEqual([]);
  });
});

describe('disagreement', () => {
  it('blames missed reps when the bar moved well and most sets fell short', () => {
    expect(disagreement(chestFly())).toBe('moved-well-missed-reps');
  });

  it('stays quiet when a slow bar and a back-off agree', () => {
    expect(disagreement(fullSession('Standing Cable Chest Press'))).toBeNull();
  });

  it('does not blame the reps when the back-off came while they were in band', () => {
    expect(disagreement(withRepCounts(chestFly(), [12, 13]))).toBe('moved-well-plan-backs-off');
  });

  it('does not blame the reps on a tie, which is no majority', () => {
    expect(disagreement(withRepCounts(chestFly(), [5, 12]))).toBe('moved-well-plan-backs-off');
  });

  it('names a load step taken while form broke down', () => {
    expect(disagreement(formBreakdown('Cable Lat Pulldown'))).toBe('struggled-plan-adds');
  });

  it('stays quiet when the verdict and the recommendation agree', () => {
    expect(disagreement(fullSession('Seated Cable Row'))).toBeNull();
    expect(disagreement(fullSession('Cable Romanian Deadlift'))).toBeNull();
  });

  it('stays quiet without a verdict or a progression', () => {
    expect(disagreement(edges('Cable Biceps Curl'))).toBeNull();
    expect(disagreement(fullSession('Face Pull'))).toBeNull();
  });
});

describe('e1RM per set', () => {
  it('estimates working sets only, leaving warm-ups null', () => {
    const bySet = e1rmBySet(fullSession('Cable Romanian Deadlift'));

    expect(bySet.map((s) => s.index)).toEqual([1, 2, 3, 4, 5]);
    expect(bySet.slice(0, 2).map((s) => s.e1rm)).toEqual([null, null]);
    expect(bySet.slice(2).every((s) => s.e1rm !== null && s.e1rm > 120)).toBe(true);
  });

  it('marks the session-best set', () => {
    expect(bestE1rmIndex(fullSession('Cable Romanian Deadlift'))).toBe(3);
  });

  it('marks the first of tied sets', () => {
    expect(bestE1rmIndex(chestFly())).toBe(1);
  });

  it('has no best without two loaded working sets', () => {
    expect(bestE1rmIndex(fullSession('Face Pull'))).toBeNull();
    expect(bestE1rmIndex(edges('Cable Biceps Curl'))).toBeNull();
  });
});

describe('header totals', () => {
  it('counts the unloaded sets the volume leaves out', () => {
    const totals = headerTotals(loadSummary('2-full-session'));

    expect(totals.unloadedSetCount).toBe(2);
    expect(totals.unloadedLabel).toBe('excl. 2 unloaded sets');
    expect(totals.exerciseCount).toBe(4);
  });

  it('says one unloaded set in the singular', () => {
    expect(headerTotals(loadSummary('3-edges')).unloadedLabel).toBe('excl. 1 unloaded set');
  });

  it('has no note when every set had a load', () => {
    expect(headerTotals(loadSummary('1-current')).unloadedLabel).toBeNull();
  });
});

describe('usual range', () => {
  it('reads the heaviest working set that has one', () => {
    expect(usualRange(fullSession('Cable Romanian Deadlift'))).toMatchObject({
      expectedLow: 9,
      expectedHigh: 13,
      n: 7,
    });
  });

  it('is null without the history a range needs', () => {
    expect(usualRange(fullSession('Seated Cable Row'))).toBeNull();
  });
});

describe('verdict kicker', () => {
  it('names the set the verdict read and its loss, with no space before %', () => {
    expect(verdictKicker(fullSession('Cable Romanian Deadlift'))).toBe('WORST SET #5 · VL23%');
  });

  it('is null without a verdict', () => {
    expect(verdictKicker(edges('Cable Biceps Curl'))).toBeNull();
  });
});

describe('absent reason', () => {
  it('is null when there is a verdict', () => {
    expect(absentReason(edges('Unattributed'))).toBeNull();
  });

  it('says not scored when no set was a working set', () => {
    expect(absentReason(edges('Cable Lateral Raise'))).toBe('not-scored');
  });

  it('says no bar-speed data when no working set recorded velocity', () => {
    expect(absentReason(edges('Cable Biceps Curl'))).toBe('no-bar-speed');
  });

  it('falls back to no verdict when working sets carried velocity', () => {
    const exercise = { ...fullSession('Seated Cable Row'), verdict: null };

    expect(absentReason(exercise)).toBe('no-verdict');
  });
});

describe('rep scheme', () => {
  it('writes sets and rep band with no space around the times sign', () => {
    expect(repScheme(fullSession('Cable Romanian Deadlift'))).toBe('3×10–12');
  });

  it('is null with nothing prescribed', () => {
    expect(repScheme(fullSession('Face Pull'))).toBeNull();
  });
});

describe('next-time chip', () => {
  it('words each step from the sign of the delta', () => {
    expect(nextTimeChip(fullSession('Seated Cable Row'), 'lbs')).toBe('Add 5 lb');
    expect(nextTimeChip(fullSession('Cable Romanian Deadlift'), 'lbs')).toBe('Hold');
    expect(nextTimeChip(fullSession('Standing Cable Chest Press'), 'lbs')).toBe('Back off 5 lb');
  });

  it('sizes a kg step from the two displayed loads, not the converted delta', () => {
    // 140 to 135 lb shows as 64 to 61 kg; converting the raw 5 lb would say 2 kg.
    expect(nextTimeChip(chestFly(), 'kg')).toBe('Back off 3 kg');
  });

  it('is null with no recommendation', () => {
    expect(nextTimeChip(fullSession('Face Pull'), 'lbs')).toBeNull();
  });
});

describe('server prose', () => {
  it('passes through unchanged in lb', () => {
    expect(serverProse('add 5 lb.', 'lbs')).toBe('add 5 lb.');
  });

  it('is tagged in kg so its lb numbers never read as kg', () => {
    expect(serverProse('add 5 lb.', 'kg')).toBe('add 5 lb. (in lb)');
  });
});

describe('session facts', () => {
  it('reads velocity loss from the first working set to the last', () => {
    expect(fatigueFact(fullSession('Cable Romanian Deadlift'))).toBe('VL 14%→23%');
  });

  it('has no fatigue fact without two readings', () => {
    expect(fatigueFact(edges('Cable Biceps Curl'))).toBeNull();
  });

  it('reads e1RM first to last with a true minus sign', () => {
    expect(strengthFact(fullSession('Cable Romanian Deadlift'), 'lbs')).toBe(
      'e1RM 168→160 · \u22125%',
    );
  });

  it('converts e1RM to the display unit', () => {
    expect(strengthFact(fullSession('Cable Romanian Deadlift'), 'kg')).toBe(
      'e1RM 76→73 · \u22125%',
    );
  });
});

describe('set kind', () => {
  it('names a scored set working and a flagged warm-up a warm-up', () => {
    const [warmup, , working] = fullSession('Cable Romanian Deadlift').sets;

    expect(setKind(working!, true)).toBe('working');
    expect(setKind(warmup!, false)).toBe('warm-up');
  });

  it('names a working set the scoring dropped as not scored', () => {
    const band = edges('Cable Biceps Curl').sets[1]!;

    expect(setKind(band, false)).toBe('not scored');
  });

  it('names a technique set by its purpose', () => {
    expect(setKind(edges('Cable Lateral Raise').sets[0]!, false)).toBe('technique');
  });
});
