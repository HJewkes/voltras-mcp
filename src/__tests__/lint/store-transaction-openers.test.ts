// Every transaction in `SqliteSessionStore` goes through `atomically` (VW-657).
//
// A method that writes its own `BEGIN` cannot nest: called inside an open
// transaction it fails, and a caller-owned transaction (VW-512) could never
// wrap it. So the class body holds no transaction-control literal, and only the
// helpers below may call the two module-level functions that hold them (VW-658).
// Migrations and the open-time lock probe are module-level functions, outside
// the class span, and stay exempt.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const STORE_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../store/sqlite-store.ts');
const CLASS_START = 'export class SqliteSessionStore';
const HELPER_STARTS = [
  '  private atomically<',
  '  private async ownedTransaction<',
  '  private async nestedTransaction<',
];
const TRANSACTION_CONTROL =
  /['"`](BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b|\b(enter|leave)TransactionLevel\(/g;

interface Span {
  start: number;
  end: number;
}

function spanFrom(source: string, marker: string, closer: string): Span {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  const end = source.indexOf(closer, start);
  if (end === -1) throw new Error(`no closer after: ${marker}`);
  return { start, end: end + closer.length };
}

function helperSpans(source: string): Span[] {
  return HELPER_STARTS.filter((marker) => source.includes(marker)).map((marker) =>
    spanFrom(source, marker, '\n  }\n'),
  );
}

/** Transaction-control literals and level calls in the class body that sit outside the helpers. */
function rawOpenersOutsideHelper(source: string): string[] {
  const klass = spanFrom(source, CLASS_START, '\n}\n');
  const helpers = helperSpans(source);
  const body = source.slice(klass.start, klass.end);
  return [...body.matchAll(TRANSACTION_CONTROL)]
    .map((match) => ({ at: klass.start + match.index, text: match[0] }))
    .filter(({ at }) => helpers.every((helper) => at < helper.start || at >= helper.end))
    .map(({ at, text }) => `line ${source.slice(0, at).split('\n').length}: ${text}`);
}

const synthetic = (method: string): string =>
  [
    "function migrate(db) { db.exec('BEGIN'); db.exec('COMMIT'); }",
    'export class SqliteSessionStore {',
    '  private atomically<T>(fn: () => T): T {',
    "    this.db.exec('BEGIN IMMEDIATE');",
    '  }',
    method,
    '}',
    '',
  ].join('\n');

describe('the pin itself', () => {
  it('flags a method that opens its own transaction', () => {
    const source = synthetic("  put() {\n    this.db.exec('BEGIN');\n  }");
    expect(rawOpenersOutsideHelper(source)).toEqual(["line 7: 'BEGIN"]);
  });

  it('flags a method that takes its own savepoint', () => {
    const source = synthetic('  put() {\n    this.db.exec(`SAVEPOINT x`);\n  }');
    expect(rawOpenersOutsideHelper(source)).toEqual(['line 7: `SAVEPOINT']);
  });

  it('flags a method that calls a transaction level function itself', () => {
    const source = synthetic('  put() {\n    enterTransactionLevel(this.db, 0);\n  }');
    expect(rawOpenersOutsideHelper(source)).toEqual(['line 7: enterTransactionLevel(']);
  });

  it('exempts the helper and module-level functions', () => {
    const source = synthetic('  put() {\n    this.atomically(() => 1);\n  }');
    expect(rawOpenersOutsideHelper(source)).toEqual([]);
  });
});

describe('SqliteSessionStore', () => {
  it('opens every transaction through its helpers', () => {
    const source = readFileSync(STORE_PATH, 'utf8');
    expect(rawOpenersOutsideHelper(source)).toEqual([]);
  });

  it('still names every helper the pin exempts', () => {
    const source = readFileSync(STORE_PATH, 'utf8');
    expect(HELPER_STARTS.filter((marker) => !source.includes(marker))).toEqual([]);
  });
});
