// One persona seeded into an in-memory store, with the rows the invariants read.

import { makeRng, personaById, seedPersona, type PersonaSeedReport } from '../personas/index.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';
import type { StoredSession, StoredSet } from '../../store/types.js';

export const PERSONA_NOW = new Date('2026-10-14T15:00:00.000Z');

export interface SeededPersona {
  readonly store: SessionStore;
  readonly report: PersonaSeedReport;
  /** The owner's sessions of every kind, oldest first. */
  readonly sessions: readonly StoredSession[];
  /** Every set of those sessions. */
  readonly sets: readonly StoredSet[];
}

export async function seedInMemory(personaId: string, seed = 1): Promise<SeededPersona> {
  const store = openTestStore();
  const report = await seedPersona(store, personaById(personaId), PERSONA_NOW, makeRng(seed));
  const sessions = await store.listSessions({ kind: 'any', sort: 'startedAt:asc', limit: 10_000 });
  const sets: StoredSet[] = [];
  for (const session of sessions) sets.push(...(await store.getSetsForSession(session.id)));
  return { store, report, sessions, sets };
}
