// Unit tests for `getTierSignal()` (VW-92 MVP crude ceiling).
//
// Coverage shape (see the task scope in tier-signal.ts's header comment):
//   * No profile row yet -> default beginner, provisional, source 'default'.
//   * Ceiling crossing, positive: plateaued + >=24 ended sessions spanning
//     >=12 weeks -> ceiling/tier 'intermediate', confidence 'confident'.
//   * Ceiling crossing, negative: missing any one of the three conditions
//     keeps the ceiling (and tier) at 'beginner', confidence 'provisional'.
//   * Declared-tier clamp: declared 'advanced' with a 'beginner' ceiling
//     clamps down to 'beginner', confidence stays 'provisional'.
import { describe, expect, it } from 'vitest';
import type { ServerState } from '../../state/server-state.js';
import { SqliteSessionStore } from '../../store/sqlite-store.js';
import type { StoredSession, StoredTrainingProfile } from '../../store/types.js';
import { LOCAL_USER_ID } from '../../store/types.js';
import { getTierSignal } from '../tier-signal.js';

function makeState(store: SqliteSessionStore): ServerState {
  return { store } as unknown as ServerState;
}

/** A completed session `startedAt` `daysFromEpochStart` days after a fixed anchor. */
function endedSession(id: string, daysOffset: number): StoredSession {
  const anchor = new Date('2025-01-01T00:00:00.000Z').getTime();
  const startedAt = new Date(anchor + daysOffset * 24 * 60 * 60 * 1000).toISOString();
  const endedAt = new Date(
    anchor + daysOffset * 24 * 60 * 60 * 1000 + 30 * 60 * 1000,
  ).toISOString();
  return { id, startedAt, endedAt };
}

async function seedSessions(
  store: SqliteSessionStore,
  count: number,
  spanDays: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    // Spread sessions evenly across the requested span so weeksSpanned is
    // driven by the first/last offsets, not by count.
    const offset = count <= 1 ? 0 : Math.round((i * spanDays) / (count - 1));
    await store.putSession(endedSession(`s${i}`, offset));
  }
}

describe('getTierSignal', () => {
  it('defaults to beginner/provisional/default when no profile row exists', async () => {
    const store = SqliteSessionStore.open(':memory:');
    const signal = await getTierSignal(makeState(store), LOCAL_USER_ID);

    expect(signal).toEqual({
      tier: 'beginner',
      confidence: 'provisional',
      source: 'default',
      derivedCeiling: 'beginner',
      declared: null,
      evidence: {
        sessionsLogged: 0,
        firstSessionAt: null,
        weeksSpanned: 0,
        plateauDetected: false,
        techniqueStableUnderLoad: null,
        frequencyConsistent: null,
        planOwnershipObserved: null,
      },
    });
    await store.close();
  });

  it('crosses the ceiling to intermediate/confident when all three conditions hold', async () => {
    const store = SqliteSessionStore.open(':memory:');
    await seedSessions(store, 24, 90); // 90 days ~= 12+ weeks
    const profile: StoredTrainingProfile = {
      userId: LOCAL_USER_ID,
      everPlateaued: true,
      updatedAt: new Date().toISOString(),
    };
    await store.putTrainingProfile(profile);

    const signal = await getTierSignal(makeState(store), LOCAL_USER_ID);

    expect(signal.derivedCeiling).toBe('intermediate');
    expect(signal.confidence).toBe('confident');
    expect(signal.tier).toBe('beginner'); // no declared tier -> stays at the safe default
    expect(signal.source).toBe('default');
    expect(signal.evidence.sessionsLogged).toBe(24);
    expect(signal.evidence.weeksSpanned).toBeGreaterThanOrEqual(12);
    expect(signal.evidence.plateauDetected).toBe(true);
    await store.close();
  });

  it('stays beginner/provisional when only two of the three conditions hold (sessions short)', async () => {
    const store = SqliteSessionStore.open(':memory:');
    await seedSessions(store, 23, 90); // one short of the 24-session floor
    await store.putTrainingProfile({
      userId: LOCAL_USER_ID,
      everPlateaued: true,
      updatedAt: new Date().toISOString(),
    });

    const signal = await getTierSignal(makeState(store), LOCAL_USER_ID);

    expect(signal.derivedCeiling).toBe('beginner');
    expect(signal.confidence).toBe('provisional');
    expect(signal.tier).toBe('beginner');
    await store.close();
  });

  it('stays beginner/provisional when sessions span too few weeks', async () => {
    const store = SqliteSessionStore.open(':memory:');
    await seedSessions(store, 30, 30); // plenty of sessions, span under 12 weeks
    await store.putTrainingProfile({
      userId: LOCAL_USER_ID,
      everPlateaued: true,
      updatedAt: new Date().toISOString(),
    });

    const signal = await getTierSignal(makeState(store), LOCAL_USER_ID);

    expect(signal.derivedCeiling).toBe('beginner');
    expect(signal.confidence).toBe('provisional');
    await store.close();
  });

  it('stays beginner/provisional when the user never reported a plateau', async () => {
    const store = SqliteSessionStore.open(':memory:');
    await seedSessions(store, 24, 90);
    await store.putTrainingProfile({
      userId: LOCAL_USER_ID,
      everPlateaued: false,
      updatedAt: new Date().toISOString(),
    });

    const signal = await getTierSignal(makeState(store), LOCAL_USER_ID);

    expect(signal.derivedCeiling).toBe('beginner');
    expect(signal.confidence).toBe('provisional');
    await store.close();
  });

  it('clamps a declared advanced tier down to the beginner ceiling, provisional', async () => {
    const store = SqliteSessionStore.open(':memory:');
    // No sessions logged at all -> ceiling stays at the safe default.
    await store.putTrainingProfile({
      userId: LOCAL_USER_ID,
      declaredTier: 'advanced',
      updatedAt: new Date().toISOString(),
    });

    const signal = await getTierSignal(makeState(store), LOCAL_USER_ID);

    expect(signal.declared).toBe('advanced');
    expect(signal.derivedCeiling).toBe('beginner');
    expect(signal.tier).toBe('beginner');
    expect(signal.confidence).toBe('provisional');
    expect(signal.source).toBe('derived'); // the ceiling, not the declaration, decided the outcome
    await store.close();
  });

  it('honours a declared tier that does not exceed the ceiling', async () => {
    const store = SqliteSessionStore.open(':memory:');
    await store.putTrainingProfile({
      userId: LOCAL_USER_ID,
      declaredTier: 'beginner',
      updatedAt: new Date().toISOString(),
    });

    const signal = await getTierSignal(makeState(store), LOCAL_USER_ID);

    expect(signal.tier).toBe('beginner');
    expect(signal.source).toBe('declared');
    await store.close();
  });
});
