#!/usr/bin/env node
// Release step: folds [Unreleased] and every changelog.d/ fragment into a new
// "## [<version>] - <date>" section of CHANGELOG.md, then deletes the folded
// fragments. It does not bump package.json, tag or push; the release commit
// does those by hand.
//
// Usage: node scripts/fold-changelog.mjs --version <x.y.z> [--date <YYYY-MM-DD>] [--root <dir>]

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { foldFragments } from './lib/changelog-fragments.mjs';
import { fragmentPath, loadFragments, readRelease, rootFromArgs } from './lib/changelog-files.mjs';

function flag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const version = flag('--version');
const date = flag('--date') ?? new Date().toISOString().slice(0, 10);
if (!version || !/^\d+\.\d+\.\d+$/.test(version) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('usage: fold-changelog.mjs --version <x.y.z> [--date <YYYY-MM-DD>] [--root <dir>]');
  process.exit(2);
}

const root = rootFromArgs(process.argv);
const { markdown } = readRelease(root);
const fragments = loadFragments(root);
try {
  writeFileSync(join(root, 'CHANGELOG.md'), foldFragments({ markdown, fragments, version, date }));
} catch (error) {
  console.error(`changelog:fold: ${error.message}`);
  process.exit(1);
}
for (const fragment of fragments) rmSync(fragmentPath(root, fragment.name));
console.warn(`changelog:fold: folded ${fragments.length} fragment(s) into [${version}] - ${date}`);
