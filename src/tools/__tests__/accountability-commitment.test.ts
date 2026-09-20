// `accountability.declare_commitment` and what the Sunday anchor does with what it stores
// (VW-505). A real `SqliteSessionStore.open(':memory:')`, so the table and the trigger under
// test are the shipped ones.
//
// `at` pins the instant, which is the only way to reach a Sunday without waiting for one.
// Every fixture is synthetic: the wording is invented for these tests and is nobody's.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AccountabilityState } from '../../accountability/types.js';
import { AccountabilityDeclareCommitmentInput } from '../../schemas/accountability.js';
import type { ServerState } from '../../state/server-state.js';
import { SqliteSessionStore } from '../../store/sqlite-store.js';
import { LOCAL_USER_ID } from '../../store/types.js';
import { declareCommitment } from '../accountability-commitment.js';
import { wrapHandler } from '../helpers.js';
import {
  describeAccountabilityPreview,
  describeAccountabilityState,
} from '../accountability-tools.js';

/** Local-time noon on days that are unambiguously that weekday in any timezone. */
const SUNDAY_NOON = '2026-09-13T12:00:00';
const FIRST_SUNDAY_NOON = '2026-11-01T12:00:00';
const WEDNESDAY_NOON = '2026-09-16T12:00:00';
const THURSDAY_NOON = '2026-09-17T12:00:00';

/** The Monday after `SUNDAY_NOON`: the week a Sunday declaration files against. */
const COMING_WEEK = '2026-09-14';

const DAYS = [
  { day: 'Monday' as const, fallbackDay: 'Tuesday' as const },
  { day: 'Wednesday' as const, fallbackDay: 'Thursday' as const },
];
const IF_THEN = 'If the drive runs late, then Wednesday moves to Thursday.';
const WORDING = 'Two lifts a week, and I show up for both.';

let store: SqliteSessionStore;

function makeState(): ServerState {
  return {
    config: { adapter: 'node' },
    store,
    exercises: { getById: () => undefined },
  } as unknown as ServerState;
}

function storedState(): AccountabilityState {
  return {
    userId: LOCAL_USER_ID,
    state: 'planned',
    enteredAt: '2026-09-01T00:00:00.000Z',
    consecutiveMisses: 0,
    ghostSends: [],
    lastInboundAt: null,
    proactiveSends: [],
    holdingUntil: null,
  };
}

async function seedOneTemplatePlan(): Promise<void> {
  await store.putTrainingProgram({ id: 'prog', name: 'Base', createdAt: '2026-01-01T00:00:00Z' });
  await store.putTrainingBlock({
    id: 'blk',
    programId: 'prog',
    orderIndex: 0,
    name: 'B1',
    weeksCount: 1,
  });
  await store.putTrainingWeek({ id: 'wk', blockId: 'blk', orderIndex: 0 });
  await store.putWorkoutTemplate({ id: 'tpl', weekId: 'wk', name: 'Full A', orderIndex: 0 });
}

function declare(overrides: Record<string, unknown> = {}, now = new Date(SUNDAY_NOON)) {
  return declareCommitment(
    makeState(),
    { days: DAYS, ifThen: IF_THEN, wording: WORDING, ...overrides } as never,
    now,
  );
}

beforeEach(() => {
  store = SqliteSessionStore.open(':memory:');
});

afterEach(() => {
  store.close();
});

describe('declaring a commitment', () => {
  it('files a Sunday declaration against the next day’s Monday', async () => {
    const result = await declare();

    expect(result.weekOf).toBe(COMING_WEEK);
    expect(result.revision).toBe(1);
    expect(result.unchanged).toBe(false);
  });

  it('files a mid-week declaration against the week it is in', async () => {
    const result = await declare({}, new Date(WEDNESDAY_NOON));

    expect(result.weekOf).toBe('2026-09-14');
  });

  it('takes an explicit Monday over the default', async () => {
    const result = await declare({ weekOf: '2026-10-05' });

    expect(result.weekOf).toBe('2026-10-05');
  });

  it('returns the words exactly as given, leading and trailing spaces included', async () => {
    const result = await declare({ wording: '  "Two a week."  ' });

    expect(result.wording).toBe('  "Two a week."  ');
  });

  it('bumps the revision when the words change', async () => {
    await declare();
    const corrected = await declare({ wording: 'Two lifts a week, Fridays off.' });

    expect(corrected.revision).toBe(2);
    expect(corrected.unchanged).toBe(false);
  });

  it('is a no-op when the same declaration is retried', async () => {
    await declare();
    const retried = await declare();

    expect(retried.revision).toBe(1);
    expect(retried.unchanged).toBe(true);
  });
});

describe('refusals', () => {
  it('refuses a week that is not a Monday and names the Mondays either side', async () => {
    await expect(declare({ weekOf: '2026-10-07' })).rejects.toThrow(
      'A commitment week starts on a Monday; 2026-10-07 is not one. ' +
        'The Mondays either side are 2026-10-05 and 2026-10-12.',
    );
  });

  it('refuses a date that is not a calendar date', async () => {
    await expect(declare({ weekOf: '2026-02-30' })).rejects.toThrow('not a calendar date');
  });

  it('refuses the same day committed twice', async () => {
    const days = [DAYS[0], { day: 'Monday' as const, fallbackDay: 'Friday' as const }];

    await expect(declare({ days })).rejects.toThrow('Monday is committed twice');
  });

  it('refuses a day that falls back to itself', async () => {
    const days = [{ day: 'Monday' as const, fallbackDay: 'Monday' as const }];

    await expect(declare({ days })).rejects.toThrow(
      'A fallback day cannot be the day it falls back from (Monday)',
    );
  });

  it('refuses whitespace-only wording and a whitespace-only if-then', async () => {
    await expect(declare({ wording: '   ' })).rejects.toThrow(
      "The commitment wording is the lifter's own and cannot be empty",
    );
    await expect(declare({ ifThen: '\t' })).rejects.toThrow(
      "The if-then sentence is the lifter's own and cannot be empty",
    );
  });

  it('accepts a fallback day that is also a committed day', async () => {
    const days = [
      { day: 'Monday' as const, fallbackDay: 'Wednesday' as const },
      { day: 'Wednesday' as const, fallbackDay: 'Friday' as const },
    ];

    await expect(declare({ days })).resolves.toMatchObject({ revision: 1 });
  });
});

describe('the Sunday anchor', () => {
  beforeEach(async () => {
    await store.putAccountabilityState(storedState());
    await seedOneTemplatePlan();
  });

  it('names the committed days with their fallbacks', async () => {
    await declare();

    const result = await describeAccountabilityPreview(makeState(), { at: SUNDAY_NOON });

    expect(result.text).toContain('run Monday (fallback Tuesday), Wednesday (fallback Thursday)');
  });

  it('shows the lifter’s own if-then back before asking for this week’s', async () => {
    await declare();

    const result = await describeAccountabilityPreview(makeState(), { at: SUNDAY_NOON });

    expect(result.text).toContain(`Your if-then from last week was: "${IF_THEN}"`);
  });

  it('renders the lifter’s own wording at the month marker, not the placeholder', async () => {
    await declare({}, new Date(FIRST_SUNDAY_NOON));

    const result = await describeAccountabilityPreview(makeState(), { at: FIRST_SUNDAY_NOON });

    expect(result.text).toContain(`the target in your own words is "${WORDING}"`);
    expect(result.text).not.toContain('COMMITMENT_LANGUAGE');
  });

  it('renders the placeholder at the month marker when nothing is committed', async () => {
    const result = await describeAccountabilityPreview(makeState(), { at: FIRST_SUNDAY_NOON });

    expect(result.text).toContain('COMMITMENT_LANGUAGE');
  });

  it('leaves the month marker out on a later Sunday of the month', async () => {
    await declare();

    const result = await describeAccountabilityPreview(makeState(), { at: SUNDAY_NOON });

    expect(result.text).not.toContain('Month marker');
  });
});

describe('the realign opener', () => {
  it('re-architects within the committed days rather than within none', async () => {
    await store.putAccountabilityState(storedState());
    await seedOneTemplatePlan();
    await seedFlatAdherence();
    await declare({ weekOf: '2026-09-14' });

    const result = await describeAccountabilityPreview(makeState(), { at: THURSDAY_NOON });

    expect(result.kind).toBe('realign_opener');
    expect(result.text).toContain('keep two days and move Monday and Wednesday');
  });
});

/**
 * One completed template in each of the two ranges `report.weekly` compares: a flat trend.
 * Both sessions are marked training, because an unreviewed day counts nowhere (VW-489).
 */
async function seedFlatAdherence(): Promise<void> {
  for (const [id, startedAt] of [
    ['this-week', '2026-09-15T17:00:00'],
    ['last-week', '2026-09-08T17:00:00'],
  ]) {
    await store.putSession({ id, startedAt, endedAt: startedAt, kind: 'training' });
    await store.putProgramAssignment({
      id: `${id}-assignment`,
      sessionId: id,
      workoutTemplateId: 'tpl',
      assignedAt: startedAt,
    });
  }
}

describe('accountability.state', () => {
  it('carries the commitment standing over the coming week', async () => {
    await declare();

    const result = await describeAccountabilityState(makeState(), { at: SUNDAY_NOON });

    expect(result.commitment).toMatchObject({
      weekOf: COMING_WEEK,
      revision: 1,
      ifThen: IF_THEN,
      wording: WORDING,
      days: DAYS,
    });
  });

  it('reports null when nothing has been committed to', async () => {
    const result = await describeAccountabilityState(makeState(), { at: SUNDAY_NOON });

    expect(result.commitment).toBeNull();
  });
});

/**
 * The registered callback, schema and all: a bad day name or an unknown key is rejected by
 * `.strict()` before the handler runs, and only this path proves it.
 */
describe('the registered handler', () => {
  function call(args: unknown) {
    return wrapHandler(AccountabilityDeclareCommitmentInput, (input) =>
      declareCommitment(makeState(), input, new Date(SUNDAY_NOON)),
    )(args);
  }

  const valid = { days: DAYS, ifThen: IF_THEN, wording: WORDING };

  function payload(result: { content: Array<{ text: string }> }) {
    return JSON.parse(result.content[0].text) as Record<string, unknown>;
  }

  it('stores a valid call and reports the week it filed against', async () => {
    const result = await call(valid);

    expect(result.isError).toBeUndefined();
    expect(payload(result)).toMatchObject({ weekOf: COMING_WEEK, revision: 1, unchanged: false });
  });

  it('refuses a day name that is not a weekday', async () => {
    const result = await call({ ...valid, days: [{ day: 'mondayish', fallbackDay: 'Tuesday' }] });

    expect(result.isError).toBe(true);
    expect(payload(result).code).toBe('INVALID_INPUT');
  });

  it('refuses an unknown key rather than dropping it', async () => {
    const result = await call({ ...valid, sessionsPerWeek: 3 });

    expect(result.isError).toBe(true);
    expect(payload(result).code).toBe('INVALID_INPUT');
  });

  it('refuses wording past the length cap', async () => {
    const result = await call({ ...valid, wording: 'a'.repeat(1001) });

    expect(result.isError).toBe(true);
    expect(payload(result).code).toBe('INVALID_INPUT');
  });

  it('reports a handler refusal with its own code and message', async () => {
    const result = await call({ ...valid, weekOf: '2026-10-07' });

    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(payload(result).message).toContain('The Mondays either side are');
  });
});
