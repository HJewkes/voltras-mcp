// `verify`: recompute counts and per-table hashes and say which table differs
// (VW-534).
//
// The report is COUNT and HASH only. A tool whose job is to prove a training
// record survived a move has no reason to print a single value out of it, and
// a difference report that quoted rows would be the one place personal history
// leaked into a terminal, a log or a pull request.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { MANIFEST_FILE, parseManifest, type ExportManifest } from './manifest.js';
import { digestStore, type TableDigest } from './snapshot.js';
import { hashText, readTableFile } from './table-file.js';

export interface VerifyReport {
  readonly equal: boolean;
  /** One line per difference, naming the table and whether count or hash differs. */
  readonly differences: readonly string[];
}

/** `target` is either an export directory or a second store file. */
export function verifyStore(storePath: string, target: string): VerifyReport {
  const left = digestStore(storePath);
  const right = statSync(target).isDirectory() ? readExportDigest(target) : digestStore(target);
  const differences = [
    ...schemaDifference(left.schemaVersion, right.schemaVersion),
    ...tableDifferences(left.tables, right.tables),
  ];
  return { equal: differences.length === 0, differences };
}

function readExportDigest(dir: string): {
  schemaVersion: number;
  tables: Map<string, TableDigest>;
} {
  const manifest: ExportManifest = parseManifest(
    readFileSync(join(dir, MANIFEST_FILE), 'utf8'),
    join(dir, MANIFEST_FILE),
  );
  const tables = new Map<string, TableDigest>();
  for (const table of manifest.tables) {
    const onDisk = hashText(readTableFile(dir, table));
    tables.set(table.name, {
      rowCount: table.rowCount,
      // The file wins over the manifest: a file edited after the export must not verify equal.
      sha256: onDisk,
      bigIntegerColumns: table.bigIntegerColumns,
    });
  }
  return { schemaVersion: manifest.schemaVersion, tables };
}

function schemaDifference(left: number, right: number): string[] {
  return left === right ? [] : [`schema version: ${left} vs ${right}`];
}

function tableDifferences(
  left: Map<string, TableDigest>,
  right: Map<string, TableDigest>,
): string[] {
  const out: string[] = [];
  for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const a = left.get(name);
    const b = right.get(name);
    if (!a || !b) {
      out.push(`${name}: present on only one side`);
      continue;
    }
    if (a.rowCount !== b.rowCount) out.push(`${name}: COUNT ${a.rowCount} vs ${b.rowCount}`);
    if (a.sha256 !== b.sha256) out.push(`${name}: HASH ${a.sha256} vs ${b.sha256}`);
  }
  return out;
}
