// File access shared by check-changelog.mjs and fold-changelog.mjs. The rules
// themselves are pure and live in changelog-rules.mjs and changelog-fragments.mjs.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FRAGMENT_DIR, NOT_FRAGMENTS, parseFragment } from './changelog-fragments.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `--root <dir>` from argv, else the repository root; fixtures use the flag. */
export function rootFromArgs(argv) {
  const index = argv.indexOf('--root');
  return index === -1 ? REPO_ROOT : resolve(argv[index + 1]);
}

export function fragmentPath(root, name) {
  return join(root, FRAGMENT_DIR, name);
}

/** Every fragment under `<root>/changelog.d`, parsed; an absent directory holds none. */
export function loadFragments(root) {
  const dir = join(root, FRAGMENT_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !NOT_FRAGMENTS.has(entry.name))
    .map((entry) => parseFragment(entry.name, readFileSync(join(dir, entry.name), 'utf8')))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readRelease(root) {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const markdown = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  return { version, markdown };
}
