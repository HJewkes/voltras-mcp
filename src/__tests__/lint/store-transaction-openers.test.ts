// Every transaction in `SqliteSessionStore` goes through `atomically` (VW-657).
//
// A method that writes its own `BEGIN` cannot nest: called inside an open
// transaction it fails, and a caller-owned transaction (VW-512) could never
// wrap it. So the class body holds no transaction-control literal, and only the
// helpers below may call the two module-level functions that hold them (VW-658).
//
// Outside the class, a migration or the portable import opens its transaction
// through `inMigrationTransaction` (VW-816). No non-test file under `src/` holds a
// transaction-control literal except inside the openers listed below. Comment
// lines are skipped, so prose may still name the statements.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..');
const STORE_PATH = join(SRC_DIR, 'store/sqlite-store.ts');
const CLASS_START = 'export class SqliteSessionStore';
const HELPER_STARTS = [
  '  private atomically<',
  '  private async ownedTransaction<',
  '  private async nestedTransaction<',
];
const TRANSACTION_CONTROL =
  /['"`](BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b|\b(enter|leave)TransactionLevel\(/g;
const TRANSACTION_LITERAL = /['"`](BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/;
/** The only module-level functions that may hold a transaction-control literal, by file under src/. */
const OPENERS: Record<string, readonly string[]> = {
  'store/migration-transaction.ts': ['export function inMigrationTransaction<'],
  'store/sqlite-store.ts': [
    'function enterTransactionLevel(',
    'function leaveTransactionLevel(',
    'function probeWriteLock(',
  ],
};

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

function isCommentLine(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(line);
}

/** Transaction-control literals on code lines of a whole file, outside the named openers. */
function literalsOutsideOpeners(source: string, openers: readonly string[]): string[] {
  const spans = openers.map((marker) => spanFrom(source, marker, '\n}\n'));
  const found: string[] = [];
  let at = 0;
  source.split('\n').forEach((line, index) => {
    const exempt = spans.some((span) => at >= span.start && at < span.end);
    if (!exempt && !isCommentLine(line) && TRANSACTION_LITERAL.test(line)) {
      found.push(`line ${index + 1}: ${line.trim()}`);
    }
    at += line.length + 1;
  });
  return found;
}

function nonTestSources(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(ts|tsx|mts)$/.test(file) && !file.split(/[\\/]/).includes('__tests__'))
    .map((file) => join(SRC_DIR, file));
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

const OPENER = 'function inMigrationTransaction(';
const moduleSource = (migration: string): string =>
  [
    'function inMigrationTransaction(db, fn) {',
    "  db.exec('BEGIN');",
    "  db.exec('COMMIT');",
    '}',
    '// a plain `BEGIN` named in prose',
    migration,
    '',
  ].join('\n');

describe('the module-level pin itself', () => {
  it('flags a migration that opens its own transaction', () => {
    const source = moduleSource("function migrate(db) {\n  db.exec('BEGIN');\n}");
    expect(literalsOutsideOpeners(source, [OPENER])).toEqual(["line 7: db.exec('BEGIN');"]);
  });

  it('exempts the opener and comment lines', () => {
    const source = moduleSource(
      'function migrate(db) {\n  inMigrationTransaction(db, () => 1);\n}',
    );
    expect(literalsOutsideOpeners(source, [OPENER])).toEqual([]);
  });
});

describe('every non-test source file', () => {
  it('holds transaction-control literals only inside the named openers', () => {
    const found = nonTestSources().flatMap((path) => {
      const openers = OPENERS[relative(SRC_DIR, path).split('\\').join('/')] ?? [];
      return literalsOutsideOpeners(readFileSync(path, 'utf8'), openers).map(
        (hit) => `${relative(SRC_DIR, path)} ${hit}`,
      );
    });
    expect(found).toEqual([]);
  });

  it('still names every opener the pin exempts', () => {
    const missing = Object.entries(OPENERS).flatMap(([file, markers]) => {
      const source = readFileSync(join(SRC_DIR, file), 'utf8');
      return markers.filter((marker) => !source.includes(marker)).map((m) => `${file}: ${m}`);
    });
    expect(missing).toEqual([]);
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
