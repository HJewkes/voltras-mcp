// VW-589: goal target accept, propose, retire and chapter writes racing another
// write, each driven through the goal tools.
//
// Each case runs in the two variants of `advisory-answer-atomicity.test.ts`:
// the competing call on the same store, and on a second store over the same
// temp file. An interleave hook on the first caller's store fires the competing
// call at a fixed point, so the order that used to lose a write is the order
// every run takes. The hook names the old method and the new one, so a case
// runs unchanged against either shape of the tool code.
//
// Every value is synthetic.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ServerState } from '../../state/server-state.js';
import { LOCAL_USER_ID, type StoredGoalTarget, type StoredRep } from '../../store/types.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';
import { registerGoalTools } from '../goal-tools.js';
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
  dir ??= mkdtempSync(join(tmpdir(), 'vmcp-goal-target-'));
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

interface Race {
  call: Call;
  fired: () => boolean;
}

/** Tools over `store`, with `fire` run once around the first call of any of `methods`. */
function raced(
  store: SessionStore,
  methods: readonly string[],
  when: 'before' | 'after',
  fire: () => Promise<unknown>,
): Race {
  let ran = false;
  const hooked = new Proxy(store, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      const bound = (value as (...args: unknown[]) => Promise<unknown>).bind(target);
      if (typeof prop !== 'string' || !methods.includes(prop)) return bound;
      return async (...args: unknown[]) => {
        const due = !ran;
        ran = true;
        if (due && when === 'before') await fire();
        const result = await bound(...args);
        if (due && when === 'after') await fire();
        return result;
      };
    },
  });
  return { call: toolsOver(hooked), fired: () => ran };
}

// The target write, however it is made: the competing call lands after every read before it.
const ACCEPT_WRITE = ['putGoalTarget', 'acceptGoalTarget'];
const PROPOSE_WRITE = ['putGoalTarget', 'putGoalTargetsDerived'];
const CHAPTER_WRITE = ['markExerciseChapter', 'startGoalChapter'];

const VARIANTS = [
  { name: 'on one connection', second: (first: SessionStore) => first },
  { name: 'across two connections on one file', second: () => openStore() },
];

/** Two working sets a session at one load. */
async function seedLiftHistory(store: SessionStore, sessionCount: number): Promise<string> {
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
  return lastSetId;
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

/** A declared lift priority with lift history behind it and nothing proposed yet. */
async function seedPriority(store: SessionStore): Promise<string> {
  await seedLiftHistory(store, 1);
  const declared = await ok(toolsOver(store), 'goal.declare_priorities', {
    items: [{ kind: 'lift', ref: 'bench-press', level: 'specialize' }],
    horizonWeeks: 6,
  });
  return (declared.priorities as { id: string }[])[0].id;
}

/** A priority with one live proposal on it. */
async function seedProposal(store: SessionStore): Promise<{ priorityId: string; id: string }> {
  const priorityId = await seedPriority(store);
  const proposed = await ok(toolsOver(store), 'goal.propose_targets', { priorityId });
  return { priorityId, id: (proposed.targets as { targetId: string }[])[0].targetId };
}

/** A starting ramp accepted cold, then calibrated, with its recalibration offer open. */
async function seedOpenOffer(store: SessionStore): Promise<{ rampId: string; offerId: string }> {
  const call = toolsOver(store);
  const ramp = await seedProposal(store);
  await ok(call, 'goal.accept_target', { targetId: ramp.id });
  await seedBaseline(store, await seedLiftHistory(store, 2));
  const reproposed = await ok(call, 'goal.propose_targets', { priorityId: ramp.priorityId });
  const [offer] = reproposed.recalibrationOffers as { offerTargetId: string }[];
  return { rampId: ramp.id, offerId: offer.offerTargetId };
}

async function targetRow(store: SessionStore, id: string): Promise<StoredGoalTarget | undefined> {
  const rows = await store.listGoalTargets({ userId: LOCAL_USER_ID }, { includeRetired: true });
  return rows.find((row) => row.id === id);
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.each(VARIANTS)('goal.accept_target racing another write, $name', (variant) => {
  it('leaves a target retired when the retire lands between the read and the accept', async () => {
    const first = openStore();
    const proposal = await seedProposal(first);
    const retirer = toolsOver(variant.second(first));
    const race = raced(first, ACCEPT_WRITE, 'before', () =>
      ok(retirer, 'goal.retire', { targetId: proposal.id, outcome: 'abandoned' }),
    );

    const refused = await race.call('goal.accept_target', { targetId: proposal.id });

    expect(race.fired()).toBe(true);
    expect(refused.body.code).toBe('GOAL_TARGET_CHANGED');
    const row = await targetRow(first, proposal.id);
    expect(row?.retiredAt).toEqual(expect.any(String));
    expect(row?.outcome).toBe('abandoned');
    expect(row?.acceptedBy).toBeUndefined();
  });

  it('refuses an accept of a band re-derived since it was read', async () => {
    const first = openStore();
    const proposal = await seedProposal(first);
    const before = await targetRow(first, proposal.id);
    const proposer = toolsOver(variant.second(first));
    // The pause guarantees the re-derivation carries a later derivedAt.
    const race = raced(first, ACCEPT_WRITE, 'before', async () => {
      await pause(5);
      await ok(proposer, 'goal.propose_targets', { priorityId: proposal.priorityId });
    });

    const refused = await race.call('goal.accept_target', { targetId: proposal.id });

    expect(race.fired()).toBe(true);
    expect(refused.body.code).toBe('GOAL_TARGET_CHANGED');
    expect(refused.body.message).toContain('re-read');
    const row = await targetRow(first, proposal.id);
    expect(row?.acceptedBy).toBeUndefined();
    expect(row?.derivedAt).not.toBe(before?.derivedAt);
  });

  it('leaves the offer unanswered and the ramp live when the target write fails', async () => {
    const first = openStore();
    const fixture = await seedOpenOffer(first);
    const other = variant.second(first);
    const race = raced(first, ACCEPT_WRITE, 'before', async () => {
      const row = (await targetRow(other, fixture.offerId))!;
      await other.putGoalTarget({ ...row, acceptedBy: 'user', stretchValue: row.stretchValue + 1 });
    });

    const refused = await race.call('goal.accept_target', { targetId: fixture.offerId });

    expect(race.fired()).toBe(true);
    expect(refused.isError).toBe(true);
    const [decision] = await first.listAdvisoryDecisions(LOCAL_USER_ID, {
      code: RECALIBRATION_OFFER_CODE,
    });
    expect(decision.userResponse).toBeUndefined();
    expect((await targetRow(first, fixture.rampId))?.retiredAt).toBeUndefined();
  });
});

describe.each(VARIANTS)('goal.propose_targets racing another write, $name', (variant) => {
  it('writes no live target under a priority retired while it derived', async () => {
    const first = openStore();
    const priorityId = await seedPriority(first);
    const retirer = toolsOver(variant.second(first));
    const race = raced(first, PROPOSE_WRITE, 'before', () =>
      ok(retirer, 'goal.retire', { priorityId, outcome: 'abandoned' }),
    );

    const refused = await race.call('goal.propose_targets', { priorityId });

    expect(race.fired()).toBe(true);
    expect(refused.body.code).toBe('PRIORITY_RETIRED');
    expect(await first.listGoalTargets({ priorityId })).toEqual([]);
  });

  it('leaves one live proposal per leg when two proposals race', async () => {
    const first = openStore();
    const priorityId = await seedPriority(first);
    const competitor = toolsOver(variant.second(first));
    const race = raced(first, PROPOSE_WRITE, 'before', () =>
      ok(competitor, 'goal.propose_targets', { priorityId }),
    );

    const proposed = await ok(race.call, 'goal.propose_targets', { priorityId });

    expect(race.fired()).toBe(true);
    const live = await first.listGoalTargets({ priorityId });
    const legs = live.map((row) => `${row.metric}:${row.exerciseId ?? ''}`);
    expect(new Set(legs).size).toBe(live.length);
    expect(live.map((row) => row.id).sort()).toEqual(
      (proposed.targets as { targetId: string }[]).map((target) => target.targetId).sort(),
    );
  });
});

describe.each(VARIANTS)('goal.propose_targets racing an accept, $name', (variant) => {
  it('writes no second proposal over a leg accepted while it derived', async () => {
    const first = openStore();
    const proposal = await seedProposal(first);
    const acceptor = toolsOver(variant.second(first));
    const race = raced(first, PROPOSE_WRITE, 'before', () =>
      ok(acceptor, 'goal.accept_target', { targetId: proposal.id }),
    );

    const proposed = await ok(race.call, 'goal.propose_targets', {
      priorityId: proposal.priorityId,
    });

    expect(race.fired()).toBe(true);
    expect(proposed.targets).toEqual([]);
    expect(JSON.stringify(proposed.skipped)).toContain(proposal.id);
    const live = await first.listGoalTargets({ priorityId: proposal.priorityId });
    expect(live.map((row) => [row.id, row.acceptedBy])).toEqual([[proposal.id, 'coach-default']]);
  });
});

describe.each(VARIANTS)('goal.retire with an outcome, $name', (variant) => {
  it('stamps the outcome without reverting a chapter stamped just after the cascade read', async () => {
    const first = openStore();
    const proposal = await seedProposal(first);
    const chapterAt = daysAgo(1);
    const stamper = toolsOver(variant.second(first));
    // The cascade's read-back of the targets is the point the old outcome restamp read from.
    const race = raced(first, ['listGoalTargets'], 'after', () =>
      ok(stamper, 'goal.new_chapter', { targetId: proposal.id, at: chapterAt }),
    );

    const retired = await ok(race.call, 'goal.retire', {
      priorityId: proposal.priorityId,
      outcome: 'missed',
    });

    expect(race.fired()).toBe(true);
    expect(retired.cascaded).toBe(1);
    const row = await targetRow(first, proposal.id);
    expect(row).toMatchObject({ outcome: 'missed', newChapterAt: chapterAt });
    expect(row?.retiredAt).toEqual(expect.any(String));
  });
});

describe.each(VARIANTS)('goal.new_chapter twice at once, $name', (variant) => {
  it('leaves the stamp on the latest chapter row', async () => {
    const first = openStore();
    const proposal = await seedProposal(first);
    const [earlier, later] = [daysAgo(2), daysAgo(1)];
    const competitor = toolsOver(variant.second(first));
    const race = raced(first, CHAPTER_WRITE, 'after', () =>
      ok(competitor, 'goal.new_chapter', { targetId: proposal.id, at: later }),
    );

    await ok(race.call, 'goal.new_chapter', { targetId: proposal.id, at: earlier });

    expect(race.fired()).toBe(true);
    const latest = await first.chapterStartedAt(LOCAL_USER_ID, 'bench-press');
    expect(latest).toBe(later);
    expect((await targetRow(first, proposal.id))?.newChapterAt).toBe(latest);
  });

  it('keeps the stamp on the latest chapter when a backdated one commits second', async () => {
    const first = openStore();
    const proposal = await seedProposal(first);
    const [earlier, later] = [daysAgo(2), daysAgo(1)];
    const competitor = toolsOver(variant.second(first));
    const race = raced(first, CHAPTER_WRITE, 'before', () =>
      ok(competitor, 'goal.new_chapter', { targetId: proposal.id, at: later }),
    );

    const stamped = await ok(race.call, 'goal.new_chapter', { targetId: proposal.id, at: earlier });

    expect(race.fired()).toBe(true);
    const latest = await first.chapterStartedAt(LOCAL_USER_ID, 'bench-press');
    expect(latest).toBe(later);
    expect((await targetRow(first, proposal.id))?.newChapterAt).toBe(latest);
    expect(stamped.target).toMatchObject({ newChapterAt: later });
  });
});
