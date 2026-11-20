// Tests for `inMigrationTransaction`, the one plain-transaction opener for
// migrations and the portable import (VW-816).

import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { inMigrationTransaction } from '../migration-transaction.js';

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (v INTEGER NOT NULL)');
});
afterEach(() => {
  db.close();
});

function values(): number[] {
  return (db.prepare('SELECT v FROM t ORDER BY v').all() as { v: number }[]).map((row) => row.v);
}

describe('inMigrationTransaction', () => {
  it('commits the work and returns its result', () => {
    const result = inMigrationTransaction(db, () => {
      db.exec('INSERT INTO t (v) VALUES (1), (2)');
      return 'done';
    });

    expect(result).toBe('done');
    expect(db.isTransaction).toBe(false);
    expect(values()).toEqual([1, 2]);
  });

  it('rolls back and rethrows the original error when the work throws', () => {
    const failure = new Error('step failed');

    const run = (): void =>
      inMigrationTransaction(db, () => {
        db.exec('INSERT INTO t (v) VALUES (1)');
        throw failure;
      });

    expect(run).toThrow(failure);
    expect(db.isTransaction).toBe(false);
    expect(values()).toEqual([]);
  });

  it('has committed by the time it returns, so a later throw keeps the writes', () => {
    const run = (): void => {
      inMigrationTransaction(db, () => db.exec('INSERT INTO t (v) VALUES (3)'));
      throw new Error('after commit');
    };

    expect(run).toThrow('after commit');
    expect(db.isTransaction).toBe(false);
    expect(values()).toEqual([3]);
  });
});
