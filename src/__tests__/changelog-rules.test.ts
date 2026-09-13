// Unit tests for the changelog convention check
// (scripts/lib/changelog-rules.mjs), plus one assertion that the real
// CHANGELOG.md satisfies it.
//
// Each case is a mistake the convention is meant to catch: a version bumped
// without a section, sections out of order, a released heading with nothing
// under it. The empty `[Unreleased]` case asserts the deliberate non-finding.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { checkChangelog, parseSections } from '../../scripts/lib/changelog-rules.mjs';

const HEADER = '# Changelog\n\nIntro prose.\n';

function changelog(...sections: string[]): string {
  return `${HEADER}\n${sections.join('\n')}`;
}

const UNRELEASED_EMPTY = '## [Unreleased]\n';
const RELEASED_0_5_0 = '## [0.5.0] - 2026-09-08\n\n### Added\n\n- A thing (#244)\n';
const RELEASED_0_4_0 = '## [0.4.0] - 2026-08-30\n\n### Fixed\n\n- Another thing (#200)\n';

describe('checkChangelog', () => {
  it('passes a changelog whose newest release matches package.json', () => {
    const findings = checkChangelog({
      version: '0.5.0',
      markdown: changelog(UNRELEASED_EMPTY, RELEASED_0_5_0, RELEASED_0_4_0),
    });
    expect(findings).toEqual([]);
  });

  it('does not treat an empty [Unreleased] as a finding', () => {
    const findings = checkChangelog({
      version: '0.4.0',
      markdown: changelog(UNRELEASED_EMPTY, RELEASED_0_4_0),
    });
    expect(findings).toEqual([]);
  });

  it('reports a version bump with no matching section', () => {
    const findings = checkChangelog({
      version: '0.6.0',
      markdown: changelog(UNRELEASED_EMPTY, RELEASED_0_5_0),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('0.6.0');
  });

  it('reports sections that do not run newest first', () => {
    const findings = checkChangelog({
      version: '0.5.0',
      markdown: changelog(UNRELEASED_EMPTY, RELEASED_0_4_0, RELEASED_0_5_0),
    });
    expect(findings.map((finding) => finding.message)).toEqual([
      expect.stringContaining('0.5.0 is newer than 0.4.0'),
    ]);
  });

  it('reports a repeated version heading', () => {
    const findings = checkChangelog({
      version: '0.5.0',
      markdown: changelog(RELEASED_0_5_0, RELEASED_0_5_0),
    });
    expect(findings.map((finding) => finding.message)).toEqual([
      expect.stringContaining('0.5.0 duplicates 0.5.0'),
    ]);
  });

  it('reports a released section with nothing under it', () => {
    const findings = checkChangelog({
      version: '0.5.0',
      markdown: changelog(UNRELEASED_EMPTY, '## [0.5.0] - 2026-09-08\n', RELEASED_0_4_0),
    });
    expect(findings.map((finding) => finding.message)).toEqual([
      expect.stringContaining('[0.5.0] is empty'),
    ]);
  });

  it('reports [Unreleased] below a released section', () => {
    const findings = checkChangelog({
      version: '0.5.0',
      markdown: changelog(RELEASED_0_5_0, UNRELEASED_EMPTY),
    });
    expect(findings.map((finding) => finding.message)).toEqual([
      expect.stringContaining('[Unreleased] must be the first section'),
    ]);
  });

  it('ignores prose headings such as "## Earlier history"', () => {
    const findings = checkChangelog({
      version: '0.5.0',
      markdown: changelog(UNRELEASED_EMPTY, RELEASED_0_5_0, '## Earlier history\n\nSee git log.\n'),
    });
    expect(findings).toEqual([]);
  });

  it('holds for the real CHANGELOG.md', () => {
    const root = new URL('../../', import.meta.url);
    const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
    const markdown = readFileSync(new URL('CHANGELOG.md', root), 'utf8');
    expect(checkChangelog({ version, markdown })).toEqual([]);
  });
});

describe('parseSections', () => {
  it('keeps the body that belongs to each heading', () => {
    const [unreleased, released] = parseSections(changelog(UNRELEASED_EMPTY, RELEASED_0_5_0));
    expect(unreleased.isUnreleased).toBe(true);
    expect(unreleased.body).toBe('');
    expect(released.version).toBe('0.5.0');
    expect(released.body).toContain('A thing (#244)');
  });
});
