// The weekly check-in page (VW-896): each step renders at wall and phone width, the posting
// functions run against a fake `postAction`, and the advisory reaches the screen verbatim.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ActionRefusedError, IndeterminateWriteError } from '../spa/api-client.js';
import {
  answerReview,
  createFlowContext,
  enterReview,
  submitBodyweight,
  submitWeeklyCheckin,
  type FlowContext,
  type Post,
} from '../spa/checkin/CheckinPage.js';
import {
  BodyweightStep,
  CheckinStepper,
  DoneStep,
  NOT_SAVED_TITLE,
  WeeklyCheckinStep,
  WeeklyReviewStep,
  type BodyweightStepProps,
  type WeeklyReviewStepProps,
} from '../spa/checkin/CheckinSteps.js';
import type { ReviewResult } from '../spa/checkin/checkin-model.js';

const NOW = new Date('2026-07-08T12:00:00.000Z'); // Wednesday; the Sunday is 2026-07-05
const ADVISORY = 'Loss is running ahead of plan: add 150 kcal on training days (verbatim).';
const noop = (): void => {};

function ok<T>(result: T): ReturnType<Post> {
  return Promise.resolve({
    ok: true,
    action: 'x',
    actionId: 'a',
    replayed: false,
    result,
  }) as ReturnType<Post>;
}

function contextWith(post: Post): FlowContext {
  return createFlowContext(post, NOW, 'abc');
}

const OPEN_REVIEW: ReviewResult = {
  outcome: 'proposal',
  advisory: ADVISORY,
  levers: ['Raise calories', 'Add a refeed'],
  notes: [],
  proposal: { userResponse: null },
};

const bodyweightProps = (over: Partial<BodyweightStepProps> = {}): BodyweightStepProps => ({
  narrow: false,
  unit: 'lbs',
  value: '',
  note: '',
  busy: false,
  error: null,
  warning: false,
  onValue: noop,
  onNote: noop,
  onNext: noop,
  onSkip: noop,
  ...over,
});

const reviewProps = (over: Partial<WeeklyReviewStepProps> = {}): WeeklyReviewStepProps => ({
  narrow: false,
  view: { kind: 'open', advisory: ADVISORY, levers: ['Raise calories'] },
  busy: false,
  error: null,
  onRespond: noop,
  onRetry: noop,
  ...over,
});

describe.each([false, true])('the check-in screens (narrow=%s)', (narrow) => {
  it('renders the bodyweight step with its field, note and buttons', () => {
    const html = renderToStaticMarkup(
      createElement(BodyweightStep, bodyweightProps({ narrow, unit: 'kg' })),
    );
    expect(html).toContain('Bodyweight (kg)');
    expect(html).toContain('Note (optional)');
    expect(html).toContain('Skip');
    expect(html).toContain('Next');
  });

  it('renders the three questions with low, medium and high', () => {
    const html = renderToStaticMarkup(
      createElement(WeeklyCheckinStep, {
        narrow,
        answers: { hunger: 'high', dietPlanAdherence: null, sleepQuality: null },
        busy: false,
        error: null,
        onAnswer: noop,
        onNext: noop,
        onSkip: noop,
      }),
    );
    for (const text of [
      'Hunger this week',
      'Diet plan adherence',
      'Sleep',
      'Low',
      'Medium',
      'High',
    ]) {
      expect(html).toContain(text);
    }
  });

  it('shows the advisory verbatim with the three answer buttons', () => {
    const html = renderToStaticMarkup(createElement(WeeklyReviewStep, reviewProps({ narrow })));
    expect(html).toContain(ADVISORY);
    expect(html).toContain('Raise calories');
    for (const label of ['Accept', 'Decline', 'Not now']) expect(html).toContain(label);
  });

  it('shows the offline alert with a Retry when nothing answered', () => {
    const html = renderToStaticMarkup(
      createElement(BodyweightStep, bodyweightProps({ narrow, error: { kind: 'not_saved' } })),
    );
    expect(html).toContain(NOT_SAVED_TITLE);
    expect(html).toContain('Retry');
  });

  it('lists what was saved on Done and links to Goals', () => {
    const html = renderToStaticMarkup(
      createElement(DoneStep, { narrow, saved: ['Bodyweight', 'Weekly check-in'] }),
    );
    expect(html).toContain('Bodyweight');
    expect(html).toContain('href="#/goals"');
  });

  it('labels the stepper by layout', () => {
    const html = renderToStaticMarkup(
      createElement(CheckinStepper, { step: 'weekly_checkin', narrow }),
    );
    if (narrow) expect(html).toContain('Step 2 of 4');
    else expect(html).toContain('Review');
  });
});

describe('the review step without an advisory to answer', () => {
  it('offers no answer buttons when there is no proposal', () => {
    const html = renderToStaticMarkup(
      createElement(WeeklyReviewStep, reviewProps({ view: { kind: 'no_proposal', notes: [] } })),
    );
    expect(html).toContain('No change proposed this week');
    expect(html).not.toContain('Accept');
  });

  it('shows the tool notes for a gap', () => {
    const html = renderToStaticMarkup(
      createElement(
        WeeklyReviewStep,
        reviewProps({ view: { kind: 'gap', notes: ['Set a diet phase first.'] } }),
      ),
    );
    expect(html).toContain('Set a diet phase first.');
  });
});

describe('posting each step', () => {
  it('posts the bodyweight in pounds under one flow id, converting from kg at 0.1', async () => {
    const post = vi.fn((..._args: unknown[]) => ok({}));
    const ctx = contextWith(post as unknown as Post);
    const out = await submitBodyweight(ctx, { value: '80', note: ' fasted ', unit: 'kg' });

    expect(out.ok).toBe(true);
    const [name, input, meta] = post.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      Record<string, string>,
    ];
    expect(name).toBe('profile.log_bodyweight');
    expect(input).toMatchObject({ bodyweightLbs: 176.4, note: 'fasted' });
    expect(meta).toMatchObject({ flowId: 'checkin-2026-07-05-abc', flowStep: 'bodyweight' });
  });

  it('refuses a non-positive weight without posting', async () => {
    const post = vi.fn((..._args: unknown[]) => ok({}));
    const out = await submitBodyweight(contextWith(post as unknown as Post), {
      value: '0',
      note: '',
      unit: 'lbs',
    });
    expect(out).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    expect(post).not.toHaveBeenCalled();
  });

  it('reuses the action id and measuredAt on retry of unchanged input', async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementation(() => ok({}));
    const ctx = contextWith(post as unknown as Post);
    const entry = { value: '180', note: '', unit: 'lbs' as const };

    const first = await submitBodyweight(ctx, entry);
    const second = await submitBodyweight(ctx, entry);

    expect(first).toMatchObject({ ok: false, error: { kind: 'not_saved' } });
    expect(second.ok).toBe(true);
    const [a, b] = post.mock.calls as unknown as [
      string,
      Record<string, unknown>,
      { actionId: string },
    ][];
    expect(b[2].actionId).toBe(a[2].actionId);
    expect(b[1].measuredAt).toBe(a[1].measuredAt);
  });

  it('mints a new action id when the input is edited', async () => {
    const post = vi.fn((..._args: unknown[]) => ok({}));
    const ctx = contextWith(post as unknown as Post);
    await submitBodyweight(ctx, { value: '180', note: '', unit: 'lbs' });
    await submitBodyweight(ctx, { value: '181', note: '', unit: 'lbs' });
    const ids = (post.mock.calls as unknown as [string, unknown, { actionId: string }][]).map(
      (c) => c[2].actionId,
    );
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('posts a blank check-in for the pinned week so "asked, no answer" is recorded', async () => {
    const post = vi.fn((..._args: unknown[]) => ok({}));
    await submitWeeklyCheckin(contextWith(post as unknown as Post), {
      hunger: null,
      dietPlanAdherence: null,
      sleepQuality: null,
    });
    expect(post.mock.calls[0]?.[1]).toEqual({ weekOf: '2026-07-05' });
  });

  it('posts only the answered questions', async () => {
    const post = vi.fn((..._args: unknown[]) => ok({}));
    await submitWeeklyCheckin(contextWith(post as unknown as Post), {
      hunger: 'high',
      dietPlanAdherence: null,
      sleepQuality: 'low',
    });
    expect(post.mock.calls[0]?.[1]).toEqual({
      weekOf: '2026-07-05',
      hunger: 'high',
      sleepQuality: 'low',
    });
  });

  it('enters the review with the pinned week and returns the open advisory', async () => {
    const post = vi.fn((..._args: unknown[]) => ok(OPEN_REVIEW));
    const out = await enterReview(contextWith(post as unknown as Post));
    expect(post.mock.calls[0]?.[1]).toEqual({ weekOf: '2026-07-05' });
    expect(out).toMatchObject({ ok: true, value: { kind: 'open', advisory: ADVISORY } });
  });

  it('posts the chosen response with the same week', async () => {
    const post = vi.fn((..._args: unknown[]) => ok({}));
    await answerReview(contextWith(post as unknown as Post), 'declined');
    expect(post.mock.calls[0]?.[1]).toEqual({ weekOf: '2026-07-05', response: 'declined' });
  });

  it.each([
    [
      'a refusal of NO_OPEN_ADVISORY',
      new ActionRefusedError({
        code: 'NO_OPEN_ADVISORY',
        result: null,
        status: 400,
        actionId: 'a',
      }),
      'rerun_review',
    ],
    ['an indeterminate write', new IndeterminateWriteError('unsure', 'a'), 'indeterminate'],
  ])('maps %s to its step state', async (_name, err, kind) => {
    const post = vi.fn().mockRejectedValue(err);
    const out = await answerReview(contextWith(post as unknown as Post), 'accepted');
    expect(out).toMatchObject({ ok: false, error: { kind } });
  });
});
