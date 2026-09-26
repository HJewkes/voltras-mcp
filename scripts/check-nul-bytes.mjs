#!/usr/bin/env node
// Fails if any tracked text file under src/, scripts/, docs/, tools/ or
// packages/ contains a literal NUL byte (VW-223). See scripts/lib/nul-byte-check.mjs
// for why this matters: a NUL byte hides a file from plain `grep -r`.
//
// Usage: node scripts/check-nul-bytes.mjs

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findNulByteFiles } from './lib/nul-byte-check.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCANNED_ROOTS = ['src', 'scripts', 'docs', 'tools', 'packages'];

const { stdout, status } = spawnSync('git', ['ls-files', ...SCANNED_ROOTS], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
});
if (status !== 0) {
  console.error('check-nul-bytes: `git ls-files` failed');
  process.exit(1);
}

const paths = stdout.split('\n').filter(Boolean);
const files = paths.map((path) => ({ path, buffer: readFileSync(join(REPO_ROOT, path)) }));
const findings = findNulByteFiles(files);

if (findings.length === 0) {
  console.warn(`nul-bytes: OK (${paths.length} file(s) scanned)`);
  process.exit(0);
}

for (const { path, offset } of findings) {
  console.error(`${path}: NUL byte at offset ${offset}`);
}
console.error(`\n${findings.length} file(s) with a NUL byte.`);
process.exit(1);
