// File access shared by check-changelog.mjs and fold-changelog.mjs. The rules
// themselves are pure and live in changelog-rules.mjs and changelog-fragments.mjs.

import { execFileSync } from 'node:child_process';
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

/** `--base <ref>` from argv, else the pull request base CI names; undefined outside a pull request. */
export function baseFromArgs(argv, env) {
  const index = argv.indexOf('--base');
  if (index !== -1) return argv[index + 1];
  return env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : undefined;
}

/** Files changed between the merge base with `base` and HEAD, as `{ status, path }`. */
export function changedFiles(root, base) {
  const out = execFileSync('git', ['diff', '--name-status', '--no-renames', `${base}...HEAD`], {
    cwd: root,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [status, path] = line.split('\t');
      return { status, path };
    });
}
