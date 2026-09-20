// `export`: one plain-text file per table plus a manifest (VW-534).
//
// The source is opened READ-ONLY and nothing here ever writes to it. The output
// is newline-delimited JSON, one row per line, columns in schema order and rows
// in primary-key order, so two exports of an unchanged store are byte-identical
// and a hash over the file means something a year from now.

import { closeSync, mkdirSync, openSync, readdirSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { readInventory, type TableShape } from './inventory.js';
import {
  EXPORT_FORMAT,
  MANIFEST_FILE,
  renderManifest,
  type ExportManifest,
  type TableManifest,
} from './manifest.js';
import { digestTable, openReadOnly, readSchemaVersion } from './snapshot.js';

export function exportStore(storePath: string, outDir: string): ExportManifest {
  prepareOutDir(outDir);
  const db = openReadOnly(storePath);
  try {
    const tables = readInventory(db).map((shape) => writeTable(db, shape, outDir));
    const manifest: ExportManifest = {
      format: EXPORT_FORMAT,
      schemaVersion: readSchemaVersion(db),
      tables,
      totals: { tables: tables.length, rows: tables.reduce((n, t) => n + t.rowCount, 0) },
    };
    writeFileSync(join(outDir, MANIFEST_FILE), renderManifest(manifest));
    return manifest;
  } finally {
    db.close();
  }
}

/** An export writes a whole directory, so it refuses to share one. */
function prepareOutDir(outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  const existing = readdirSync(outDir);
  if (existing.length > 0) {
    throw new Error(`export refuses to write into a non-empty directory: ${outDir}`);
  }
}

function writeTable(
  db: ReturnType<typeof openReadOnly>,
  shape: TableShape,
  outDir: string,
): TableManifest {
  const file = `${shape.name}.jsonl`;
  const fd = openSync(join(outDir, file), 'wx');
  try {
    const digest = digestTable(db, shape, (chunk) => {
      writeSync(fd, chunk);
    });
    return {
      name: shape.name,
      file,
      primaryKey: shape.primaryKey,
      columns: shape.columns,
      generatedColumns: shape.generatedColumns,
      bigIntegerColumns: digest.bigIntegerColumns,
      rowCount: digest.rowCount,
      sha256: digest.sha256,
    };
  } finally {
    closeSync(fd);
  }
}
