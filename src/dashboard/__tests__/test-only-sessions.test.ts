import { describe, expect, it } from 'vitest';

import { readOnlyTestSessions } from '../read-models/test-only-sessions.js';
import type { SessionListFilter, StoredSession } from '../../store/types.js';

function storeHolding(kinds: Array<'test' | 'training' | undefined>) {
  return {
    listSessions: async (filter: SessionListFilter): Promise<StoredSession[]> => {
      const wanted = filter.kind ?? 'training';
      return kinds
        .filter((kind) => wanted === 'any' || kind === wanted)
        .map((kind, i) => ({ id: `s${i}`, kind }) as StoredSession);
    },
  };
}

describe('readOnlyTestSessions', () => {
  it('is true when the store holds test sessions and no training ones', async () => {
    expect(await readOnlyTestSessions(storeHolding(['test', 'test']))).toBe(true);
  });

  it('is false once any training session exists', async () => {
    expect(await readOnlyTestSessions(storeHolding(['test', 'training']))).toBe(false);
  });

  it('is false for an empty store', async () => {
    expect(await readOnlyTestSessions(storeHolding([]))).toBe(false);
  });

  it('is false when the only sessions are unreviewed', async () => {
    expect(await readOnlyTestSessions(storeHolding([undefined]))).toBe(false);
  });
});
