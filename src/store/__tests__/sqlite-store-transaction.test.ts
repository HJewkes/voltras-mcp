// The store's one transaction helper, `atomically` (VW-657, VW-512 S1).
//
// Depth 0 opens `BEGIN IMMEDIATE`; a nested call takes a numbered savepoint,
// so an inner throw undoes only the inner writes. The helper is private, so
// these tests reach it through a narrow cast rather than widening the class.
// Every row is synthetic and every store is in-memory.

import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LOCAL_USER_ID, SqliteSessionStore } from '../sqlite-store.js';

interface TransactionInternals {
  readonly db: DatabaseSync;
  readonly transactionDepth: number;
  atomically<T>(fn: () => T): T;
}

let store: SqliteSessionStore;
let tx: TransactionInternals;

function write(label: string): void {
  tx.db.prepare(`INSERT INTO scratch (label) VALUES (?)`).run(label);
}

function labels(): string[] {
  const rows = tx.db.prepare(`SELECT label FROM scratch ORDER BY rowid`).all() as {
    label: string;
  }[];
  return rows.map((row) => row.label);
}

function noTransactionOpen(): boolean {
  try {
    tx.db.exec('BEGIN');
  } catch {
    return false;
  }
  tx.db.exec('ROLLBACK');
  return true;
}

beforeEach(() => {
  store = SqliteSessionStore.open(':memory:');
  tx = store as unknown as TransactionInternals;
  tx.db.exec(`CREATE TABLE scratch (label TEXT NOT NULL)`);
});

afterEach(async () => {
  await store.close();
});

describe('atomically', () => {
  it('commits an inner call together with the outer one', () => {
    tx.atomically(() => {
      write('outer');
      tx.atomically(() => write('inner'));
    });

    expect(labels()).toEqual(['outer', 'inner']);
    expect(noTransactionOpen()).toBe(true);
  });

  it('rolls back only the inner writes when the outer catches an inner throw', () => {
    tx.atomically(() => {
      write('outer');
      expect(() =>
        tx.atomically(() => {
          write('inner');
          throw new Error('inner failed');
        }),
      ).toThrow('inner failed');
      write('after');
    });

    expect(labels()).toEqual(['outer', 'after']);
  });

  it('rolls back everything when an inner throw is not caught', () => {
    expect(() =>
      tx.atomically(() => {
        write('outer');
        tx.atomically(() => {
          write('inner');
          throw new Error('inner failed');
        });
      }),
    ).toThrow('inner failed');

    expect(labels()).toEqual([]);
    expect(noTransactionOpen()).toBe(true);
  });

  it('returns to depth 0 after an outer throw, so the next call begins cleanly', () => {
    expect(() =>
      tx.atomically(() => {
        write('doomed');
        throw new Error('outer failed');
      }),
    ).toThrow('outer failed');

    expect(tx.transactionDepth).toBe(0);
    expect(noTransactionOpen()).toBe(true);
    tx.atomically(() => write('next'));
    expect(labels()).toEqual(['next']);
  });

  it.each([
    ['a promise', () => Promise.resolve('late')],
    ['a bare thenable', () => ({ then: () => undefined })],
  ])('refuses a callback that returns %s and keeps none of its writes', (_label, result) => {
    expect(() =>
      tx.atomically(() => {
        write('before the await');
        return result();
      }),
    ).toThrow(expect.objectContaining({ code: 'STORE_TRANSACTION_ASYNC' }));

    expect(labels()).toEqual([]);
    expect(tx.transactionDepth).toBe(0);
  });

  it('lets a store method join an open transaction as a savepoint', async () => {
    expect(() =>
      tx.atomically(() => {
        void store.declareDietPhase({
          userId: LOCAL_USER_ID,
          phase: 'maintenance',
          startedAt: '2026-01-01T00:00:00.000Z',
          declaredAt: '2026-01-02T00:00:00.000Z',
        });
        throw new Error('caller failed');
      }),
    ).toThrow('caller failed');

    expect(await store.listDietPhases(LOCAL_USER_ID)).toEqual([]);
  });
});
