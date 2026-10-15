// `anonymize`: an export in, an anonymised export out (VW-941).
//
// The output is a private fixture of the owner's own training shape, made on
// their own machine: free text gone, ids and names replaced, dates moved. It is
// still personal training data, so it is written outside any git work tree and
// is never committed. The output is an ordinary export, with its own manifest
// and hashes, so `import` loads it into a new store and `verify` checks it.
//
// Default-deny: the run fails before writing anything if the export holds a
// table or column `TABLE_RULES` does not name.

import { closeSync, existsSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { TABLE_RULES } from './anonymize-rules.js';
import { makeContext, type AnonymizeContext, type Row } from './anonymize-values.js';
import { isStringEncodedInteger, type PortableValue } from './codec.js';
import { prepareOutDir } from './export.js';
import {
  MANIFEST_FILE,
  parseManifest,
  renderManifest,
  type ExportManifest,
  type TableManifest,
} from './manifest.js';
import { hashText, readTableFile } from './table-file.js';

export interface AnonymizeOptions {
  /** Fixes the salt, the date offset and the load factor, so a rerun writes the same files. */
  readonly seed?: string;
  /** Multiply every load by one factor in [0.9, 1.1]. Off by default. */
  readonly scale?: boolean;
}

/** Where the output goes when the caller names no directory. */
export function defaultFixtureDir(exportDir: string): string {
  return join(homedir(), '.voltras', 'fixtures', `${basename(resolve(exportDir))}-anonymized`);
}

export function anonymizeExport(
  inDir: string,
  outDir: string,
  options: AnonymizeOptions = {},
): ExportManifest {
  refuseGitWorkTree(outDir);
  const source = parseManifest(
    readFileSync(join(inDir, MANIFEST_FILE), 'utf8'),
    join(inDir, MANIFEST_FILE),
  );
  checkCovered(source);
  prepareOutDir(outDir);
  const ctx = makeContext(options.seed, options.scale ?? false);
  const tables = source.tables.map((table) => writeTable(inDir, outDir, table, ctx));
  const manifest: ExportManifest = {
    ...source,
    tables,
    totals: { tables: tables.length, rows: tables.reduce((n, t) => n + t.rowCount, 0) },
  };
  writeFileSync(join(outDir, MANIFEST_FILE), renderManifest(manifest));
  return manifest;
}

/** A fixture of real training data must never land somewhere `git add` can reach it. */
export function refuseGitWorkTree(outDir: string): void {
  for (let dir = resolve(outDir); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) {
      throw new Error(
        `anonymize refuses to write inside a git work tree (${dir}): the output is personal training data`,
      );
    }
    if (dirname(dir) === dir) return;
  }
}

function checkCovered(manifest: ExportManifest): void {
  for (const table of manifest.tables) {
    const rule = TABLE_RULES[table.name];
    if (rule === undefined) {
      throw new Error(
        `anonymize has no rule for table ${table.name}; add one to anonymize-rules.ts`,
      );
    }
    if (rule === 'drop') continue;
    const unlisted = table.columns.filter((column) => rule[column] === undefined);
    if (unlisted.length > 0) {
      throw new Error(
        `anonymize has no rule for ${unlisted.map((c) => `${table.name}.${c}`).join(', ')}; add one to anonymize-rules.ts`,
      );
    }
  }
}

function writeTable(
  inDir: string,
  outDir: string,
  table: TableManifest,
  ctx: AnonymizeContext,
): TableManifest {
  const text = readTableFile(inDir, table);
  if (hashText(text) !== table.sha256) {
    throw new Error(`anonymize: ${table.file} does not match its hash in the manifest`);
  }
  const lines = TABLE_RULES[table.name] === 'drop' ? [] : rewriteLines(text, table, ctx);
  const bigIntegerColumns = new Set<string>();
  const fd = openSync(join(outDir, table.file), 'wx');
  try {
    for (const line of lines) writeSync(fd, line.text);
    for (const line of lines) line.bigIntegerColumns.forEach((c) => bigIntegerColumns.add(c));
  } finally {
    closeSync(fd);
  }
  return {
    ...table,
    bigIntegerColumns: [...bigIntegerColumns].sort(),
    rowCount: lines.length,
    sha256: hashText(lines.map((l) => l.text).join('')),
  };
}

interface RewrittenLine {
  readonly text: string;
  readonly bigIntegerColumns: readonly string[];
}

function rewriteLines(text: string, table: TableManifest, ctx: AnonymizeContext): RewrittenLine[] {
  const rules = TABLE_RULES[table.name] as Exclude<(typeof TABLE_RULES)[string], 'drop'>;
  const out: RewrittenLine[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    const row = JSON.parse(line) as Row;
    const rewritten: Record<string, PortableValue> = {};
    for (const column of table.columns) {
      const rule = rules[column] as NonNullable<(typeof rules)[string]>;
      rewritten[column] = rule(row[column] ?? null, row, ctx, `${table.name}.${column}`);
    }
    out.push({
      text: `${JSON.stringify(rewritten)}\n`,
      bigIntegerColumns: table.columns.filter((c) => isStringEncodedInteger(rewritten[c] ?? null)),
    });
  }
  return out;
}
