// The training store's backup and exit (VW-534).
//
//   npm run store -- export <store-file> <out-dir>
//   npm run store -- import <in-dir> <new-store-file>
//   npm run store -- verify <store-file> <dir-or-second-store>
//
// Engine-neutral on purpose: it reads and writes SQLite today, and the files it
// writes are the half of any later move to another engine that has to be proven
// first. It prints counts and hashes and never a stored value.
//
// The source of an `export` is opened READ-ONLY. `import` refuses to write over
// an existing file. Rehearse on a COPY; see README.md.

import { exportStore } from '../../src/store/portable/export.js';
import { importStore } from '../../src/store/portable/import.js';
import { verifyStore } from '../../src/store/portable/verify.js';

const USAGE = [
  'usage:',
  '  npm run store -- export <store-file> <out-dir>',
  '  npm run store -- import <in-dir> <new-store-file>',
  '  npm run store -- verify <store-file> <dir-or-second-store>',
].join('\n');

async function main(argv: readonly string[]): Promise<number> {
  const [command, first, second] = argv;
  if (command === undefined || first === undefined || second === undefined) {
    console.error(USAGE);
    return 2;
  }
  if (command === 'export') return runExport(first, second);
  if (command === 'import') return runImport(first, second);
  if (command === 'verify') return runVerify(first, second);
  console.error(USAGE);
  return 2;
}

function runExport(storePath: string, outDir: string): number {
  const manifest = exportStore(storePath, outDir);
  console.error(
    `export: schema ${manifest.schemaVersion}, ${manifest.totals.tables} tables, ${manifest.totals.rows} rows -> ${outDir}`,
  );
  return 0;
}

async function runImport(inDir: string, storePath: string): Promise<number> {
  const manifest = await importStore(inDir, storePath);
  console.error(
    `import: schema ${manifest.schemaVersion}, ${manifest.totals.tables} tables, ${manifest.totals.rows} rows -> ${storePath}`,
  );
  return 0;
}

function runVerify(storePath: string, target: string): number {
  const report = verifyStore(storePath, target);
  if (report.equal) {
    console.error('verify: equal');
    return 0;
  }
  for (const line of report.differences) console.error(`verify: ${line}`);
  return 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`error: ${(err as Error).message}`);
    process.exitCode = 1;
  });
