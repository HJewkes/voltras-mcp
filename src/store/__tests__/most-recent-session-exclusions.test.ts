// `getMostRecentSessionIdForExercise`'s VW-642 filters: `excludeSessionIds` and
// `startedBefore` keep the open work out of "last time", and they compose with
// the lifter and training-kind scoping the read already applies.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LOCAL_USER_ID, type StoredSet } from '../types.js';
import type { SessionKind } from '../session-kind.js';
import { openTestStore, type SessionStore } from './open-test-store.js';

const EXERCISE = 'bench';

function set(id: string, sessionId: string, startedAt: string, lifter?: string): StoredSet {
  return {
    id,
    sessionId,
    userId: LOCAL_USER_ID,
    exerciseId: EXERCISE,
    startedAt,
    endedAt: startedAt,
    partial: false,
    setIndexInSession: 1,
    reps: [],
    ...(lifter !== undefined && { lifter }),
  };
}

async function seedSession(
  store: SessionStore,
  id: string,
  startedAt: string,
  options: { kind?: SessionKind; lifter?: string } = {},
): Promise<void> {
  await store.putSession({
    id,
    startedAt,
    ...(options.kind !== undefined && { kind: options.kind }),
    ...(options.lifter !== undefined && { lifter: options.lifter }),
  });
  await store.putSet(set(`${id}-set`, id, startedAt, options.lifter));
}

function mostRecent(
  store: SessionStore,
  extra: { excludeSessionIds?: string[]; startedBefore?: string; lifter?: string } = {},
): Promise<string | null> {
  return store.getMostRecentSessionIdForExercise({
    userId: LOCAL_USER_ID,
    exerciseId: EXERCISE,
    ...extra,
  });
}

describe('getMostRecentSessionIdForExercise exclusions (VW-642)', () => {
  let store: SessionStore;

  beforeEach(async () => {
    store = openTestStore();
    await seedSession(store, 'older', '2026-05-01T10:00:00.000Z', { kind: 'training' });
    await seedSession(store, 'last', '2026-05-08T10:00:00.000Z', { kind: 'training' });
    await seedSession(store, 'open', '2026-05-15T10:00:00.000Z', { kind: 'training' });
  });

  afterEach(async () => {
    await store.close();
  });

  it('skips the named open sessions', async () => {
    expect(await mostRecent(store)).toBe('open');
    expect(await mostRecent(store, { excludeSessionIds: ['open'] })).toBe('last');
    expect(await mostRecent(store, { excludeSessionIds: ['open', 'last'] })).toBe('older');
  });

  it('skips sets started at or after the cut-off', async () => {
    expect(await mostRecent(store, { startedBefore: '2026-05-15T10:00:00.000Z' })).toBe('last');
    expect(await mostRecent(store, { startedBefore: '2026-05-08T10:00:00.000Z' })).toBe('older');
  });

  it('returns null when the filters exclude everything', async () => {
    const id = await mostRecent(store, { startedBefore: '2026-05-01T10:00:00.000Z' });

    expect(id).toBeNull();
  });

  it('still skips test and unreviewed sessions under the new filters', async () => {
    await seedSession(store, 'bench-test', '2026-05-10T10:00:00.000Z', { kind: 'test' });
    await seedSession(store, 'unreviewed', '2026-05-11T10:00:00.000Z');

    expect(await mostRecent(store, { excludeSessionIds: ['open'] })).toBe('last');
  });

  it('keeps a guest and the owner apart under the new filters', async () => {
    await seedSession(store, 'guest', '2026-05-12T10:00:00.000Z', {
      kind: 'training',
      lifter: 'Sam',
    });

    expect(await mostRecent(store, { excludeSessionIds: ['open'] })).toBe('last');
    expect(await mostRecent(store, { excludeSessionIds: ['open'], lifter: 'Sam' })).toBe('guest');
  });
});
