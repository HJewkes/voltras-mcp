// Every transaction in `SqliteSessionStore` goes through `atomically` (VW-657).
//
// A method that writes its own `BEGIN` cannot nest: called inside an open
// transaction it fails, and a caller-owned transaction (VW-512) could never
// wrap it. So the only transaction-control literals allowed in the class body
// are the ones inside the helper. Migrations and the open-time lock probe are
// module-level functions, outside the class span, and stay exempt.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const STORE_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../store/sqlite-store.ts');
const CLASS_START = 'export class SqliteSessionStore';
const HELPER_START = '  private atomically<';
const TRANSACTION_CONTROL = /['"`](BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/g;

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

/** Transaction-control literals in the class body that sit outside `atomically`. */
function rawOpenersOutsideHelper(source: string): string[] {
  const klass = spanFrom(source, CLASS_START, '\n}\n');
  const helper = spanFrom(source, HELPER_START, '\n  }\n');
  const body = source.slice(klass.start, klass.end);
  return [...body.matchAll(TRANSACTION_CONTROL)]
    .map((match) => ({ at: klass.start + match.index, text: match[0] }))
    .filter(({ at }) => at < helper.start || at >= helper.end)
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

  it('exempts the helper and module-level functions', () => {
    const source = synthetic('  put() {\n    this.atomically(() => 1);\n  }');
    expect(rawOpenersOutsideHelper(source)).toEqual([]);
  });
});

describe('SqliteSessionStore', () => {
  it('opens every transaction through atomically', () => {
    const source = readFileSync(STORE_PATH, 'utf8');
    expect(rawOpenersOutsideHelper(source)).toEqual([]);
  });
});
