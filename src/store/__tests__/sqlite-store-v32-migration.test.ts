// Tests for the v31 -> v32 migration: live `sessions_28d` targets from before
// the count became training days (VW-460). v32 changes no table shape, so a
// current DB stamped back to 31 is a genuinely v31-shaped file.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteSessionStore } from '../sqlite-store.js';
import { LOCAL_USER_ID, type StoredGoalTarget, type StoredPriority } from '../types.js';

const AT = '2026-09-01T00:00:00.000Z';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-v32-'));
  path = join(dir, 'store.sqlite');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PRIORITY: StoredPriority = {
  id: 'pri-1',
  userId: LOCAL_USER_ID,
  horizonWeeks: 8,
  kind: 'muscle',
  ref: 'sessions',
  level: 'maintain',
  declaredAt: AT,
  mesosHeld: 0,
};

function target(over: Partial<StoredGoalTarget> & { id: string }): StoredGoalTarget {
  return {
    priorityId: PRIORITY.id,
    metric: 'sessions_28d',
    startValue: 12,
    startMeasuredAt: AT,
    bandLowPctPerWeek: 0,
    bandHighPctPerWeek: 0,
    committedValue: 12,
    stretchValue: 12,
    basis: 'execution_ramp',
    infoLevel: 'cold',
    tierUsed: 'intermediate',
    tierProvisional: false,
    dietPhaseAtDerivation: 'maintenance',
    acknowledgedStretch: false,
    derivedAt: AT,
    endsAt: '2026-10-27T00:00:00.000Z',
    ...over,
  };
}

/** A v31 file holding one row of every kind the migration has to tell apart. */
async function seedV31(): Promise<void> {
  const store = SqliteSessionStore.open(path);
  await store.putPriority(PRIORITY);
  await store.putGoalTarget(target({ id: 'accepted', acceptedBy: 'user' }));
  await store.putGoalTarget(target({ id: 'proposed' }));
  await store.putGoalTarget(target({ id: 'declined', retiredAt: AT, outcome: 'abandoned' }));
  await store.putGoalTarget(
    target({
      id: 'lift',
      metric: 'top_load_at_reps',
      exerciseId: 'bench-press',
      acceptedBy: 'user',
    }),
  );
  await store.close();
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA user_version = 31');
  raw.close();
}

async function targetsAfterOpen(): Promise<Map<string, StoredGoalTarget>> {
  const store = SqliteSessionStore.open(path);
  const rows = await store.listGoalTargets({ userId: LOCAL_USER_ID }, { includeRetired: true });
  await store.close();
  return new Map(rows.map((row) => [row.id, row]));
}

describe('v31 -> v32: sessions_28d counts training days', () => {
  it('retires an accepted session-count target as abandoned', async () => {
    await seedV31();

    const rows = await targetsAfterOpen();

    expect(rows.get('accepted')).toMatchObject({ outcome: 'abandoned', committedValue: 12 });
    expect(rows.get('accepted')?.retiredAt).toBeDefined();
  });

  it('deletes an unaccepted proposal instead of recording it as declined', async () => {
    await seedV31();

    const rows = await targetsAfterOpen();

    expect(rows.has('proposed')).toBe(false);
  });

  it('leaves retired rows and other metrics untouched', async () => {
    await seedV31();

    const rows = await targetsAfterOpen();

    expect(rows.get('declined')?.retiredAt).toBe(AT);
    expect(rows.get('lift')?.retiredAt).toBeUndefined();
  });

  it('touches nothing on a second open', async () => {
    await seedV31();
    const first = await targetsAfterOpen();

    const second = await targetsAfterOpen();

    expect([...second.values()]).toEqual([...first.values()]);
  });

  it('drops the retired target from the listing every scoring reader uses', async () => {
    await seedV31();
    const store = SqliteSessionStore.open(path);

    const byUser = await store.listGoalTargets({ userId: LOCAL_USER_ID });
    const byPriority = await store.listGoalTargets({ priorityId: PRIORITY.id });
    await store.close();

    expect(byUser.map((row) => row.id)).toEqual(['lift']);
    expect(byPriority.map((row) => row.id)).toEqual(['lift']);
  });
});
