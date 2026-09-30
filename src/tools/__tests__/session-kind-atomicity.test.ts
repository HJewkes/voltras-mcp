// VW-586: a bulk day mark racing a deliberate single-session mark of the other kind.
//
// A day mark promises to classify only the unreviewed, but it used to partition the rows it
// had READ and then write every id it had judged unreviewed. A single-session mark landing
// between that read and the write was overwritten, and the day mark's counts described a
// partition that never existed. Run in the two variants of `store-concurrency.test.ts`: one
// store instance, and two instances on one temp file. The single mark is injected right after
// the day mark's read, because `Promise.all` alone does not interleave the two handlers there.
//
// Every value is synthetic.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServerState } from '../../state/server-state.js';
import { LOCAL_USER_ID } from '../../store/types.js';
import { markSessionKind } from '../session-kind-tools.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

const DAY = '2026-09-07';

let dir: string | undefined;
const opened: SessionStore[] = [];

function openStore(): SessionStore {
  dir ??= mkdtempSync(join(tmpdir(), 'vmcp-session-kind-'));
  const store = openTestStore({ path: join(dir, 'store.sqlite') });
  opened.push(store);
  return store;
}

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function stateOn(store: SessionStore): ServerState {
  return { store } as unknown as ServerState;
}

async function seedSession(store: SessionStore, id: string, startedAt: string): Promise<void> {
  const exerciseId = `${id}-exercise`;
  await store.putSession({ id, startedAt, endedAt: startedAt, exerciseId });
  await store.putSet({
    id: `${id}-set`,
    sessionId: id,
    userId: LOCAL_USER_ID,
    startedAt,
    endedAt: startedAt,
    partial: false,
    weightLbs: 100,
    reps: [],
    exerciseId,
  });
}

describe.each([1, 2] as const)('session.mark_kind race with %i connection(s) (VW-586)', (n) => {
  it('keeps a single-session mark that lands inside a day mark, and counts it as skipped', async () => {
    const a = openStore();
    const b = n === 1 ? a : openStore();
    await seedSession(a, 'early', `${DAY}T15:00:00.000Z`);
    await seedSession(a, 'late', `${DAY}T16:00:00.000Z`);
    // The single mark commits after the day mark has read the day and before it writes.
    const list = a.listSessionReviewRows.bind(a);
    vi.spyOn(a, 'listSessionReviewRows').mockImplementationOnce(async (filter) => {
      const rows = await list(filter);
      await markSessionKind(stateOn(b), { kind: 'test', sessionId: 'early' });
      return rows;
    });

    const day = await markSessionKind(stateOn(a), { kind: 'training', day: DAY });

    expect((await b.getSession('early'))?.kind).toBe('test');
    expect((await b.getSetsForSession('early')).map((set) => set.kind)).toEqual(['test']);
    expect((await b.getSession('late'))?.kind).toBe('training');
    expect(day.newlyClassified).toEqual(['late']);
    expect(day.skippedAlreadyMarked).toEqual(['early']);
    expect(day.reclassified).toEqual([]);
    expect(day.setsChanged).toBe(1);
    expect(day.rederived).toEqual(['late-exercise']);
  });
});
