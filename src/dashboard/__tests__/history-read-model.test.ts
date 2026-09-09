// Unit tests for the history read-model (VMCP-03.03).
//
// Pure shaping only — no store, no HTTP, no `?limit=` parsing (that stays in
// `server.ts`'s `fetchHistory`, which owns the query-string parse).

import { describe, expect, it } from 'vitest';

import { buildHistoryView } from '../read-models/history.js';
import type { StoredSession } from '../../store/types.js';

describe('buildHistoryView', () => {
  it('returns the fetched session page as-is', () => {
    const sessions: StoredSession[] = [
      { id: '1', startedAt: '2026-05-01T09:00:00.000Z' },
      { id: '2', startedAt: '2026-05-02T09:00:00.000Z' },
    ];
    expect(buildHistoryView({ sessions })).toEqual(sessions);
  });

  it('returns an empty list for an empty page', () => {
    expect(buildHistoryView({ sessions: [] })).toEqual([]);
  });
});
