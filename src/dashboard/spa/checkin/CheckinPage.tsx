/**
 * `#/checkin` (VW-896): the weekly check-in as a four-step stepper. Every write is a browser
 * POST to an allowlisted action; nothing here calls the coach or a model.
 *
 * The posting logic is plain async functions over an injected `post`, so a test drives each step
 * with a fake and no DOM. The component only holds state and wires those functions to the views.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useStore } from 'zustand';
import { Surface } from '@titan-design/react-ui';

import { ActionRefusedError, postAction, type ActionResponse } from '../api-client.js';
import { dashboardStore } from '../store';
import { useIsNarrowViewport } from '../use-viewport';
import { PAGE_PADDING } from '../planner/PlanBuilderPage';
import { createMutationLatch } from '../planner/mutation-latch';
import type { MassUnit } from '../live-page/mass.js';
import {
  checkWeight,
  createAttemptIds,
  createMeasuredAtPin,
  mostRecentLocalSunday,
  newFlowId,
  nextStep,
  stepAfterReview,
  stepErrorOf,
  viewOfReview,
  type AttemptIds,
  type CheckinFlowStep,
  type CheckinStep,
  type ReviewResult,
  type ReviewView,
  type StepError,
} from './checkin-model.js';
import {
  BodyweightStep,
  CheckinStepper,
  DoneStep,
  WeeklyCheckinStep,
  WeeklyReviewStep,
  type CheckinAnswers,
  type ReviewResponse,
} from './CheckinSteps.js';

export type Post = <T>(
  name: string,
  input: unknown,
  meta?: { actionId?: string; flowId?: string; flowStep?: string },
) => Promise<ActionResponse<T>>;

/** What one run holds fixed: the pinned week, the shared flow id and the id/instant pins. */
export interface FlowContext {
  post: Post;
  weekOf: string;
  flowId: string;
  ids: AttemptIds;
  measuredAt: () => string;
}

export type StepOutcome<T = undefined> = { ok: true; value: T } | { ok: false; error: StepError };

export function createFlowContext(post: Post, now: Date, suffix: string): FlowContext {
  const weekOf = mostRecentLocalSunday(now);
  return {
    post,
    weekOf,
    flowId: newFlowId(weekOf, suffix),
    ids: createAttemptIds(
      () => `${newFlowId(weekOf, suffix)}-${Math.random().toString(36).slice(2)}`,
    ),
    measuredAt: createMeasuredAtPin(() => new Date()),
  };
}

async function send<T>(
  ctx: FlowContext,
  flowStep: CheckinFlowStep,
  tool: string,
  input: Record<string, unknown>,
): Promise<StepOutcome<T>> {
  try {
    const res = await ctx.post<T>(tool, input, {
      actionId: ctx.ids.idFor(flowStep, input),
      flowId: ctx.flowId,
      flowStep,
    });
    ctx.ids.forget(flowStep);
    return { ok: true, value: res.result };
  } catch (err) {
    if (err instanceof ActionRefusedError) ctx.ids.forget(flowStep);
    return { ok: false, error: stepErrorOf(err) };
  }
}

export async function submitBodyweight(
  ctx: FlowContext,
  entry: { value: string; note: string; unit: MassUnit },
): Promise<StepOutcome> {
  const check = checkWeight(Number.parseFloat(entry.value), entry.unit);
  if (check.kind === 'invalid') {
    return {
      ok: false,
      error: { kind: 'invalid_input', message: 'Enter a weight above zero.' },
    };
  }
  const note = entry.note.trim();
  const out = await send(ctx, 'bodyweight', 'profile.log_bodyweight', {
    bodyweightLbs: check.lbs,
    measuredAt: ctx.measuredAt(),
    ...(note === '' ? {} : { note }),
  });
  return out.ok ? { ok: true, value: undefined } : out;
}

/** Always posts, so a blank submit records "asked, no answer". */
export async function submitWeeklyCheckin(
  ctx: FlowContext,
  answers: CheckinAnswers,
): Promise<StepOutcome> {
  const answered = Object.fromEntries(Object.entries(answers).filter(([, v]) => v !== null));
  const out = await send(ctx, 'weekly_checkin', 'profile.log_weekly_checkin', {
    weekOf: ctx.weekOf,
    ...answered,
  });
  return out.ok ? { ok: true, value: undefined } : out;
}

export async function enterReview(ctx: FlowContext): Promise<StepOutcome<ReviewView>> {
  const out = await send<ReviewResult>(ctx, 'weekly_review', 'goal.weekly_review', {
    weekOf: ctx.weekOf,
  });
  return out.ok ? { ok: true, value: viewOfReview(out.value) } : out;
}

export async function answerReview(
  ctx: FlowContext,
  response: ReviewResponse,
): Promise<StepOutcome> {
  const out = await send(ctx, 'weekly_review_answer', 'goal.weekly_review', {
    weekOf: ctx.weekOf,
    response,
  });
  return out.ok ? { ok: true, value: undefined } : out;
}

/** What Done says when the review had nothing to ask. */
function reviewLine(view: ReviewView): string | null {
  switch (view.kind) {
    case 'gap':
      return view.notes.join(' ');
    case 'no_proposal':
      return ['No change proposed this week', ...view.notes].join('. ');
    case 'answered':
      return `Weekly review: ${view.userResponse} (already answered)`;
    case 'open':
      return null;
  }
}

const NO_ANSWERS: CheckinAnswers = { hunger: null, dietPlanAdherence: null, sleepQuality: null };

interface FlowState {
  step: CheckinStep;
  weight: string;
  note: string;
  answers: CheckinAnswers;
  review: ReviewView | null;
  error: StepError | null;
  saved: readonly string[];
}

const INITIAL: FlowState = {
  step: 'bodyweight',
  weight: '',
  note: '',
  answers: NO_ANSWERS,
  review: null,
  error: null,
  saved: [],
};

function useCheckinFlow(post: Post) {
  const unit = useStore(dashboardStore, (s) => s.displayUnit);
  const [state, setState] = useState<FlowState>(INITIAL);
  const [busy, setBusy] = useState(false);
  const ctx = useRef<FlowContext | null>(null);
  ctx.current ??= createFlowContext(post, new Date(), Math.random().toString(36).slice(2, 8));
  const latch = useRef<ReturnType<typeof createMutationLatch> | null>(null);
  latch.current ??= createMutationLatch({ onBusyChange: setBusy });
  const entered = useRef(false);

  const patch = (next: Partial<FlowState>): void => setState((s) => ({ ...s, ...next }));
  const advance = (saved?: string): void =>
    setState((s) => ({
      ...s,
      step: nextStep(s.step),
      error: null,
      saved: saved === undefined ? s.saved : [...s.saved, saved],
    }));
  const run = useCallback(
    (fn: () => Promise<void>) => latch.current?.run(fn) ?? Promise.resolve(false),
    [],
  );

  const enter = useCallback(
    () =>
      run(async () => {
        const out = await enterReview(ctx.current as FlowContext);
        if (!out.ok) return patch({ error: out.error });
        const line = reviewLine(out.value);
        setState((s) => ({
          ...s,
          review: out.value,
          error: null,
          step: stepAfterReview(out.value),
          saved: line === null ? s.saved : [...s.saved, line],
        }));
      }),
    [run],
  );

  useEffect(() => {
    if (state.step !== 'weekly_review' || entered.current) return;
    entered.current = true;
    void enter();
  }, [state.step, enter]);

  const submit = (fn: (c: FlowContext) => Promise<StepOutcome>, saved: string): Promise<boolean> =>
    run(async () => {
      const out = await fn(ctx.current as FlowContext);
      if (out.ok) advance(saved);
      else patch({ error: out.error });
    });

  const lastResponse = useRef<ReviewResponse | null>(null);
  const respond = async (response: ReviewResponse): Promise<boolean> => {
    lastResponse.current = response;
    let reenter = false;
    const ran = await run(async () => {
      const out = await answerReview(ctx.current as FlowContext, response);
      if (out.ok) return advance(`Weekly review: ${response}`);
      reenter = out.error.kind === 'rerun_review' || out.error.kind === 'already_answered';
      if (reenter) return patch({ review: null, error: null });
      patch({ error: out.error });
    });
    if (!reenter) return ran;
    // The refused answer is a stored outcome and its id was dropped, so this entry is a new
    // post: it reads the proposal's current state, the open advisory again or the standing answer.
    lastResponse.current = null;
    return enter();
  };

  const retryReview = (): Promise<boolean> =>
    lastResponse.current === null ? enter() : respond(lastResponse.current);

  return { state, busy, unit, patch, advance, submit, respond, retryReview };
}

export function CheckinPage(props: { post?: Post }): React.JSX.Element {
  const narrow = useIsNarrowViewport();
  const flow = useCheckinFlow(props.post ?? postAction);
  const { state, busy, unit } = flow;
  const weight = Number.parseFloat(state.weight);
  const check = checkWeight(weight, unit);
  return (
    <Surface level="base" style={{ minHeight: '100%', padding: PAGE_PADDING, gap: 24 }}>
      <View style={{ alignItems: narrow ? 'flex-start' : 'center' }}>
        <CheckinStepper step={state.step} narrow={narrow} />
      </View>
      {state.step === 'bodyweight' && (
        <BodyweightStep
          narrow={narrow}
          unit={unit}
          value={state.weight}
          note={state.note}
          busy={busy}
          error={state.error}
          warning={check.kind === 'ok' && check.warning}
          onValue={(weight) => flow.patch({ weight, error: null })}
          onNote={(note) => flow.patch({ note })}
          onNext={() =>
            void flow.submit(
              (c) => submitBodyweight(c, { value: state.weight, note: state.note, unit }),
              'Bodyweight',
            )
          }
          onSkip={() => flow.advance()}
        />
      )}
      {state.step === 'weekly_checkin' && (
        <WeeklyCheckinStep
          narrow={narrow}
          answers={state.answers}
          busy={busy}
          error={state.error}
          onAnswer={(key, value) => flow.patch({ answers: { ...state.answers, [key]: value } })}
          onNext={() =>
            void flow.submit((c) => submitWeeklyCheckin(c, state.answers), 'Weekly check-in')
          }
          onSkip={() => flow.advance()}
        />
      )}
      {state.step === 'weekly_review' && (
        <WeeklyReviewStep
          narrow={narrow}
          view={state.review}
          busy={busy}
          error={state.error}
          onRespond={(response) => void flow.respond(response)}
          onRetry={() => void flow.retryReview()}
        />
      )}
      {state.step === 'done' && <DoneStep narrow={narrow} saved={state.saved} />}
    </Surface>
  );
}
