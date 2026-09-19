// `session.mark_kind` and `session.review_list` (VW-489), over a real store.
//
// The marking loop has to be safe to run twice and safe to rehearse, because
// the owner is about to classify twenty-one days of his own history in one
// sitting and a wrong bulk mark is a day of training deleted from the record.

import { describe, expect, it } from 'vitest';

import { reviewDays } from '../../analytics/session-review.js';
import { readTrainingDays } from '../../analytics/training-days.js';
import type { ServerState } from '../../state/server-state.js';
import { SqliteSessionStore } from '../../store/sqlite-store.js';
import { LOCAL_USER_ID } from '../../store/types.js';
import { listSessionReview, markSessionKind } from '../session-kind-tools.js';

const NOW = '2026-09-19T18:00:00.000Z';

function makeState(store: SqliteSessionStore): ServerState {
  return { store } as unknown as ServerState;
}

/** One unreviewed session of one exercise, with one working set on it. */
async function seedUnreviewed(
  store: SqliteSessionStore,
  id: string,
  startedAt: string,
  over: { exerciseId?: string; ended?: boolean } = {},
): Promise<void> {
  await store.putSession({
    id,
    startedAt,
    ...(over.ended === false ? {} : { endedAt: startedAt }),
    ...(over.exerciseId === undefined ? {} : { exerciseId: over.exerciseId }),
  });
  await store.putSet({
    id: `${id}-set`,
    sessionId: id,
    userId: LOCAL_USER_ID,
    startedAt,
    endedAt: startedAt,
    partial: false,
    weightLbs: 120,
    reps: [],
    ...(over.exerciseId === undefined ? {} : { exerciseId: over.exerciseId }),
  });
}

async function openSeeded(): Promise<SqliteSessionStore> {
  const store = SqliteSessionStore.open(':memory:');
  // Two rows on one day, as the owner's store holds: one session per exercise.
  await seedUnreviewed(store, 'day1-a', '2026-09-07T15:00:00.000Z', { exerciseId: 'row' });
  await seedUnreviewed(store, 'day1-b', '2026-09-07T16:00:00.000Z', { exerciseId: 'bench-press' });
  await seedUnreviewed(store, 'day2', '2026-09-10T15:00:00.000Z', { exerciseId: 'row' });
  return store;
}

describe('session.mark_kind', () => {
  it('marks a whole local day in one call, and the day then counts', async () => {
    const store = await openSeeded();

    const result = await markSessionKind(makeState(store), {
      kind: 'training',
      day: '2026-09-07',
    });

    expect(result.newlyClassified).toEqual(['day1-b', 'day1-a']);
    expect(result.setsChanged).toBe(2);
    expect(result.days).toEqual(['2026-09-07']);
    expect(await readTrainingDays(store, NOW)).toEqual(['2026-09-07']);
    await store.close();
  });

  it('is idempotent: a second run writes nothing and says so', async () => {
    const store = await openSeeded();

    await markSessionKind(makeState(store), { kind: 'training', day: '2026-09-07' });
    const again = await markSessionKind(makeState(store), { kind: 'training', day: '2026-09-07' });

    expect(again.newlyClassified).toEqual([]);
    expect(again.reclassified).toEqual([]);
    expect(again.alreadyThisKind).toEqual(['day1-b', 'day1-a']);
    await store.close();
  });

  it('is reversible: marking back takes the day out of the count again', async () => {
    const store = await openSeeded();

    await markSessionKind(makeState(store), { kind: 'training', day: '2026-09-07' });
    await markSessionKind(makeState(store), {
      kind: 'test',
      day: '2026-09-07',
      reclassify: true,
    });

    expect(await readTrainingDays(store, NOW)).toEqual([]);
    await store.close();
  });

  it('dry run reports what a real run would change and writes nothing', async () => {
    const store = await openSeeded();

    const rehearsal = await markSessionKind(makeState(store), {
      kind: 'training',
      day: '2026-09-07',
      dryRun: true,
    });
    const real = await markSessionKind(makeState(store), {
      kind: 'training',
      day: '2026-09-07',
    });

    expect(rehearsal).toEqual({ ...real, dryRun: true });
    await store.close();
  });

  it('marks an inclusive range of local days', async () => {
    const store = await openSeeded();

    const result = await markSessionKind(makeState(store), {
      kind: 'training',
      from: '2026-09-07',
      to: '2026-09-10',
      expectSessions: 3,
    });

    expect(result.newlyClassified).toHaveLength(3);
    expect(await readTrainingDays(store, NOW)).toEqual(['2026-09-07', '2026-09-10']);
    await store.close();
  });

  it('marks one session of a mixed day without touching the other', async () => {
    const store = await openSeeded();

    await markSessionKind(makeState(store), { kind: 'training', sessionId: 'day1-a' });

    const rows = await store.listSessionReviewRows({ kind: 'any' });
    expect(rows.find((row) => row.sessionId === 'day1-a')?.kind).toBe('training');
    expect(rows.find((row) => row.sessionId === 'day1-b')?.kind).toBeUndefined();
    await store.close();
  });

  it('names the exercises it re-derived, so the caller knows what moved', async () => {
    const store = await openSeeded();

    const result = await markSessionKind(makeState(store), {
      kind: 'training',
      from: '2026-09-07',
      to: '2026-09-10',
      expectSessions: 3,
    });

    expect(result.rederived).toEqual(['bench-press', 'row']);
    await store.close();
  });

  // The reviewer's finding: a day or range call used to re-flip an already-marked
  // session with no distinct signal, which is how a deliberate 'test' call gets
  // silently overturned by a bulk gesture.
  it('leaves an already-marked session alone on a day call, and says it did', async () => {
    const store = await openSeeded();
    await markSessionKind(makeState(store), { kind: 'test', sessionId: 'day1-a' });

    const result = await markSessionKind(makeState(store), {
      kind: 'training',
      day: '2026-09-07',
    });

    expect(result.newlyClassified).toEqual(['day1-b']);
    expect(result.skippedAlreadyMarked).toEqual(['day1-a']);
    expect(result.reclassified).toEqual([]);
    const rows = await store.listSessionReviewRows({ kind: 'any' });
    expect(rows.find((row) => row.sessionId === 'day1-a')?.kind).toBe('test');
    await store.close();
  });

  it('flips an already-marked session on a day call only when asked, and reports it', async () => {
    const store = await openSeeded();
    await markSessionKind(makeState(store), { kind: 'test', sessionId: 'day1-a' });

    const result = await markSessionKind(makeState(store), {
      kind: 'training',
      day: '2026-09-07',
      reclassify: true,
    });

    expect(result.newlyClassified).toEqual(['day1-b']);
    expect(result.reclassified).toEqual(['day1-a']);
    expect(result.skippedAlreadyMarked).toEqual([]);
    await store.close();
  });

  it('lets a named session be reclassified without any flag', async () => {
    const store = await openSeeded();
    await markSessionKind(makeState(store), { kind: 'test', sessionId: 'day1-a' });

    const result = await markSessionKind(makeState(store), {
      kind: 'training',
      sessionId: 'day1-a',
    });

    expect(result.reclassified).toEqual(['day1-a']);
    await store.close();
  });

  // A range is the one selector whose blast radius the caller cannot see first.
  it('refuses a real range that does not say how many sessions it expects', async () => {
    const store = await openSeeded();

    await expect(
      markSessionKind(makeState(store), { kind: 'test', from: '2020-01-01', to: '2030-01-01' }),
    ).rejects.toMatchObject({ code: 'EXPECTED_SESSIONS_MISMATCH' });
    await store.close();
  });

  it('refuses a real range whose expected count is wrong, and names the real one', async () => {
    const store = await openSeeded();

    await expect(
      markSessionKind(makeState(store), {
        kind: 'test',
        from: '2026-09-07',
        to: '2026-09-10',
        expectSessions: 2,
      }),
    ).rejects.toMatchObject({ code: 'EXPECTED_SESSIONS_MISMATCH', message: /matches 3 session/ });
    await store.close();
  });

  it('lets a dry run of a range report the count without expecting it', async () => {
    const store = await openSeeded();

    const rehearsal = await markSessionKind(makeState(store), {
      kind: 'test',
      from: '2026-09-07',
      to: '2026-09-10',
      dryRun: true,
    });

    expect(rehearsal.newlyClassified).toHaveLength(3);
    await store.close();
  });

  it('refuses a selector that matches nothing rather than reporting a no-op', async () => {
    const store = await openSeeded();

    await expect(
      markSessionKind(makeState(store), { kind: 'training', day: '2026-01-01' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await store.close();
  });
});

// The reviewer's second finding. Grouping the review list by the session's START
// while the reports date it by its END put an evening session on one row in the
// list and a different row in the report: the owner marks day D and watches it
// land on D+1. One rule now, `reviewDayOf`.
describe('the day an evening session belongs to', () => {
  const LATE = '2026-09-14T23:30:00.000Z';
  const AFTER_MIDNIGHT = '2026-09-15T00:20:00.000Z';

  async function openLateSession(ended: boolean): Promise<SqliteSessionStore> {
    const store = SqliteSessionStore.open(':memory:');
    await store.putSession({
      id: 'late',
      startedAt: LATE,
      ...(ended ? { endedAt: AFTER_MIDNIGHT } : {}),
      exerciseId: 'row',
    });
    await store.putSet({
      id: 'late-set',
      sessionId: 'late',
      userId: LOCAL_USER_ID,
      startedAt: LATE,
      endedAt: AFTER_MIDNIGHT,
      partial: false,
      weightLbs: 120,
      exerciseId: 'row',
      reps: [],
    });
    return store;
  }

  it('is listed, marked and counted under the day it ENDED, not the day it started', async () => {
    const store = await openLateSession(true);

    const list = await listSessionReview(makeState(store), {});
    const marked = await markSessionKind(makeState(store), {
      kind: 'training',
      day: '2026-09-15',
    });

    expect(list.days[0]?.day).toBe('2026-09-15');
    expect(marked.newlyClassified).toEqual(['late']);
    expect(await readTrainingDays(store, NOW)).toEqual(['2026-09-15']);
    await store.close();
  });

  it('uses its last working set when it was never ended, and all three agree', async () => {
    const store = await openLateSession(false);

    const list = await listSessionReview(makeState(store), {});
    const marked = await markSessionKind(makeState(store), {
      kind: 'training',
      day: '2026-09-15',
    });

    expect(list.days[0]?.day).toBe('2026-09-15');
    expect(marked.newlyClassified).toEqual(['late']);
    expect(await readTrainingDays(store, NOW)).toEqual(['2026-09-15']);
    await store.close();
  });

  it('is not reachable under its start day, so one date means one thing', async () => {
    const store = await openLateSession(true);

    await expect(
      markSessionKind(makeState(store), { kind: 'training', day: '2026-09-14' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await store.close();
  });
});

describe('session.review_list', () => {
  it('lists the unreviewed days newest first, with what each holds', async () => {
    const store = await openSeeded();

    const result = await listSessionReview(makeState(store), {});

    expect(result.unreviewedDays).toBe(2);
    expect(result.days.map((day) => day.day)).toEqual(['2026-09-10', '2026-09-07']);
    expect(result.days[1]).toMatchObject({
      kind: 'unreviewed',
      sets: 2,
      workingSets: 2,
      allEnded: true,
      planned: false,
    });
    expect(result.days[1]?.exercises.map((e) => e.name).sort()).toEqual(['bench-press', 'row']);
    await store.close();
  });

  it('drops a day off the list once it is marked', async () => {
    const store = await openSeeded();

    await markSessionKind(makeState(store), { kind: 'test', day: '2026-09-10' });
    const result = await listSessionReview(makeState(store), {});

    expect(result.days.map((day) => day.day)).toEqual(['2026-09-07']);
    await store.close();
  });

  it('calls a day mixed when its sessions disagree, rather than picking one', async () => {
    const store = await openSeeded();

    await markSessionKind(makeState(store), { kind: 'training', sessionId: 'day1-a' });
    const [day] = reviewDays(await store.listSessionReviewRows({ kind: 'any' })).filter(
      (row) => row.day === '2026-09-07',
    );

    expect(day?.kind).toBe('mixed');
    await store.close();
  });

  it('marks an unended day open, and dates it by its last set', async () => {
    const store = SqliteSessionStore.open(':memory:');
    await seedUnreviewed(store, 'open', '2026-09-12T15:00:00.000Z', { ended: false });

    const result = await listSessionReview(makeState(store), {});

    expect(result.days[0]).toMatchObject({ day: '2026-09-12', allEnded: false });
    await store.close();
  });
});
