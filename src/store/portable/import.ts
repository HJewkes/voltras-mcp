// `import`: a fresh store at the manifest's schema version, loaded in one
// transaction (VW-534).
//
// THE TRIGGERS ARE SATISFIED, NEVER BYPASSED. All five of this schema's
// RAISE(ABORT) triggers fire BEFORE UPDATE or BEFORE DELETE; none fires on an
// insert. A load that only ever inserts therefore honours append-only
// `block_schedules` and `commitments`, complete-once and never-deleted
// `ui_actions`, without the loader knowing they exist. The one row the load does
// delete is the local user the production open path seeds, and `users` carries
// no trigger; a future seeded row on an append-only table would raise here with
// its table named, which is the loud failure that belongs in this file.
//
// Foreign keys stay ENFORCED: `defer_foreign_keys` moves the check to COMMIT so
// tables can load in name order, rather than switching enforcement off.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { SqliteSessionStore } from '../sqlite-store.js';
import { decodeValue, type PortableValue } from './codec.js';
import { insertSql, readInventory, type TableShape } from './inventory.js';
import {
  MANIFEST_FILE,
  parseManifest,
  type ExportManifest,
  type TableManifest,
} from './manifest.js';
import { readSchemaVersion } from './snapshot.js';
import { hashText, readTableFile } from './table-file.js';

export async function importStore(inDir: string, storePath: string): Promise<ExportManifest> {
  if (existsSync(storePath)) {
    throw new Error(`import refuses to write to an existing file: ${storePath}`);
  }
  const manifest = parseManifest(
    readFileSync(join(inDir, MANIFEST_FILE), 'utf8'),
    join(inDir, MANIFEST_FILE),
  );
  await createEmptyStore(storePath);
  try {
    loadInto(storePath, inDir, manifest);
    return manifest;
  } catch (err) {
    rmSync(storePath, { force: true });
    throw err;
  }
}

/** The production open path, so the new store's schema is the one the server writes. */
async function createEmptyStore(storePath: string): Promise<void> {
  const store = SqliteSessionStore.open(storePath);
  await store.close();
}

function loadInto(storePath: string, inDir: string, manifest: ExportManifest): void {
  const db = new DatabaseSync(storePath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const shapes = readInventory(db);
    checkCompatible(readSchemaVersion(db), shapes, manifest);
    db.exec('BEGIN');
    db.exec('PRAGMA defer_foreign_keys = ON');
    try {
      for (const shape of shapes) clearSeedRows(db, shape);
      for (const shape of shapes) insertTable(db, shape, inDir, manifest);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    db.close();
  }
}

/** A store whose shape differs from the manifest's would import silently wrong. */
function checkCompatible(
  schemaVersion: number,
  shapes: readonly TableShape[],
  manifest: ExportManifest,
): void {
  if (schemaVersion !== manifest.schemaVersion) {
    throw new Error(
      `import needs a store at schema version ${manifest.schemaVersion}; this build creates ${schemaVersion}`,
    );
  }
  const named = new Set(manifest.tables.map((t) => t.name));
  for (const shape of shapes) {
    const table = manifest.tables.find((t) => t.name === shape.name);
    if (!table) throw new Error(`import has no file for table ${shape.name}`);
    if (table.columns.join(',') !== shape.columns.join(',')) {
      throw new Error(`import: table ${shape.name} has different columns than the export`);
    }
    named.delete(shape.name);
  }
  if (named.size > 0) {
    throw new Error(`import: the export has tables this store does not: ${[...named].join(', ')}`);
  }
}

/** The production open path seeds the local user; a faithful import replaces it. */
function clearSeedRows(db: DatabaseSync, shape: TableShape): void {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${shape.name}"`).get() as { n: number };
  if (n === 0) return;
  try {
    db.prepare(`DELETE FROM "${shape.name}"`).run();
  } catch (err) {
    throw new Error(`import cannot clear the ${n} row(s) a fresh store seeds into ${shape.name}`, {
      cause: err,
    });
  }
}

function insertTable(
  db: DatabaseSync,
  shape: TableShape,
  inDir: string,
  manifest: ExportManifest,
): void {
  const table = manifest.tables.find((t) => t.name === shape.name) as TableManifest;
  const text = readTableFile(inDir, table);
  if (hashText(text) !== table.sha256) {
    throw new Error(`import: ${table.file} does not match its hash in the manifest`);
  }
  const statement = db.prepare(insertSql(shape));
  let rows = 0;
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    statement.run(...rowValues(shape, JSON.parse(line) as Record<string, PortableValue>));
    rows += 1;
  }
  if (rows !== table.rowCount) {
    throw new Error(`import: ${table.file} holds ${rows} rows, manifest says ${table.rowCount}`);
  }
}

function rowValues(shape: TableShape, row: Record<string, PortableValue>): SQLInputValue[] {
  return shape.columns.map((column) => decodeValue(row[column] ?? null, `${shape.name}.${column}`));
}
