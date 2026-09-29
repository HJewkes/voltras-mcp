#!/usr/bin/env node
// Runs the confidentiality rule over every tracked text file, markdown and site
// sources included (VW-497). See scripts/lib/text-confidentiality.mjs.
//
// Usage: node scripts/check-text-confidentiality.mjs

import { lstatSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isScanned, scanText } from './lib/text-confidentiality.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function trackedFiles() {
  const { stdout, status } = spawnSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (status !== 0) {
    console.error('text-confidentiality: `git ls-files` failed');
    process.exit(1);
  }
  return stdout.split('\0').filter(Boolean);
}

// A symlink is scanned at its target, so following it would count a file twice.
const isRegularFile = (path) =>
  lstatSync(join(REPO_ROOT, path), { throwIfNoEntry: false })?.isFile();

const paths = trackedFiles().filter((path) => isScanned(path) && isRegularFile(path));
let total = 0;
for (const path of paths) {
  for (const { line, column, kind } of scanText(readFileSync(join(REPO_ROOT, path), 'utf8'))) {
    console.error(`${path}:${line}:${column}  ${kind} (voltras/no-protocol-detail)`);
    total += 1;
  }
}

if (total === 0) {
  console.warn(`text-confidentiality: OK (${paths.length} file(s) scanned)`);
  process.exit(0);
}
console.error(
  `\n${total} finding(s). Describe the observable behaviour instead, and keep protocol-derived findings in the private research tree.`,
);
process.exit(1);
