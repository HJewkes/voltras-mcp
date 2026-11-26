// The v45 -> v46 step: `training_profile.return_clearance` and `return_clearance_on` (VW-976).
// Additive and back-fills nothing: a profile answered before v46 reads as never asked.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openTestStore } from './open-test-store.js';
import { LOCAL_USER_ID } from '../types.js';

const AT = '2026-10-03T12:00:00.000Z';

let dir: string;
let path: string;

/** A current store with a profile row, then the two v46 columns dropped and stamped v45. */
async function seedV45Store(): Promise<void> {
  const store = openTestStore({ path });
  await store.putTrainingProfile({
    userId: LOCAL_USER_ID,
    updatedAt: AT,
    declaredTier: 'beginner',
  });
  await store.close();
  const db = new DatabaseSync(path);
  db.exec('ALTER TABLE training_profile DROP COLUMN return_clearance');
  db.exec('ALTER TABLE training_profile DROP COLUMN return_clearance_on');
  db.exec('PRAGMA user_version = 45');
  db.close();
}

function userVersion(): number {
  const db = new DatabaseSync(path);
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  db.close();
  return row.user_version;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-v46-'));
  path = join(dir, 'store.sqlite');
  await seedV45Store();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('v45 -> v46 migration', () => {
  it('leaves an existing profile unanswered and stamps v46', async () => {
    const store = openTestStore({ path });
    const profile = await store.getTrainingProfile(LOCAL_USER_ID);
    await store.close();

    expect(profile).toMatchObject({ declaredTier: 'beginner' });
    expect(profile?.returnClearance).toBeUndefined();
    expect(userVersion()).toBe(46);
  });

  it('round-trips an answer across a re-open', async () => {
    const first = openTestStore({ path });
    const profile = await first.getTrainingProfile(LOCAL_USER_ID);
    const returnClearance = { answer: 'not_yet', answeredOn: '2026-10-02' } as const;
    await first.putTrainingProfile({ ...profile!, returnClearance });
    await first.close();

    const second = openTestStore({ path });
    const reread = await second.getTrainingProfile(LOCAL_USER_ID);
    await second.close();

    expect(reread?.returnClearance).toEqual(returnClearance);
  });
});
