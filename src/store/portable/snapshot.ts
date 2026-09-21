// Reading one store into the exact bytes an export writes, and their hashes
// (VW-534).
//
// `export` and `verify` share this so the two can never disagree: a hash in a
// manifest and a hash recomputed a year later come from the same code path over
// the same canonical text.

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { encodeValue, isStringEncodedInteger, type PortableValue } from './codec.js';
import { readInventory, selectPageSql, type TableShape } from './inventory.js';

/** Rows read per statement run. Bounds memory on a table an export has never seen before. */
const PAGE_ROWS = 2000;

export interface TableDigest {
  readonly rowCount: number;
  readonly sha256: string;
  readonly bigIntegerColumns: readonly string[];
}

/** Opened read-only, so nothing this module does can alter the file it reads. */
export function openReadOnly(storePath: string): DatabaseSync {
  return new DatabaseSync(storePath, { readOnly: true });
}

export function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

/**
 * One table's canonical text, one JSON object per line in primary-key order,
 * handed to `write` a page at a time.
 */
export function digestTable(
  db: DatabaseSync,
  shape: TableShape,
  write: (chunk: string) => void,
): TableDigest {
  const statement = db.prepare(selectPageSql(shape));
  statement.setReadBigInts(true);
  const hash = createHash('sha256');
  const bigIntegerColumns = new Set<string>();
  let rowCount = 0;
  for (;;) {
    const rows = statement.all(PAGE_ROWS, rowCount) as unknown as Record<string, unknown>[];
    if (rows.length === 0) break;
    for (const row of rows) {
      const line = `${JSON.stringify(encodeRow(shape, row, bigIntegerColumns))}\n`;
      hash.update(line);
      write(line);
    }
    rowCount += rows.length;
    if (rows.length < PAGE_ROWS) break;
  }
  return { rowCount, sha256: hash.digest('hex'), bigIntegerColumns: [...bigIntegerColumns].sort() };
}

function encodeRow(
  shape: TableShape,
  row: Record<string, unknown>,
  bigIntegerColumns: Set<string>,
): Record<string, PortableValue> {
  const out: Record<string, PortableValue> = {};
  for (const column of shape.columns) {
    const encoded = encodeValue(row[column], `${shape.name}.${column}`);
    if (isStringEncodedInteger(encoded)) bigIntegerColumns.add(column);
    out[column] = encoded;
  }
  return out;
}

/** Every table's digest, without writing anything anywhere. */
export function digestStore(storePath: string): {
  schemaVersion: number;
  tables: Map<string, TableDigest>;
} {
  const db = openReadOnly(storePath);
  try {
    const tables = new Map<string, TableDigest>();
    for (const shape of readInventory(db)) {
      tables.set(
        shape.name,
        digestTable(db, shape, () => {}),
      );
    }
    return { schemaVersion: readSchemaVersion(db), tables };
  } finally {
    db.close();
  }
}
