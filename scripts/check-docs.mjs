#!/usr/bin/env node
// Documentation accuracy check: every claim on a published page must cite a
// file, a line or a tool that exists on `main`, and no page may carry an
// encoded device value.
//
// Four checks, over `site/**/*.md`, `docs/**/*.md`, the pt-session skill under
// `plugins/`, `README.md`, `CLAUDE.md` and `CHANGELOG.md` (which
// `site/changelog.md` now renders):
//
//   1. path      a cited repo path resolves                      FAILS
//   2. line      a cited `file.ts:NNN` is within the file        FAILS
//   3. tool      a cited `namespace.tool` is registered          FAILS
//   4. protocol  an encoded device value reached a page          FAILS
//
// Check 3 runs in both directions over the pt-session skill, which ships in
// this repo so it cannot be older than the server (VW-503): a name the skill
// uses must be registered, AND a registered tool must be named somewhere in
// the skill or listed in `SKILL_IGNORED_TOOLS` with its reason.
//
// Check 2 has a second, weaker half: a citation whose target line has CHANGED
// since the citation was written is stale even though the line still exists.
// Whether the line still SAYS the right thing is not mechanisable, so this can
// only ever WARN. It is opt-in behind `--stale-lines`, and not for speed — it
// costs about four seconds over the 108 line citations in this tree. It is
// opt-in because it walks history, and CI checks out one commit: under a
// shallow clone it would quietly find nothing and read as a pass. Run it during
// a docs pass, where the warnings are for a human anyway.
//
// Usage: node scripts/check-docs.mjs [--stale-lines]

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  checkPathCitations,
  checkProtocolLeakage,
  checkToolCoverage,
  checkToolNames,
  extractPathCitations,
} from './lib/docs-checks.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD_SOURCE = join(REPO_ROOT, 'src/docs/protocol-guard.ts');
const GUARD_BUILT = join(REPO_ROOT, 'dist/docs/protocol-guard.js');
const ROOT_PAGES = ['README.md', 'CLAUDE.md', 'CHANGELOG.md'];
const SKILL_TREE = 'plugins/voltras-channel/skills';
const DOC_TREES = ['site', 'docs', SKILL_TREE];
/** VitePress internals: theme sources and build output, not pages. */
const SKIPPED_DIRS = new Set(['.vitepress', 'node_modules']);

/**
 * Reviewed exceptions to check 4, as `path:token`. An entry is a decision, not
 * a threshold: it says a human looked at this token on this page and it is not
 * a device value.
 */
const ALLOWED_TOKENS = new Set([
  // A truncated example UUID in a sample `set_ended` payload. Bare hex runs are
  // flagged because a hex run and a truncated id are the same shape; this one
  // is an id the doc made up.
  // eslint-disable-next-line voltras/no-protocol-detail -- a reviewed docs exception recorded as data, not a device value (VW-497)
  'docs/push-events.md:3f2a1b04',
]);

/**
 * A page that records what the tree USED to be. Its entries name tools and
 * files as they were on the day they shipped, and the convention at the top of
 * CHANGELOG.md is that a released entry is not rewritten — so re-pointing its
 * citations at today's tree would be the wrong repair. It is still read for
 * check 4: `site/changelog.md` renders it, so a value in it reaches a page.
 */
function historical(page) {
  return page === 'CHANGELOG.md';
}

function collectMarkdown(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectMarkdown(full, found);
    else if (entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

function documentedFiles() {
  const pages = DOC_TREES.flatMap((tree) => collectMarkdown(join(REPO_ROOT, tree)));
  pages.push(...ROOT_PAGES.map((page) => join(REPO_ROOT, page)));
  return pages.filter(existsSync).sort();
}

/** The quoted names in one exported array literal, read as text. */
function readNameArray(file, exported) {
  const text = readFileSync(join(REPO_ROOT, file), 'utf8');
  const start = text.indexOf(`export const ${exported}`);
  if (start === -1) throw new Error(`${file} no longer exports ${exported}`);
  const end = text.indexOf('];', start);
  const names = [...text.slice(start, end).matchAll(/'([a-z][a-z0-9_.]*)'/g)].map(
    (match) => match[1],
  );
  if (names.length === 0) throw new Error(`${file}: ${exported} parsed to an empty list`);
  return names;
}

/**
 * Tool names as the registry lists them; the source of truth for check 3. Read
 * as text rather than imported, so the check needs no build — and the registry
 * is already pinned against the live server by `scripts/gen-tool-reference.mjs`.
 */
function readRegistry() {
  return new Set([
    ...readNameArray('src/tool-registry.ts', 'CORE_TOOL_NAMES'),
    ...readNameArray('src/tool-registry.ts', 'MOCK_TOOL_NAMES'),
  ]);
}

/**
 * The shared guard's encoded-value half. Reuses `dist` when it is current and
 * otherwise compiles that one module — it imports nothing, so this costs under
 * a second and never needs a full build in the lint job.
 */
async function loadEncodedValueDetector() {
  const builtIsCurrent =
    existsSync(GUARD_BUILT) && statSync(GUARD_BUILT).mtimeMs >= statSync(GUARD_SOURCE).mtimeMs;
  if (builtIsCurrent) return (await import(pathToFileURL(GUARD_BUILT))).findEncodedValues;

  const scratch = mkdtempSync(join(tmpdir(), 'vmcp-docs-guard-'));
  try {
    const tsc = spawnSync(
      'npx',
      ['tsc', '--ignoreConfig', GUARD_SOURCE, '--outDir', scratch, '--target', 'es2022'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    if (tsc.status !== 0) throw new Error(`could not compile the protocol guard:\n${tsc.stdout}`);
    return (await import(pathToFileURL(join(scratch, 'protocol-guard.js')))).findEncodedValues;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function resolveInRepo(citation) {
  const full = join(REPO_ROOT, citation);
  if (!existsSync(full)) return { kind: 'missing', lineCount: 0 };
  if (statSync(full).isDirectory()) return { kind: 'directory', lineCount: 0 };
  return { kind: 'file', lineCount: readFileSync(full, 'utf8').split('\n').length };
}

function gitLines(args) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout.split('\n').filter(Boolean);
}

/**
 * A citation is stale when its target line has changed since the commit that
 * last wrote the citation. Two history walks per citation, which is why this is
 * opt-in; it can only produce warnings, because a line that moved may still say
 * the right thing.
 */
function findStaleCitations(page, citations) {
  const warnings = [];
  for (const citation of citations.filter((entry) => entry.lines.length > 0)) {
    const [written] = gitLines([
      'log',
      '-s',
      '-1',
      '--format=%H',
      `-L${citation.line},${citation.line}:${page}`,
    ]);
    if (written === undefined) continue;
    const target = Math.min(...citation.lines);
    const since = gitLines([
      'log',
      '-s',
      '--format=%H',
      `-L${target},${target}:${citation.path}`,
      `${written}..HEAD`,
    ]);
    if (since.length === 0) continue;
    warnings.push({
      line: citation.line,
      check: 'stale',
      message: `${citation.path}:${target} changed in ${since.length} commit(s) since this citation was written`,
    });
  }
  return warnings;
}

function report(label, byFile) {
  const total = [...byFile.values()].reduce((sum, findings) => sum + findings.length, 0);
  if (total === 0) return 0;
  console.error(`\n${label} (${total}):`);
  for (const [page, findings] of byFile) {
    console.error(`\n  ${page}`);
    for (const finding of findings.sort((a, b) => a.line - b.line)) {
      console.error(`    ${page}:${finding.line}  [${finding.check}] ${finding.message}`);
    }
  }
  return total;
}

/**
 * Every registered tool the coach skill never names. The skill is the coach's
 * whole map of the surface, so a tool missing from it is unreachable even
 * though it is registered.
 */
function findUncoveredTools(registry) {
  const pages = collectMarkdown(join(REPO_ROOT, SKILL_TREE));
  const ignored = new Set(
    readNameArray('src/docs/skill-inventory-notes.ts', 'SKILL_IGNORED_TOOLS'),
  );
  return checkToolCoverage(
    pages.map((page) => readFileSync(page, 'utf8')),
    registry,
    ignored,
  );
}

function reportCoverage(findings) {
  if (findings.length === 0) return 0;
  console.error(`\nFINDINGS — tools the coach skill does not name (${findings.length}):`);
  for (const finding of findings) console.error(`    [${finding.check}] ${finding.message}`);
  return findings.length;
}

/** A shallow clone has no history to walk, so silence there means nothing. */
function warnIfShallow() {
  const [shallow] = gitLines(['rev-parse', '--is-shallow-repository']);
  if (shallow !== 'true') return;
  console.error('--stale-lines needs full history; this clone is shallow, so nothing was walked.');
}

async function main() {
  const staleLines = process.argv.includes('--stale-lines');
  if (staleLines) warnIfShallow();
  const registry = readRegistry();
  const findEncodedValues = await loadEncodedValueDetector();
  const repoRoots = new Set(readdirSync(REPO_ROOT));

  const pipelines = new Set(
    readNameArray('src/docs/public-vocabulary.ts', 'ANALYTICS_PIPELINE_IDS'),
  );

  const failures = new Map();
  const warnings = new Map();
  for (const file of documentedFiles()) {
    const page = relative(REPO_ROOT, file);
    const text = readFileSync(file, 'utf8');
    const citations = historical(page) ? [] : extractPathCitations(text, repoRoots);
    const found = [
      ...checkPathCitations(citations, resolveInRepo),
      ...(historical(page) ? [] : checkToolNames(text, registry, pipelines)),
      ...checkProtocolLeakage(text, { path: page, findEncodedValues, allowed: ALLOWED_TOKENS }),
    ];
    if (found.length > 0) failures.set(page, found);
    if (!staleLines) continue;
    const stale = findStaleCitations(page, citations);
    if (stale.length > 0) warnings.set(page, stale);
  }

  const warned = report('WARNINGS — citations whose target line moved', warnings);
  const onPages = report('FINDINGS', failures);
  const uncovered = reportCoverage(findUncoveredTools(registry));
  if (onPages + uncovered === 0) {
    console.warn(`docs: OK (${documentedFiles().length} pages, ${warned} warning(s))`);
    return;
  }
  console.error(
    `\n${onPages} finding(s) across ${failures.size} file(s), ${uncovered} uncovered tool(s).`,
  );
  process.exitCode = 1;
}

await main();
