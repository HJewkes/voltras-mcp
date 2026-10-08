// The weekly check-in flow model (VW-846 S1): pure rules, so the only mocks are time and none else.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { mostRecentSundayIso } from '../../tools/profile-tools.js';
import { ActionRefusedError, IndeterminateWriteError } from '../spa/api-client.js';
import {
  checkWeight,
  createAttemptIds,
  createMeasuredAtPin,
  mostRecentLocalSunday,
  newFlowId,
  nextStep,
  stepAfterReview,
  stepErrorOf,
  toPounds,
  viewOfReview,
  type ReviewResult,
} from '../spa/checkin/checkin-model.js';

afterEach(() => {
  vi.useRealTimers();
});

const review = (over: Partial<ReviewResult>): ReviewResult => ({
  outcome: 'on_track',
  advisory: 'Eat a little more.',
  levers: ['add 100 kcal'],
  notes: [],
  proposal: { userResponse: null },
  ...over,
});

describe('weekOf pin', () => {
  // Tests run in UTC; local-time constructors keep the fixed dates unambiguous anyway.
  const instants = [
    new Date(2026, 9, 3, 23, 59, 59), // Saturday night
    new Date(2026, 9, 4, 0, 0, 0), // Sunday midnight
    new Date(2026, 9, 4, 12, 0, 0),
    new Date(2026, 9, 7, 9, 0, 0), // Wednesday
    new Date(2026, 0, 1, 8, 0, 0), // across a year boundary
  ];

  it.each(instants.map((d) => [d.toString(), d] as const))(
    'matches mostRecentSundayIso at %s',
    (_label, now) => {
      expect(mostRecentLocalSunday(now)).toBe(mostRecentSundayIso(now));
    },
  );

  it('keeps Saturday night in the old week and starts the new one at Sunday midnight', () => {
    expect(mostRecentLocalSunday(new Date(2026, 9, 3, 23, 59, 59))).toBe('2026-09-27');
    expect(mostRecentLocalSunday(new Date(2026, 9, 4, 0, 0, 0))).toBe('2026-10-04');
  });
});

describe('bodyweight', () => {
  it('converts kg to lb rounded to 0.1', () => {
    expect(toPounds(80, 'kg')).toBe(176.4);
    expect(toPounds(82.55, 'kg')).toBe(182);
  });

  it('leaves lb entries as they are, rounded to 0.1', () => {
    expect(toPounds(180.26, 'lbs')).toBe(180.3);
  });

  it('blocks a non-positive or non-finite weight', () => {
    expect(checkWeight(0, 'lbs')).toEqual({ kind: 'invalid' });
    expect(checkWeight(Number.NaN, 'kg')).toEqual({ kind: 'invalid' });
  });

  it('warns, without blocking, outside the typo range', () => {
    expect(checkWeight(18, 'lbs')).toEqual({ kind: 'ok', lbs: 18, warning: true });
    expect(checkWeight(180, 'lbs')).toEqual({ kind: 'ok', lbs: 180, warning: false });
  });

  it('pins measuredAt at the first submit and reuses it on retry', () => {
    vi.useFakeTimers();
    const pin = createMeasuredAtPin(() => new Date());
    vi.setSystemTime(new Date('2026-10-04T10:00:00.000Z'));
    const first = pin();
    vi.setSystemTime(new Date('2026-10-04T10:05:00.000Z'));
    expect(pin()).toBe(first);
  });
});

describe('review result to step', () => {
  it('shows a gap with the tool notes and goes to done', () => {
    const view = viewOfReview(
      review({ outcome: 'no_declared_diet_phase', notes: ['Declare a diet phase.'] }),
    );
    expect(view).toEqual({ kind: 'gap', notes: ['Declare a diet phase.'] });
    expect(stepAfterReview(view)).toBe('done');
  });

  it('treats a gap on the accepted-target outcome the same way', () => {
    expect(viewOfReview(review({ outcome: 'no_accepted_bodyweight_target' })).kind).toBe('gap');
  });

  it('shows no change when there is no proposal, and goes to done', () => {
    const view = viewOfReview(review({ proposal: null, advisory: null }));
    expect(view).toEqual({ kind: 'no_proposal' });
    expect(stepAfterReview(view)).toBe('done');
  });

  it('shows the standing answer when the proposal is answered, and goes to done', () => {
    const view = viewOfReview(review({ proposal: { userResponse: 'declined' } }));
    expect(view).toEqual({ kind: 'answered', userResponse: 'declined' });
    expect(stepAfterReview(view)).toBe('done');
  });

  it('stays on the review with the advisory and levers when the proposal is open', () => {
    const view = viewOfReview(review({}));
    expect(view).toEqual({
      kind: 'open',
      advisory: 'Eat a little more.',
      levers: ['add 100 kcal'],
    });
    expect(stepAfterReview(view)).toBe('weekly_review');
  });
});

describe('steps and flow id', () => {
  it('runs bodyweight, check-in, review, done', () => {
    expect(nextStep('bodyweight')).toBe('weekly_checkin');
    expect(nextStep('weekly_checkin')).toBe('weekly_review');
    expect(nextStep('weekly_review')).toBe('done');
    expect(nextStep('done')).toBe('done');
  });

  it('names the flow by week and a suffix', () => {
    expect(newFlowId('2026-10-04', 'ab12cd34')).toBe('checkin-2026-10-04-ab12cd34');
  });
});

describe('error to step state', () => {
  const refused = (code: string) =>
    new ActionRefusedError({ code, result: null, status: 400, actionId: 'a' });

  it('keeps the user on the step for invalid input', () => {
    expect(stepErrorOf(refused('invalid_input')).kind).toBe('invalid_input');
  });

  it('re-runs the review on NO_OPEN_ADVISORY and moves on at ADVISORY_ALREADY_ANSWERED', () => {
    expect(stepErrorOf(refused('NO_OPEN_ADVISORY'))).toEqual({ kind: 'rerun_review' });
    expect(stepErrorOf(refused('ADVISORY_ALREADY_ANSWERED'))).toEqual({ kind: 'already_answered' });
  });

  it('surfaces an unknown refusal code', () => {
    expect(stepErrorOf(refused('SOMETHING_ELSE'))).toEqual({
      kind: 'refused',
      code: 'SOMETHING_ELSE',
    });
  });

  it('separates an unconfirmed write from one that was not saved', () => {
    expect(stepErrorOf(new IndeterminateWriteError('?', 'a'))).toEqual({ kind: 'indeterminate' });
    expect(stepErrorOf(new TypeError('fetch failed'))).toEqual({ kind: 'not_saved' });
  });
});

describe('attempt ids', () => {
  const counter = () => {
    let n = 0;
    return () => `id-${++n}`;
  };

  it('reuses the id on a retry with unchanged input', () => {
    const ids = createAttemptIds(counter());
    const first = ids.idFor('bodyweight', { bodyweightLbs: 180 });
    expect(ids.idFor('bodyweight', { bodyweightLbs: 180 })).toBe(first);
  });

  it('mints a new id when the input is edited', () => {
    const ids = createAttemptIds(counter());
    const first = ids.idFor('bodyweight', { bodyweightLbs: 180 });
    expect(ids.idFor('bodyweight', { bodyweightLbs: 181 })).not.toBe(first);
  });

  it('keeps ids per step', () => {
    const ids = createAttemptIds(counter());
    const a = ids.idFor('weekly_review', { weekOf: 'w' });
    expect(ids.idFor('weekly_review_answer', { weekOf: 'w' })).not.toBe(a);
  });
});
