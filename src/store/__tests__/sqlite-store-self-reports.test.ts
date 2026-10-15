// Tests for `self_reports` persistence (VMCP-06.12 / B41).
//
// The table existed with no writer before `session.checkin`; these cases pin
// the round trip against a real SQLite handle rather than a mock store.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StoredSelfReport, StoredSession } from '../types.js';
import { openTestStore, type SessionStore } from './open-test-store.js';

function makeSelfReport(overrides: Partial<StoredSelfReport> = {}): StoredSelfReport {
  return {
    id: 'report-1',
    userId: 'local',
    sessionId: 'sess-1',
    kind: 'checkin',
    questionCode: 'went',
    valueText: 'Got all my sets in.',
    recordedAt: '2025-01-01T00:00:05.000Z',
    ...overrides,
  };
}

const SESSION: StoredSession = {
  id: 'sess-1',
  startedAt: '2025-01-01T00:00:00.000Z',
};

describe('SqliteSessionStore self-reports', () => {
  let store: SessionStore;

  beforeEach(async () => {
    store = openTestStore();
    await store.putSession(SESSION);
  });

  afterEach(async () => {
    await store.close();
  });

  it('round-trips every populated field', async () => {
    await store.putSelfReport(makeSelfReport());
    const [got] = await store.getSelfReportsForSession('sess-1');
    expect(got).toMatchObject({
      id: 'report-1',
      userId: 'local',
      sessionId: 'sess-1',
      kind: 'checkin',
      questionCode: 'went',
      valueText: 'Got all my sets in.',
      recordedAt: '2025-01-01T00:00:05.000Z',
    });
  });

  it('leaves questionCode/valueNum absent instead of writing a sentinel', async () => {
    const { questionCode: _omitted, ...noCode } = makeSelfReport();
    await store.putSelfReport(noCode);
    const [got] = await store.getSelfReportsForSession('sess-1');
    expect('questionCode' in got).toBe(false);
    expect('valueNum' in got).toBe(false);
  });

  it('filters by kind', async () => {
    await store.putSelfReport(makeSelfReport({ id: 'a', kind: 'checkin' }));
    await store.putSelfReport(makeSelfReport({ id: 'b', kind: 'rir' }));
    const got = await store.getSelfReportsForSession('sess-1', 'checkin');
    expect(got.map((r) => r.id)).toEqual(['a']);
  });

  it('filters by session, excluding rows from other sessions', async () => {
    await store.putSession({
      kind: 'training',
      id: 'sess-2',
      startedAt: '2025-01-02T00:00:00.000Z',
    });
    await store.putSelfReport(makeSelfReport({ id: 'a', sessionId: 'sess-1' }));
    await store.putSelfReport(makeSelfReport({ id: 'b', sessionId: 'sess-2' }));

    const got = await store.getSelfReportsForSession('sess-1');
    expect(got.map((r) => r.id)).toEqual(['a']);
  });

  it('writes one row per answer rather than upserting on a shared key', async () => {
    await store.putSelfReport(makeSelfReport({ id: 'a', questionCode: 'went' }));
    await store.putSelfReport(makeSelfReport({ id: 'b', questionCode: 'felt' }));
    const got = await store.getSelfReportsForSession('sess-1');
    expect(got.length).toBe(2);
  });
});
