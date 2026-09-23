// What an export has to know about a store's shape, read from the schema
// rather than from a hand-written list (VW-534).
//
// A table added by a future migration is picked up on the next export with no
// edit here. The price is that the shape has to be legible: a table whose rows
// cannot be put in one unambiguous order would export differently on two runs
// over the same data, so `readInventory` refuses it instead of emitting
// something that only looks deterministic.

import { type DatabaseSync } from 'node:sqlite';

/** A table name safe to interpolate into SQL and to use as a file name. */
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface TableShape {
  readonly name: string;
  /**
   * Writable columns, BY NAME rather than in the schema's own order.
   *
   * A store built by `CREATE TABLE` and one brought to the same version by
   * `ALTER TABLE ... ADD COLUMN` hold the same columns in different positions —
   * `exercise_baselines.last_anchor_at` sits mid-table in one and last in the
   * other. Sorting by name is what lets the two compare equal, and it is what a
   * later comparison against another engine will need for the same reason.
   */
  readonly columns: readonly string[];
  /** Generated columns, excluded from the export because SQLite rejects writes to them. */
  readonly generatedColumns: readonly string[];
  /** Primary-key columns, in key order. The export's sort key. */
  readonly primaryKey: readonly string[];
}

interface ColumnRow {
  readonly name: string;
  readonly pk: number;
  readonly hidden: number;
}

/** Every user table in the store, by name, with the columns an export writes. */
export function readInventory(db: DatabaseSync): TableShape[] {
  const names = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name ASC`,
    )
    .all() as unknown as { name: string }[];
  return names.map((row) => readTableShape(db, row.name));
}

function readTableShape(db: DatabaseSync, name: string): TableShape {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`table ${JSON.stringify(name)} has a name an export cannot write to a file`);
  }
  // `table_xinfo` rather than `table_info`: it is the one that reports generated
  // columns, which are exactly the ones an import must not try to write.
  const cols = db.prepare(`PRAGMA table_xinfo("${name}")`).all() as unknown as ColumnRow[];
  const primaryKey = cols
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  if (primaryKey.length === 0) {
    throw new Error(`table ${name} has no primary key, so its rows cannot be ordered for export`);
  }
  return {
    name,
    columns: byName(cols.filter((c) => c.hidden === 0)),
    generatedColumns: byName(cols.filter((c) => c.hidden !== 0)),
    primaryKey,
  };
}

function byName(cols: readonly ColumnRow[]): string[] {
  return cols.map((c) => c.name).sort();
}

/** `SELECT` for one page of a table, in primary-key order. */
export function selectPageSql(shape: TableShape): string {
  const cols = shape.columns.map((c) => `"${c}"`).join(', ');
  const order = shape.primaryKey.map((c) => `"${c}" ASC`).join(', ');
  return `SELECT ${cols} FROM "${shape.name}" ORDER BY ${order} LIMIT ? OFFSET ?`;
}

/** `INSERT` for one row of a table, generated columns left out. */
export function insertSql(shape: TableShape): string {
  const cols = shape.columns.map((c) => `"${c}"`).join(', ');
  const marks = shape.columns.map(() => '?').join(', ');
  return `INSERT INTO "${shape.name}" (${cols}) VALUES (${marks})`;
}
