// Export, import and verify over a store with a row in every table (VW-534).
//
// This is the proof rule 14 asks for: the training record can leave this file
// and come back whole, and a difference is caught by name rather than noticed
// a year later. Four cases, in the order they matter:
//
//   1. the guard — every table the schema declares is populated by the fixture,
//      so a table added by a later migration cannot pass this file untested;
//   2. the round trip — export, import, verify equal, then one mutated row and
//      verify names its table;
//   3. determinism — two exports of one store are byte-identical;
//   4. the source is untouched — an export never writes to what it reads.
//
// A fifth case is a regression, found rehearsing on a copy of a real store: a
// table brought to the current version by `ALTER TABLE ... ADD COLUMN` holds its
// columns in a different order from the same table freshly created, so anything
// that canonicalises rows in schema order calls two identical stores different.
//
// MUTATION CONTROL. Dropping `ORDER BY` from `selectPageSql` leaves case 2 and
// case 3 green on a small fixture and case 3 red on any table SQLite chooses to
// return in another order; adding an `exportedAt` field to the manifest fails
// case 3 outright, which is why the manifest carries no timestamp. Restoring the
// schema's own column order in `readInventory` fails case 5.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { exportStore } from '../portable/export.js';
import { importStore } from '../portable/import.js';
import { MANIFEST_FILE } from '../portable/manifest.js';
import { verifyStore } from '../portable/verify.js';
import { seedEveryTable } from './fixtures/every-table-store.js';

let dir: string;
let source: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-portable-'));
  source = join(dir, 'source.sqlite');
  await seedEveryTable(source);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fingerprint(path: string): string {
  const bytes = readFileSync(path);
  return `${bytes.byteLength}:${createHash('sha256').update(bytes).digest('hex')}`;
}

function directoryBytes(exportDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(exportDir).sort()) {
    out.set(name, readFileSync(join(exportDir, name), 'utf8'));
  }
  return out;
}

describe('store export guard', () => {
  it('populates every table the schema declares', () => {
    const manifest = exportStore(source, join(dir, 'out'));
    const empty = manifest.tables.filter((t) => t.rowCount === 0).map((t) => t.name);

    expect(empty).toEqual([]);
    expect(manifest.totals.tables).toBe(manifest.tables.length);
  });
});

describe('store export, import and verify', () => {
  it('round-trips every table and verifies equal against both the directory and the store', async () => {
    const outDir = join(dir, 'out');
    const manifest = exportStore(source, outDir);
    const restored = join(dir, 'restored.sqlite');

    await importStore(outDir, restored);

    expect(verifyStore(source, outDir)).toEqual({ equal: true, differences: [] });
    expect(verifyStore(source, restored)).toEqual({ equal: true, differences: [] });
    expect(manifest.totals.rows).toBeGreaterThan(manifest.totals.tables);
  });

  it('fails, naming the table, when one row of the restored store differs', async () => {
    const outDir = join(dir, 'out');
    exportStore(source, outDir);
    const restored = join(dir, 'restored.sqlite');
    await importStore(outDir, restored);

    const db = new DatabaseSync(restored);
    db.prepare(`UPDATE body_metrics SET bodyweight_lbs = bodyweight_lbs + 1`).run();
    db.close();

    const report = verifyStore(source, restored);
    expect(report.equal).toBe(false);
    expect(report.differences).toHaveLength(1);
    expect(report.differences[0]).toMatch(/^body_metrics: HASH [0-9a-f]{64} vs [0-9a-f]{64}$/);
  });

  it('refuses to write over an existing store file', async () => {
    const outDir = join(dir, 'out');
    exportStore(source, outDir);

    await expect(importStore(outDir, source)).rejects.toThrow(/existing file/);
  });
});

describe('export determinism and read-only source', () => {
  it('writes byte-identical output on two runs over the same store', () => {
    exportStore(source, join(dir, 'first'));
    exportStore(source, join(dir, 'second'));

    expect(directoryBytes(join(dir, 'second'))).toEqual(directoryBytes(join(dir, 'first')));
    expect(readdirSync(join(dir, 'first'))).toContain(MANIFEST_FILE);
  });

  it('leaves the source file byte-for-byte unchanged', () => {
    const before = fingerprint(source);
    const mtimeBefore = statSync(source).mtimeMs;

    exportStore(source, join(dir, 'out'));

    expect(fingerprint(source)).toBe(before);
    expect(statSync(source).mtimeMs).toBe(mtimeBefore);
  });
});

describe('column order', () => {
  function writeOneTable(path: string, columns: string): void {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE t (${columns})`);
    db.prepare(`INSERT INTO t (id, a, b) VALUES (?, ?, ?)`).run('row-1', 1, 'two');
    db.close();
  }

  it('calls two stores equal when a migration left their columns in different positions', () => {
    const declared = join(dir, 'declared.sqlite');
    const migrated = join(dir, 'migrated.sqlite');
    writeOneTable(declared, 'id TEXT PRIMARY KEY, a INTEGER, b TEXT');
    writeOneTable(migrated, 'id TEXT PRIMARY KEY, b TEXT, a INTEGER');

    expect(verifyStore(declared, migrated)).toEqual({ equal: true, differences: [] });
  });
});

describe('import refusals', () => {
  it('refuses an export whose schema version this build does not create', async () => {
    const outDir = join(dir, 'out');
    exportStore(source, outDir);
    const manifestPath = join(outDir, MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { schemaVersion: number };
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 2 }));

    await expect(importStore(outDir, join(dir, 'restored.sqlite'))).rejects.toThrow(
      /schema version 2/,
    );
    expect(existsSync(join(dir, 'restored.sqlite'))).toBe(false);
  });
});
