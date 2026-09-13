#!/usr/bin/env node
// Checks CHANGELOG.md against the convention documented at the top of that
// file. The rules live in scripts/lib/changelog-rules.mjs; this reads the two
// files and prints the findings.
//
// Usage: node scripts/check-changelog.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkChangelog } from './lib/changelog-rules.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG_PATH = join(REPO_ROOT, 'CHANGELOG.md');

const { version } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const findings = checkChangelog({ version, markdown: readFileSync(CHANGELOG_PATH, 'utf8') });

if (findings.length === 0) {
  console.warn(`changelog: OK (version ${version})`);
  process.exit(0);
}

for (const finding of findings) {
  const where = finding.line === null ? 'CHANGELOG.md' : `CHANGELOG.md:${finding.line}`;
  console.error(`${where}: ${finding.message}`);
}
console.error(`\n${findings.length} changelog finding(s).`);
process.exit(1);
