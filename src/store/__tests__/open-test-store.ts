// One way for a test to open a store (VW-532).
//
// A test that only exercises the port gets `SessionStore`, so the suite names no engine and
// survives whatever backs the store later. The few tests that also read the database file with
// `node:sqlite` take the concrete store through `openSqliteTestStore`, which is the only named
// way past the port. `SqliteSessionStore.open` itself is off limits outside the allow-list in
// `eslint.config.mjs`.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteSessionStore } from '../sqlite-store.js';
import type { SessionStore } from '../types.js';

/** Re-exported so a test names its store's type through the same door it opens it. */
export type { SessionStore } from '../types.js';

export interface TestStoreOptions {
  /** A database file the caller owns and removes. Omitted: an in-memory database. */
  readonly path?: string;
  /**
   * Put the database in a fresh temp directory named from this prefix. Every directory opened
   * this way is removed by `removeTestStoreDirs()`.
   */
  readonly tempPrefix?: string;
}

const createdDirs: string[] = [];

function databasePath(options: TestStoreOptions | undefined): string {
  if (options?.path !== undefined) return options.path;
  if (options?.tempPrefix === undefined) return ':memory:';
  const dir = mkdtempSync(join(tmpdir(), options.tempPrefix));
  createdDirs.push(dir);
  return join(dir, 'store.sqlite');
}

/** A store typed as the port, which is all a test needs unless it reads the file itself. */
export function openTestStore(options?: TestStoreOptions): SessionStore {
  return openSqliteTestStore(options);
}

/** The escape hatch: the concrete store, for tests that also open the file with `node:sqlite`. */
export function openSqliteTestStore(options?: TestStoreOptions): SqliteSessionStore {
  return SqliteSessionStore.open(databasePath(options));
}

/** Removes every temp directory `tempPrefix` created. Call it from `afterEach`. */
export function removeTestStoreDirs(): void {
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop()!, { recursive: true, force: true });
  }
}
