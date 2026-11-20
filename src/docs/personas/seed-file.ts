// `seedPersonaFile`: one persona written to a new store file, behind
// `scripts/seed-persona.mjs` and `dashboard:preview -- persona <name>`.
//
// Seeding straight into a file store commits every write as its own synced
// transaction, which takes most of a minute for a twelve-week persona. So the
// seed runs against an in-memory store and a second connection copies it to the
// target with VACUUM INTO. The in-memory database is a named shared-cache one,
// which is what lets that second connection see it without the store handing out
// its own connection. The copy is then opened as a store, so a file that does not
// migrate or read fails here rather than in the dashboard.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { SqliteSessionStore } from '../../store/sqlite-store.js';
import { makeRng, personaById, seedPersona, type PersonaSeedReport } from './index.js';

/** Every persona file is seeded from this, so two runs at one clock write the same rows. */
export const PERSONA_FILE_SEED = 7;

/** Refuse the real store and any file already there; nothing here overwrites. */
export function assertSeedTarget(dbPath: string): void {
  if (dbPath.includes('.voltras')) {
    throw new Error(`refusing a path under .voltras, where the real store lives: ${dbPath}`);
  }
  if (existsSync(dbPath)) throw new Error(`refusing to overwrite an existing file: ${dbPath}`);
}

export async function seedPersonaFile(
  personaId: string,
  dbPath: string,
  now: Date,
): Promise<PersonaSeedReport> {
  assertSeedTarget(dbPath);
  const persona = personaById(personaId);
  const memoryUri = `file:vmcp-persona-${randomUUID()}?mode=memory&cache=shared`;
  const store = SqliteSessionStore.open(memoryUri);
  const copier = new DatabaseSync(memoryUri);
  let report: PersonaSeedReport;
  try {
    report = await seedPersona(store, persona, now, makeRng(PERSONA_FILE_SEED));
    copier.prepare('VACUUM INTO ?').run(dbPath);
  } finally {
    copier.close();
    await store.close();
  }
  await SqliteSessionStore.open(dbPath).close();
  return report;
}
