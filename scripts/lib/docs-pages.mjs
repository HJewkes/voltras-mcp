// Which files scripts/check-docs.mjs reads, under a given root, so a test can
// point the same listing at a fixture tree.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT_PAGES = ['README.md', 'CLAUDE.md', 'CHANGELOG.md'];
export const SKILL_TREE = 'plugins/voltras-channel/skills';
/** `changelog.d/` fragments reach `/changelog` at the release fold, so they are scanned before it. */
const DOC_TREES = ['site', 'docs', SKILL_TREE, 'changelog.d'];
/** VitePress internals: theme sources and build output, not pages. */
const SKIPPED_DIRS = new Set(['.vitepress', 'node_modules']);

export function collectMarkdown(dir, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectMarkdown(full, found);
    else if (entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

/** Every checked page under `root`, as an absolute path, sorted. */
export function documentedFiles(root) {
  const pages = DOC_TREES.flatMap((tree) => collectMarkdown(join(root, tree)));
  pages.push(...ROOT_PAGES.map((page) => join(root, page)));
  return pages.filter(existsSync).sort();
}

/**
 * A page that records what the tree USED to be. Its entries name tools and
 * files as they were on the day they shipped, and the convention at the top of
 * CHANGELOG.md is that a released entry is not rewritten — so re-pointing its
 * citations at today's tree would be the wrong repair. A fragment is folded
 * into it verbatim, so it is read the same way. Both are still read for the
 * protocol check: `site/changelog.md` renders them, so a value in one reaches a page.
 */
export function historical(page) {
  return page === 'CHANGELOG.md' || page.startsWith('changelog.d/');
}
