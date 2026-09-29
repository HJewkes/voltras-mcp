// VW-587: two answers to one advisory, driven through the goal tools.
//
// Each case runs in the two variants of `partner-stamp-atomicity.test.ts`: the
// competing call on the same store, and on a second store over the same temp
// file. An interleave hook on the first caller's store fires the competing
// call at a fixed point, so the order that used to lose an answer is the order
// every run takes.
//
// Every value is synthetic.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ServerState } from '../../state/server-state.js';
import { LOCAL_USER_ID, type StoredRep } from '../../store/types.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';
import { registerGoalTools } from '../goal-tools.js';
import { BODYWEIGHT_RATE_ADVISORY_CODE } from '../goal-weekly-review.js';
import { RECALIBRATION_OFFER_CODE } from '../goal-recalibration.js';

const TOOL_NAMES = [
  'goal.declare_priorities',
  'goal.propose_targets',
  'goal.accept_target',
  'goal.list',
  'goal.retire',
  'goal.new_chapter',
  'goal.weekly_review',
];
const CATALOG = [{ id: 'bench-press', muscleGroups: ['chest'], name: 'Bench Press' }];
const WEEK_OF = '2026-09-20';
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString();

interface ToolReply {
  body: Record<string, unknown>;
  isError: boolean;
}

type Call = (name: string, args?: unknown) => Promise<ToolReply>;

interface FakeRegisteredTool {
  callback?: (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  update(updates: { callback: FakeRegisteredTool['callback'] }): void;
}

let dir: string | undefined;
const opened: SessionStore[] = [];

function openStore(): SessionStore {
  dir ??= mkdtempSync(join(tmpdir(), 'vmcp-advisory-answer-'));
  const store = openTestStore({ path: join(dir, 'store.sqlite') });
  opened.push(store);
  return store;
}

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** The goal tools over `store`, called the way the MCP server calls them. */
function toolsOver(store: SessionStore): Call {
  const state = {
    store,
    exercises: { list: () => CATALOG, getById: (id: string) => CATALOG.find((e) => e.id === id) },
  } as unknown as ServerState;
  const placeholders = new Map<string, FakeRegisteredTool>();
  for (const name of TOOL_NAMES) {
    const tool: FakeRegisteredTool = {
      update(updates) {
        tool.callback = updates.callback;
      },
    };
    placeholders.set(name, tool);
  }
  registerGoalTools(
    undefined as unknown as Parameters<typeof registerGoalTools>[0],
    state,
    placeholders as unknown as Parameters<typeof registerGoalTools>[2],
  );
  return async (name, args = {}) => {
    const result = await placeholders.get(name)!.callback!(args);
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
    return { body, isError: result.isError === true };
  };
}

async function ok(call: Call, name: string, args?: unknown): Promise<Record<string, unknown>> {
  const reply = await call(name, args);
  if (reply.isError) throw new Error(`unexpected error: ${JSON.stringify(reply.body)}`);
  return reply.body;
}

/** `store`, with `fire` run once around its `nth` call of `method`. */
function interleaved(
  store: SessionStore,
  method: 'listAdvisoryDecisions' | 'answerAdvisoryIfOpen',
  at: { nth: number; when: 'before' | 'after' },
  fire: () => Promise<unknown>,
): SessionStore {
  let calls = 0;
  return new Proxy(store, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      const bound = (value as (...args: unknown[]) => Promise<unknown>).bind(target);
      if (prop !== method) return bound;
      return async (...args: unknown[]) => {
        calls += 1;
        const due = calls === at.nth;
        if (due && at.when === 'before') await fire();
        const result = await bound(...args);
        if (due && at.when === 'after') await fire();
        return result;
      };
    },
  });
}

const VARIANTS = [
  { name: 'on one connection', second: (first: SessionStore) => first },
  { name: 'across two connections on one file', second: () => openStore() },
];

describe.each(VARIANTS)('two goal.weekly_review responses to one proposal, $name', (variant) => {
  async function seedProposal(store: SessionStore): Promise<void> {
    await store.putAdvisoryDecision({
      userId: LOCAL_USER_ID,
      code: BODYWEIGHT_RATE_ADVISORY_CODE,
      issuedAt: `${WEEK_OF}T12:00:00.000Z`,
      inputs: { weekOf: WEEK_OF, observationKey: `${WEEK_OF}:1` },
      thresholds: {},
      algorithmVersion: 'test@1',
      verdict: 'propose',
    });
  }

  it('records the first answer and refuses the second by name', async () => {
    const first = openStore();
    await seedProposal(first);
    const competitor = toolsOver(variant.second(first));
    let competing: ToolReply | undefined;
    const call = toolsOver(
      interleaved(first, 'listAdvisoryDecisions', { nth: 1, when: 'after' }, async () => {
        competing = await competitor('goal.weekly_review', {
          weekOf: WEEK_OF,
          response: 'declined',
        });
      }),
    );

    const late = await call('goal.weekly_review', { weekOf: WEEK_OF, response: 'accepted' });

    expect(competing?.isError).toBe(false);
    expect(late.isError).toBe(true);
    expect(late.body.code).toBe('ADVISORY_ALREADY_ANSWERED');
    expect(late.body.message).toContain('already answered as declined');
    const [stored] = await first.listAdvisoryDecisions(LOCAL_USER_ID);
    expect(stored.userResponse).toBe('declined');
  });
});

/** Two working sets a session at one load: enough history to calibrate the ramp. */
async function seedLiftHistory(
  store: SessionStore,
  sessionCount: number,
  withBaseline = false,
): Promise<void> {
  let lastSetId = '';
  for (let index = 0; index < sessionCount; index += 1) {
    const at = daysAgo((sessionCount - index) * 7);
    const sessionId = `bench-press-sess-${String(index)}`;
    await store.putSession({
      kind: 'training',
      id: sessionId,
      startedAt: at,
      endedAt: at,
      exerciseId: 'bench-press',
    });
    for (const suffix of ['a', 'b']) {
      lastSetId = `bench-press-set-${String(index)}${suffix}`;
      await store.putSet({
        id: lastSetId,
        sessionId,
        userId: LOCAL_USER_ID,
        exerciseId: 'bench-press',
        startedAt: at,
        endedAt: at,
        partial: false,
        weightLbs: 135,
        setPurpose: 'working',
        reps: makeReps(lastSetId, 8),
      });
    }
  }
  if (withBaseline) await seedBaseline(store, lastSetId);
}

async function seedBaseline(store: SessionStore, setId: string): Promise<void> {
  await store.putFailureAnchor({
    id: 'bench-press-anchor',
    userId: LOCAL_USER_ID,
    setId,
    exerciseId: 'bench-press',
    observedAt: daysAgo(7),
    source: 'harvested',
    terminalVelocityMps: 0.18,
    filterInputs: {},
    filterVerdict: 'failure',
    filterVersion: 'test@1',
  });
  await store.recalcBaseline({ userId: LOCAL_USER_ID, exerciseId: 'bench-press' });
}

function makeReps(setId: string, count: number): StoredRep[] {
  const phase = {
    samples: [],
    startTime: 0,
    endTime: 1000,
    startPosition: 0,
    endPosition: 0.5,
    _totalVelocity: 0,
    _totalForce: 0,
    _totalLoad: 0,
    _movementSampleCount: 0,
    _totalHoldDuration: 0,
    peakVelocity: 0,
    peakForce: 0,
    peakLoad: 0,
  };
  return Array.from({ length: count }, (_, index) => ({
    repNumber: index + 1,
    concentric: phase,
    eccentric: phase,
    id: `${setId}-r${String(index)}`,
    setId,
    index,
  }));
}

interface OfferFixture {
  rampId: string;
  offerTargetId: string;
}

/** A starting ramp accepted cold, then calibrated, with its recalibration offer open. */
async function seedOpenOffer(store: SessionStore): Promise<OfferFixture> {
  const call = toolsOver(store);
  await seedLiftHistory(store, 1);
  const declared = await ok(call, 'goal.declare_priorities', {
    items: [{ kind: 'lift', ref: 'bench-press', level: 'specialize' }],
    horizonWeeks: 6,
  });
  const priorityId = (declared.priorities as { id: string }[])[0].id;
  const proposed = await ok(call, 'goal.propose_targets', { priorityId });
  const rampId = (proposed.targets as { targetId: string }[])[0].targetId;
  await ok(call, 'goal.accept_target', { targetId: rampId });
  await seedLiftHistory(store, 2, true);
  const reproposed = await ok(call, 'goal.propose_targets', { priorityId });
  const [offer] = reproposed.recalibrationOffers as { offerTargetId: string }[];
  return { rampId, offerTargetId: offer.offerTargetId };
}

async function targetRow(store: SessionStore, id: string) {
  const rows = await store.listGoalTargets({ userId: LOCAL_USER_ID }, { includeRetired: true });
  return rows.find((row) => row.id === id);
}

async function offerDecision(store: SessionStore) {
  const [decision] = await store.listAdvisoryDecisions(LOCAL_USER_ID, {
    code: RECALIBRATION_OFFER_CODE,
  });
  return decision;
}

describe.each(VARIANTS)('an offer answered from two sides, $name', (variant) => {
  let first: SessionStore;
  let fixture: OfferFixture;

  beforeEach(async () => {
    first = openStore();
    fixture = await seedOpenOffer(first);
  });

  it('never retires the target an acceptance wrote when the ramp retire withdrew late', async () => {
    const acceptor = toolsOver(variant.second(first));
    // The retire's second read of the offers is withdrawOffersFor's: accept lands after it.
    const retire = toolsOver(
      interleaved(first, 'listAdvisoryDecisions', { nth: 2, when: 'after' }, () =>
        ok(acceptor, 'goal.accept_target', { targetId: fixture.offerTargetId }),
      ),
    );

    await ok(retire, 'goal.retire', { targetId: fixture.rampId, outcome: 'missed' });

    const accepted = await targetRow(first, fixture.offerTargetId);
    expect(accepted?.acceptedBy).toBe('coach-default');
    expect(accepted?.retiredAt).toBeUndefined();
    const decision = await offerDecision(first);
    expect(decision.userResponse).toBe('ignored');
    expect(decision.inputs.withdrawnAt).toBeUndefined();
  });

  it('writes no acceptance and retires no ramp when a decline claimed the offer first', async () => {
    const decliner = toolsOver(variant.second(first));
    const accept = toolsOver(
      interleaved(first, 'answerAdvisoryIfOpen', { nth: 1, when: 'before' }, () =>
        ok(decliner, 'goal.retire', { targetId: fixture.offerTargetId, outcome: 'abandoned' }),
      ),
    );

    const refused = await accept('goal.accept_target', { targetId: fixture.offerTargetId });

    expect(refused.isError).toBe(true);
    expect(refused.body.code).toBe('ADVISORY_ALREADY_ANSWERED');
    expect(refused.body.message).toContain('already answered as declined');
    expect((await targetRow(first, fixture.offerTargetId))?.acceptedBy).toBeUndefined();
    expect((await targetRow(first, fixture.rampId))?.retiredAt).toBeUndefined();
    expect((await offerDecision(first)).userResponse).toBe('declined');
  });

  it('tells a decline that lost to a withdrawal that the offer was already answered', async () => {
    const rampRetire = toolsOver(variant.second(first));
    const decline = toolsOver(
      interleaved(first, 'listAdvisoryDecisions', { nth: 1, when: 'after' }, () =>
        ok(rampRetire, 'goal.retire', { targetId: fixture.rampId, outcome: 'missed' }),
      ),
    );

    const retired = await ok(decline, 'goal.retire', {
      targetId: fixture.offerTargetId,
      outcome: 'abandoned',
    });

    expect(retired.declinedOffer).toBe(false);
    expect(retired.offerAlreadyAnswered).toBe(true);
    const decision = await offerDecision(first);
    expect(decision.userResponse).toBe('ignored');
    expect(decision.inputs.withdrawnAt).toEqual(expect.any(String));
  });
});
