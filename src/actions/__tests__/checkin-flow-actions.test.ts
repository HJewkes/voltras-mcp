// The weekly check-in stepper's four posts through the action layer (VW-895, VW-846 S2).
//
// Each case runs `executeAction` with the boot-captured handlers on a throwaway in-memory
// store, the way the wall's stepper will: bodyweight, weekly check-in, weekly review, then
// the answer, all under one flow id. What is proved is that the real handlers write what the
// conversation path writes, and that the `ui_actions` trail holds one row per post. No MCP
// client is constructed: the handlers are the boot capture, reached with no connection.
//
// Mock adapter, synthetic rows. The phase and target are seeded as in
// `goal-weekly-review.test.ts`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { captureActionHandlers, type CapturedTools } from '../capture-handlers.js';
import { executeAction, type ActionOutcome } from '../execute.js';
import { loadConfig } from '../../config.js';
import { WEEKLY_CHECKIN_KIND } from '../../schemas/profile.js';
import { bootstrapState, type ServerState } from '../../state/server-state.js';
import { LOCAL_USER_ID } from '../../store/sqlite-store.js';
import type { SessionStore } from '../../store/types.js';
import { BODYWEIGHT_RATE_ADVISORY_CODE } from '../../tools/goal-weekly-review.js';
import { mostRecentSundayIso } from '../../tools/profile-tools.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PHASE_DAYS = 70;
const START_WEIGHT_LBS = 200;
const LBS_LOST_PER_WEEK = 0.6;
const FLOW_ID = 'checkin-flow-test';

const savedEnv = { ...process.env };

let state: ServerState;
let tools: CapturedTools;
let clockMs: number;
let actionSeq = 0;

beforeEach(async () => {
  process.env.VOLTRA_ADAPTER = 'mock';
  process.env.VMCP_DB_PATH = ':memory:';
  process.env.VMCP_DASHBOARD_PORT = 'off';
  state = await bootstrapState(loadConfig());
  tools = captureActionHandlers(state);
  clockMs = Date.now();
});

afterEach(async () => {
  await state.store.close();
  process.env = { ...savedEnv };
});

const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString();

/** A declared fat-loss phase with an accepted bodyweight target under it. */
async function seedPhaseAndTarget(store: SessionStore): Promise<void> {
  await store.declareDietPhase({
    userId: LOCAL_USER_ID,
    phase: 'fat-loss',
    startedAt: daysAgo(PHASE_DAYS),
    declaredAt: daysAgo(PHASE_DAYS),
  });
  const priority = await store.putPriority({
    id: 'priority-bodyweight',
    userId: LOCAL_USER_ID,
    horizonWeeks: 12,
    kind: 'muscle',
    ref: 'whole-body',
    level: 'maintain',
    declaredAt: daysAgo(PHASE_DAYS),
    mesosHeld: 0,
  });
  await store.putGoalTarget({
    id: 'target-bodyweight',
    priorityId: priority.id,
    metric: 'bodyweight',
    startValue: START_WEIGHT_LBS,
    startMeasuredAt: daysAgo(PHASE_DAYS),
    bandLowPctPerWeek: -0.5,
    bandHighPctPerWeek: -1,
    committedValue: 190,
    stretchValue: 180,
    basis: 'rp_ramp',
    infoLevel: 'ramp',
    tierUsed: 'intermediate',
    tierProvisional: false,
    dietPhaseAtDerivation: 'fat-loss',
    acceptedBy: 'coach-default',
    acknowledgedStretch: false,
    derivedAt: daysAgo(PHASE_DAYS),
    endsAt: daysAgo(-14),
  });
}

/** A daily series losing slower than the committed 1 lb/wk, so the review proposes. */
async function seedReadings(store: SessionStore): Promise<void> {
  for (let day = 0; day < PHASE_DAYS; day += 1) {
    await store.putBodyMetric({
      userId: LOCAL_USER_ID,
      measuredAt: daysAgo(PHASE_DAYS - day),
      bodyweightLbs: START_WEIGHT_LBS - (LBS_LOST_PER_WEEK * day) / 7,
    });
  }
}

interface Post {
  name: string;
  step: string;
  input: unknown;
  actionId?: string;
}

function post({ name, step, input, actionId }: Post): Promise<ActionOutcome> {
  clockMs += 1000;
  return executeAction(
    {
      name,
      actionId: actionId ?? `act-${String((actionSeq += 1))}`,
      actor: 'user',
      surface: 'wall',
      flowId: FLOW_ID,
      flowStep: step,
      input,
    },
    { store: state.store, tools, now: () => new Date(clockMs) },
  );
}

/** The stepper's posts, in the order it sends them, all pinned to one `weekOf`. */
function stepperPosts(weekOf: string, measuredAt: string): Record<string, Post> {
  return {
    bodyweight: {
      name: 'profile.log_bodyweight',
      step: 'bodyweight',
      input: { bodyweightLbs: 194, measuredAt },
      actionId: 'act-bodyweight',
    },
    checkin: {
      name: 'profile.log_weekly_checkin',
      step: 'weekly_checkin',
      input: { weekOf, hunger: 'medium', dietPlanAdherence: 'high', sleepQuality: 'medium' },
    },
    review: { name: 'goal.weekly_review', step: 'weekly_review', input: { weekOf } },
    answer: {
      name: 'goal.weekly_review',
      step: 'weekly_review_answer',
      input: { weekOf, response: 'accepted' },
    },
  };
}

/** The flow's rows oldest first; the store lists newest first. */
async function flowRows() {
  return (await state.store.listUiActions({ flowId: FLOW_ID })).reverse();
}

describe('the check-in stepper through the action layer', () => {
  const weekOf = mostRecentSundayIso(new Date());
  const measuredAt = new Date().toISOString();
  const posts = stepperPosts(weekOf, measuredAt);

  it('leaves four ok rows in step order and stores what each step wrote', async () => {
    await seedPhaseAndTarget(state.store);
    await seedReadings(state.store);

    await post(posts.bodyweight);
    await post(posts.checkin);
    const review = await post(posts.review);
    const answer = await post(posts.answer);

    expect(review.body).toMatchObject({ ok: true, result: { outcome: 'advisory' } });
    expect(answer.body).toMatchObject({ ok: true });
    const trail = await flowRows();
    expect(trail.map((row) => row.flowStep)).toEqual([
      'bodyweight',
      'weekly_checkin',
      'weekly_review',
      'weekly_review_answer',
    ]);
    for (const row of trail) {
      expect(row).toMatchObject({ resultStatus: 'ok', actor: 'user', surface: 'wall' });
    }
    const readings = await state.store.listBodyMetrics(LOCAL_USER_ID);
    expect(readings.filter((r) => r.measuredAt === measuredAt)).toHaveLength(1);
    const checkins = await state.store.getSelfReportsForUser({
      userId: LOCAL_USER_ID,
      kind: WEEKLY_CHECKIN_KIND,
    });
    expect(checkins).toHaveLength(3);
    const proposals = await state.store.listAdvisoryDecisions(LOCAL_USER_ID, {
      code: BODYWEIGHT_RATE_ADVISORY_CODE,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ userResponse: 'accepted' });
  });

  it('adds no row when the bodyweight id is replayed', async () => {
    await post(posts.bodyweight);

    const again = await post(posts.bodyweight);

    expect(again.body).toMatchObject({ ok: true, replayed: true });
    expect(await flowRows()).toHaveLength(1);
  });

  it('leaves three ok rows when the store has no target to review', async () => {
    await post(posts.bodyweight);
    await post(posts.checkin);
    const review = await post(posts.review);

    expect(review.body).toMatchObject({ ok: true, result: { proposal: null } });
    const trail = await flowRows();
    expect(trail).toHaveLength(3);
    expect(trail.every((row) => row.resultStatus === 'ok')).toBe(true);
  });

  it('leaves one NO_OPEN_ADVISORY error row for an answer with no open proposal', async () => {
    await seedPhaseAndTarget(state.store);

    const answer = await post(posts.answer);

    expect(answer.body.ok).toBe(false);
    const trail = await flowRows();
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ resultStatus: 'error', resultCode: 'NO_OPEN_ADVISORY' });
  });
});
