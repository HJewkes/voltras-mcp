#!/usr/bin/env node
// Checks CHANGELOG.md against the convention documented at the top of that
// file, and every fragment under changelog.d/. The rules live in
// scripts/lib/changelog-rules.mjs and scripts/lib/changelog-fragments.mjs;
// this reads the files and prints the findings. No fragments is a pass: a
// change with no user-visible effect adds none.
//
// Usage: node scripts/check-changelog.mjs [--root <dir>]

import { checkFragments } from './lib/changelog-fragments.mjs';
import { loadFragments, readRelease, rootFromArgs } from './lib/changelog-files.mjs';
import { checkChangelog, parseSections } from './lib/changelog-rules.mjs';

const root = rootFromArgs(process.argv);
const { version, markdown } = readRelease(root);
const fragments = loadFragments(root);
const findings = [
  ...checkChangelog({ version, markdown }).map((finding) => ({ file: 'CHANGELOG.md', ...finding })),
  ...checkFragments(fragments),
];

// Transition fallback (VW-704): entries written straight into [Unreleased] still pass.
if (parseSections(markdown).some((section) => section.isUnreleased && section.body !== '')) {
  console.warn(
    'changelog: [Unreleased] still holds entries written in place; new entries go in changelog.d/',
  );
}

if (findings.length === 0) {
  console.warn(`changelog: OK (version ${version}, ${fragments.length} fragment(s))`);
  process.exit(0);
}

for (const finding of findings) {
  const where = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
  console.error(`${where}: ${finding.message}`);
}
console.error(`\n${findings.length} changelog finding(s).`);
process.exit(1);
