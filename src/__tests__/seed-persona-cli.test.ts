// `seed-persona` (VW-942): a persona lands in a new file that opens as a store,
// and the command never writes over the real store or any file already there.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { seedPersonaFile } from '../docs/personas/seed-file.js';
import { openTestStore } from '../store/__tests__/open-test-store.js';

const NOW = new Date('2026-10-14T15:00:00.000Z');
const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'seed-persona-cli-'));
  scratch.push(dir);
  return dir;
}

describe('seedPersonaFile', () => {
  it('refuses a path under .voltras and writes nothing there', async () => {
    const realStoreDir = join(scratchDir(), '.voltras');
    mkdirSync(realStoreDir);
    const target = join(realStoreDir, 'vmcp.sqlite');

    await expect(seedPersonaFile('first-timer', target, NOW)).rejects.toThrow(/\.voltras/);

    expect(existsSync(target)).toBe(false);
  });

  it('refuses a file that already exists and leaves it untouched', async () => {
    const target = join(scratchDir(), 'taken.sqlite');
    writeFileSync(target, 'not a store');

    await expect(seedPersonaFile('first-timer', target, NOW)).rejects.toThrow(/existing file/);

    expect(existsSync(target)).toBe(true);
  });

  it("writes a file that opens as a store and lists the persona's training sessions", async () => {
    const target = join(scratchDir(), 'first-timer.sqlite');

    const report = await seedPersonaFile('first-timer', target, NOW);

    const store = openTestStore({ path: target });
    const sessions = await store.listSessions({});
    await store.close();
    expect(report.sessions).toBe(1);
    expect(sessions.map((session) => session.id)).toEqual(['first-timer-session-1-1']);
  });
});
