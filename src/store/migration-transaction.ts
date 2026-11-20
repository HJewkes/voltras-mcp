// The one place a module-level store step opens a plain transaction (VW-816).
//
// Migrations and the portable import run on a connection nothing else is using
// yet, before any caller transaction can exist, so a plain `BEGIN` is enough
// and none of them nests. `COMMIT` is the last statement inside the `try`: work
// that must follow a commit, such as a log line, belongs to the caller after
// this returns. Otherwise a throw from it would `ROLLBACK` a transaction already
// committed and hide its own error behind "no transaction is active".
//
// Methods on `SqliteSessionStore` never call this; they go through `atomically`.

import type { DatabaseSync } from 'node:sqlite';

/** Runs `fn` inside `BEGIN` / `COMMIT`; on a throw, rolls back and rethrows the original error. */
export function inMigrationTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
