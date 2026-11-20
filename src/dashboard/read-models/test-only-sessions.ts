// Whether the store holds recorded work, all of it marked test (VW-968).
//
// Sessions on the mock device are stored as `test`, and every lifter-facing read
// counts training only, so a store holding nothing else renders empty pages with
// no word on why. This is the one read behind the line those pages show.

import type { SessionListFilter, StoredSession } from '../../store/types.js';

export interface TestOnlyStore {
  listSessions(filter: SessionListFilter): Promise<StoredSession[]>;
}

/** True when at least one test session exists and no training session does. */
export async function readOnlyTestSessions(store: TestOnlyStore): Promise<boolean> {
  const probe = { limit: 1, offset: 0, sort: 'startedAt:desc' } as const;
  const [test, training] = await Promise.all([
    store.listSessions({ ...probe, kind: 'test' }),
    store.listSessions({ ...probe, kind: 'training' }),
  ]);
  return test.length > 0 && training.length === 0;
}
