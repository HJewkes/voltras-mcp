// Changelog fragments (VW-704): the fragment format, the release fold, the two
// scripts run against fixture trees, and the reason fragments exist at all:
// two pull requests that each add one merge without a conflict.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import prettier from 'prettier';
import { afterEach, describe, expect, it } from 'vitest';

import {
  checkFragments,
  foldFragments,
  parseFragment,
} from '../../scripts/lib/changelog-fragments.mjs';
import { loadFragments } from '../../scripts/lib/changelog-files.mjs';
import { checkChangelog } from '../../scripts/lib/changelog-rules.mjs';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const CHECK_SCRIPT = join(REPO_ROOT, 'scripts/check-changelog.mjs');
const FOLD_SCRIPT = join(REPO_ROOT, 'scripts/fold-changelog.mjs');

function fragment(section: string, entry: string): string {
  return `---\nsection: ${section}\n---\n\n${entry}\n`;
}

const FIXTURE_CHANGELOG = [
  '# Changelog',
  '',
  'Intro prose.',
  '',
  '## [Unreleased]',
  '',
  '### Added',
  '',
  '- Written in place, first (VW-1).',
  '',
  '### Fixed',
  '',
  '- Written in place, a fix (VW-2).',
  '',
  '### Added',
  '',
  '- Written in place, under a repeated heading (VW-3).',
  '',
  '## [0.5.0] - 2026-09-08',
  '',
  '### Added',
  '',
  '- A released thing (#244).',
  '',
].join('\n');

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vw704-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseFragment', () => {
  it('reads the section and entry of a valid fragment', () => {
    const parsed = parseFragment('VW-9.md', fragment('Fixed', '- A fix (VW-9).'));
    expect(parsed).toEqual({
      name: 'VW-9.md',
      section: 'Fixed',
      body: '- A fix (VW-9).',
      problems: [],
    });
  });

  it.each([
    ['no front matter', 'VW-9.md', '- A fix (VW-9).\n', 'must open with front matter'],
    ['an unknown group', 'VW-9.md', fragment('Tweaked', '- A fix.'), 'section "Tweaked"'],
    [
      'an unknown key',
      'VW-9.md',
      '---\nsection: Fixed\npr: 4\n---\n\n- A fix.\n',
      'unknown front matter key "pr"',
    ],
    ['no section', 'VW-9.md', '---\n\n---\n\n- A fix.\n', 'needs "section:"'],
    ['no entry', 'VW-9.md', fragment('Fixed', ''), 'no entry'],
    ['prose, not a list item', 'VW-9.md', fragment('Fixed', 'A fix.'), 'list item'],
    ['its own heading', 'VW-9.md', fragment('Fixed', '- A fix.\n\n### Fixed'), 'no headings'],
    ['a name with a space', 'my fix.md', fragment('Fixed', '- A fix.'), 'name a fragment'],
  ])('reports a fragment with %s', (_label, name, text, expected) => {
    const findings = checkFragments([parseFragment(name, text)]);
    expect(findings.map((finding: { message: string }) => finding.message)).toEqual(
      expect.arrayContaining([expect.stringContaining(expected)]),
    );
  });
});

describe('checkFragments', () => {
  it('refuses two fragments whose names differ only in case, since both would fold', () => {
    const findings = checkFragments([
      parseFragment('VW-420.md', fragment('Fixed', '- A fix (VW-420).')),
      parseFragment('vw-420.md', fragment('Fixed', '- The same fix again (VW-420).')),
    ]);
    expect(findings).toEqual([
      {
        file: 'changelog.d/vw-420.md',
        line: null,
        message: expect.stringContaining('same name as changelog.d/VW-420.md apart from case'),
      },
    ]);
  });

  it('accepts fragments for different tickets', () => {
    const findings = checkFragments([
      parseFragment('VW-420.md', fragment('Fixed', '- A fix (VW-420).')),
      parseFragment('VW-421.md', fragment('Fixed', '- Another fix (VW-421).')),
    ]);
    expect(findings).toEqual([]);
  });
});

describe('the real changelog.d', () => {
  it('holds only valid fragments', () => {
    expect(checkFragments(loadFragments(REPO_ROOT))).toEqual([]);
  });

  it('holds only files the pre-commit prettier pass leaves unchanged', async () => {
    const options = {
      ...(await prettier.resolveConfig(join(REPO_ROOT, 'CHANGELOG.md'))),
      parser: 'markdown',
    };
    for (const { name } of loadFragments(REPO_ROOT)) {
      const text = readFileSync(join(REPO_ROOT, 'changelog.d', name), 'utf8');
      expect(await prettier.check(text, options), name).toBe(true);
    }
  });
});

describe('foldFragments', () => {
  const fragments = [
    parseFragment('VW-20.md', fragment('Fixed', '- A fragment fix (VW-20).')),
    parseFragment('VW-10.md', fragment('Added', '- A fragment feature (VW-10).')),
    parseFragment('VW-11.md', fragment('Removed', '- A fragment removal (VW-11).')),
  ];

  it('moves [Unreleased] and the fragments into a dated version section', () => {
    const folded = foldFragments({
      markdown: FIXTURE_CHANGELOG,
      fragments,
      version: '0.6.0',
      date: '2026-10-01',
    });

    expect(folded).toBe(
      [
        '# Changelog',
        '',
        'Intro prose.',
        '',
        '## [Unreleased]',
        '',
        '## [0.6.0] - 2026-10-01',
        '',
        '### Added',
        '',
        '- A fragment feature (VW-10).',
        '',
        '- Written in place, first (VW-1).',
        '',
        '- Written in place, under a repeated heading (VW-3).',
        '',
        '### Removed',
        '',
        '- A fragment removal (VW-11).',
        '',
        '### Fixed',
        '',
        '- A fragment fix (VW-20).',
        '',
        '- Written in place, a fix (VW-2).',
        '',
        '## [0.5.0] - 2026-09-08',
        '',
        '### Added',
        '',
        '- A released thing (#244).',
        '',
      ].join('\n'),
    );
  });

  it('produces a changelog the check and prettier both accept', async () => {
    const folded = foldFragments({
      markdown: FIXTURE_CHANGELOG,
      fragments,
      version: '0.6.0',
      date: '2026-10-01',
    });

    expect(checkChangelog({ version: '0.6.0', markdown: folded })).toEqual([]);
    expect(await prettier.check(folded, { parser: 'markdown' })).toBe(true);
  });

  it('refuses to fold an invalid fragment', () => {
    const broken = [parseFragment('VW-5.md', fragment('Tweaked', '- A thing.'))];
    expect(() =>
      foldFragments({
        markdown: FIXTURE_CHANGELOG,
        fragments: broken,
        version: '0.6.0',
        date: '2026-10-01',
      }),
    ).toThrow(/Tweaked/);
  });

  it('refuses to cut a release with nothing in it', () => {
    const empty = '# Changelog\n\n## [Unreleased]\n\n## [0.5.0] - 2026-09-08\n\n- A thing.\n';
    expect(() =>
      foldFragments({ markdown: empty, fragments: [], version: '0.6.0', date: '2026-10-01' }),
    ).toThrow(/nothing to release/);
  });
});

function fixtureTree(fragmentFiles: Record<string, string>): string {
  const root = scratch();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.5.0' }));
  writeFileSync(join(root, 'CHANGELOG.md'), FIXTURE_CHANGELOG);
  mkdirSync(join(root, 'changelog.d'));
  writeFileSync(join(root, 'changelog.d', 'README.md'), '# Changelog fragments\n');
  for (const [name, text] of Object.entries(fragmentFiles))
    writeFileSync(join(root, 'changelog.d', name), text);
  return root;
}

function runScript(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

describe('scripts on a fixture tree', () => {
  it('check passes a tree with no fragments, as for a change with no user-visible effect', () => {
    const result = runScript(CHECK_SCRIPT, ['--root', fixtureTree({})]);
    expect(result.status).toBe(0);
  });

  it('check fails a tree holding an invalid fragment and names the file', () => {
    const result = runScript(CHECK_SCRIPT, [
      '--root',
      fixtureTree({ 'VW-5.md': '- no front matter\n' }),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('changelog.d/VW-5.md');
  });

  it('fold writes the release and deletes the folded fragments but not the README', () => {
    const root = fixtureTree({ 'VW-20.md': fragment('Fixed', '- A fragment fix (VW-20).') });

    const result = runScript(FOLD_SCRIPT, [
      '--version',
      '0.6.0',
      '--date',
      '2026-10-01',
      '--root',
      root,
    ]);

    expect(result.status).toBe(0);
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toContain(
      '## [0.6.0] - 2026-10-01\n\n### Added',
    );
    expect(existsSync(join(root, 'changelog.d', 'VW-20.md'))).toBe(false);
    expect(existsSync(join(root, 'changelog.d', 'README.md'))).toBe(true);
  });
});

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function git(repo: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    {
      cwd: repo,
      env: GIT_ENV,
      encoding: 'utf8',
    },
  );
}

function commitOnBranch(repo: string, branch: string, path: string, text: string): void {
  git(repo, 'checkout', '-q', '-b', branch, 'main');
  writeFileSync(join(repo, path), text);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', branch);
}

function mergeTree(repo: string): number | null {
  return spawnSync('git', ['merge-tree', '--write-tree', 'first', 'second'], {
    cwd: repo,
    env: GIT_ENV,
  }).status;
}

function repoWithChangelog(): string {
  const repo = scratch();
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'CHANGELOG.md'), FIXTURE_CHANGELOG);
  mkdirSync(join(repo, 'changelog.d'));
  writeFileSync(join(repo, 'changelog.d', 'README.md'), '# Changelog fragments\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  return repo;
}

describe('two pull requests with changelog entries', () => {
  it('merge cleanly when each adds a fragment', () => {
    const repo = repoWithChangelog();
    commitOnBranch(
      repo,
      'first',
      'changelog.d/VW-30.md',
      fragment('Fixed', '- First fix (VW-30).'),
    );
    commitOnBranch(
      repo,
      'second',
      'changelog.d/VW-31.md',
      fragment('Fixed', '- Second fix (VW-31).'),
    );

    expect(mergeTree(repo)).toBe(0);
  });

  it('conflict when each edits the same [Unreleased] group, which is why fragments exist', () => {
    const repo = repoWithChangelog();
    const withEntry = (entry: string) =>
      FIXTURE_CHANGELOG.replace('### Fixed\n\n', `### Fixed\n\n${entry}\n\n`);
    commitOnBranch(repo, 'first', 'CHANGELOG.md', withEntry('- First fix (VW-30).'));
    commitOnBranch(repo, 'second', 'CHANGELOG.md', withEntry('- Second fix (VW-31).'));

    expect(mergeTree(repo)).toBe(1);
  });
});
