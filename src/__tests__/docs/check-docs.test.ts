// Unit tests for the documentation accuracy check (scripts/lib/docs-checks.mjs
// and the encoded-value half of src/docs/protocol-guard.ts).
//
// Half of these assert what the checks DO NOT fire on. A guard that cries wolf
// on prose gets deleted, and then nothing is checked at all, so every exclusion
// the checker needed is pinned here with the shape that motivated it.
//
// Every protocol-shaped fixture below is SYNTHETIC — invented for this file,
// matching no value this device uses. A guard whose test fixtures are real
// values publishes the thing it exists to keep unpublished.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  checkPageFrontmatter,
  checkPathCitations,
  checkProtocolLeakage,
  checkToolCoverage,
  checkToolNames,
  extractPathCitations,
} from '../../../scripts/lib/docs-checks.mjs';
import { documentedFiles, historical } from '../../../scripts/lib/docs-pages.mjs';
import { findEncodedValues } from '../../docs/protocol-guard.js';
import { ANALYTICS_PIPELINE_IDS } from '../../docs/public-vocabulary.js';

const REPO_ROOT = new URL('../../../', import.meta.url);
const REPO_ROOTS = new Set(['src', 'scripts', 'site', 'docs', 'package.json']);
const REGISTRY = new Set([
  'device.set_weight',
  'device.get_state',
  'plan.exercise.create',
  'server.health',
  'session.start',
  'system.lease_acquire',
]);

function paths(text: string): string[] {
  return extractPathCitations(text, REPO_ROOTS).map((citation) => citation.path);
}

function toolMessages(text: string): string[] {
  return checkToolNames(text, REGISTRY, new Set(ANALYTICS_PIPELINE_IDS)).map(
    (finding) => finding.message,
  );
}

describe('extractPathCitations', () => {
  it('takes a repo-rooted path with a known extension', () => {
    expect(paths('see `src/tools/device-tools.ts` for the handler')).toEqual([
      'src/tools/device-tools.ts',
    ]);
  });

  it('records the line numbers a citation names, ranges included', () => {
    const [citation] = extractPathCitations('`scripts/a.mjs:28-45,94` drives it', REPO_ROOTS);
    expect(citation.lines).toEqual([28, 45, 94]);
  });

  it('drops the sentence punctuation after a citation', () => {
    expect(paths('lives in src/server.ts.')).toEqual(['src/server.ts']);
  });

  it('ignores a path inside a URL', () => {
    expect(paths('see https://example.com/src/server.ts for more')).toEqual([]);
  });

  it('ignores a path whose root is not a top-level entry of this repo', () => {
    expect(paths('`voltra-node-sdk/src/index.ts` is published separately')).toEqual([]);
  });

  it('ignores build output, which no clean checkout has', () => {
    expect(paths('run `dist/bin.js`')).toEqual([]);
  });

  it('ignores a glob, which names no one file', () => {
    expect(paths('`src/**/*.test.ts` are excluded')).toEqual([]);
  });

  it('ignores prose that merely contains a slash and a dot', () => {
    expect(paths('a 1.5x/2.0x ratio, and the push/pull split')).toEqual([]);
  });

  it('takes a directory citation', () => {
    expect(paths('`src/tools/` holds the handlers')).toEqual(['src/tools/']);
  });
});

describe('checkPathCitations', () => {
  const resolve = (path: string) =>
    path === 'src/errors.ts' ? { kind: 'file', lineCount: 28 } : { kind: 'missing', lineCount: 0 };

  it('reports a path that does not resolve', () => {
    const citations = extractPathCitations('`src/tools/gone.ts` does it', REPO_ROOTS);
    expect(checkPathCitations(citations, resolve)[0].message).toContain('no such file');
  });

  it('reports a line citation past the end of the file', () => {
    const citations = extractPathCitations('`src/errors.ts:99999` does it', REPO_ROOTS);
    expect(checkPathCitations(citations, resolve)[0]).toMatchObject({
      check: 'line',
      message: expect.stringContaining('has 28 lines; cited line 99999'),
    });
  });

  it('accepts a line citation inside the file', () => {
    const citations = extractPathCitations('`src/errors.ts:12` does it', REPO_ROOTS);
    expect(checkPathCitations(citations, resolve)).toEqual([]);
  });
});

describe('checkToolNames', () => {
  it('reports a tool that was never registered', () => {
    expect(toolMessages('call `session.frobnicate` to finish')).toEqual([
      'no such tool: session.frobnicate',
    ]);
  });

  it('accepts a registered tool', () => {
    expect(toolMessages('call `device.set_weight` first')).toEqual([]);
  });

  it('ignores a namespace the registry does not have', () => {
    expect(toolMessages('the `quality.bounce` pipeline and `foo.bar_baz`')).toEqual([]);
  });

  it('ignores a `metrics.compute` pipeline id that opens with a tool namespace', () => {
    expect(toolMessages('run `session.readiness` over the week')).toEqual([]);
  });

  it('ignores a file name whose stem is a namespace', () => {
    expect(toolMessages('`server.ts` binds the port')).toEqual([]);
  });

  it('ignores a name markdown truncated to a prefix of a real tool', () => {
    expect(toolMessages('the device.set*isokinetic* setters')).toEqual([]);
  });

  it('ignores a field of a registered tool output', () => {
    expect(toolMessages('`device.get_state.load_state` stays unloaded')).toEqual([]);
  });

  it('ignores prose shorthand that is the tail of a registered name', () => {
    expect(toolMessages('`exercise.create` returns advisory warnings')).toEqual([]);
  });

  it('ignores a truncation left by a trailing wildcard', () => {
    expect(toolMessages('one client at a time (`system.lease_*`)')).toEqual([]);
  });
});

describe('checkProtocolLeakage', () => {
  const options = { path: 'docs/a.md', findEncodedValues, allowed: new Set<string>() };

  it('reports a synthetic byte run on a page', () => {
    const findings = checkProtocolLeakage('the frame reads `de ad be ef` here', options);
    expect(findings).toEqual([
      { line: 1, check: 'protocol', message: 'byte-sequence shaped token on a published page' },
    ]);
  });

  it('never puts the token in the message, because a CI log is public too', () => {
    const [finding] = checkProtocolLeakage('`de ad be ef`', options);
    expect(finding.message).not.toContain('de ad be ef');
  });

  it('reports the line the value is on', () => {
    const findings = checkProtocolLeakage('one\ntwo\n`0xbeef` three', options);
    expect(findings[0].line).toBe(3);
  });

  it('honours a reviewed allowlist entry for that page and token', () => {
    const allowed = new Set(['docs/a.md:0xbeef']);
    expect(checkProtocolLeakage('`0xbeef`', { ...options, allowed })).toEqual([]);
  });

  it('does not fire on a multi-line source citation', () => {
    expect(checkProtocolLeakage('`src/state/thing.ts:36-37,76` says so', options)).toEqual([]);
  });

  it('fires on a synthetic command code', () => {
    const findings = checkProtocolLeakage('writes cmd_5e to the unit', options);
    expect(findings[0].message).toContain('command-code');
  });
});

describe('documentedFiles', () => {
  it('scans a changelog fragment, so a value in one fails before the release fold', () => {
    const root = mkdtempSync(join(tmpdir(), 'vw704-docs-'));
    try {
      mkdirSync(join(root, 'changelog.d'));
      writeFileSync(
        join(root, 'changelog.d', 'VW-1.md'),
        '---\nsection: Fixed\n---\n\n- The frame now reads `de ad be ef` (VW-1).\n',
      );

      const findings = documentedFiles(root).flatMap((file: string) => {
        const path = relative(root, file);
        const text = readFileSync(file, 'utf8');
        return checkProtocolLeakage(text, {
          path,
          findEncodedValues,
          allowed: new Set<string>(),
        }).map((finding: object) => ({ path, ...finding }));
      });

      expect(findings).toEqual([
        {
          path: 'changelog.d/VW-1.md',
          line: 5,
          check: 'protocol',
          message: 'byte-sequence shaped token on a published page',
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads a fragment as history, like the CHANGELOG.md it folds into', () => {
    expect(historical('changelog.d/VW-1.md')).toBe(true);
    expect(historical('CHANGELOG.md')).toBe(true);
    expect(historical('docs/a.md')).toBe(false);
  });
});

describe('checkToolCoverage', () => {
  const coverage = (texts: string[], ignored = new Set<string>()): string[] =>
    checkToolCoverage(texts, REGISTRY, ignored).map((finding) => finding.message);

  it('names every registered tool no page mentions', () => {
    expect(coverage(['only `server.health` here'])).toHaveLength(REGISTRY.size - 1);
  });

  it('accepts a tool named on any one of several pages', () => {
    const pages = [...REGISTRY].map((name) => `\`${name}\` does a thing`);
    expect(coverage(pages)).toEqual([]);
  });

  it('accepts a tool the reviewed ignore list excuses', () => {
    const pages = [...REGISTRY].filter((name) => name !== 'server.health').map((n) => `\`${n}\``);
    expect(coverage(pages, new Set(['server.health']))).toEqual([]);
  });

  it('does not count a tool named only inside a URL', () => {
    const pages = [...REGISTRY].map((name) =>
      name === 'session.start' ? 'https://example.com/session.start' : `\`${name}\``,
    );
    expect(coverage(pages)).toEqual(['no page of the skill names session.start']);
  });
});

describe('ANALYTICS_PIPELINE_IDS', () => {
  it('lists exactly the pipelines metrics.compute dispatches on', () => {
    const source = readFileSync(new URL('src/tools/metrics-tools.ts', REPO_ROOT), 'utf8');
    // The digit class matters: `strength.e1rm` hid from a letters-only pattern,
    // so the list read seventeen while the dispatch had eighteen (VW-513).
    const dispatched = [...source.matchAll(/^\s*case '([a-z0-9_]+\.[a-z0-9_]+)':/gm)].map(
      (match) => match[1],
    );
    expect([...ANALYTICS_PIPELINE_IDS].sort()).toEqual([...new Set(dispatched)].sort());
  });
});

describe('checkPageFrontmatter', () => {
  const EXISTING = new Set(['src/server.ts', 'README.md']);
  const VALID = {
    diataxis: 'how-to',
    audience: '[lifter, coach]',
    status: 'available',
    sources: '\n  - src/server.ts\n  - README.md',
    lastVerified: '2026-09-27',
  };

  function page(fields: Record<string, string | undefined>): string {
    const lines = Object.entries({ ...VALID, ...fields })
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => `${key}:${value.startsWith('\n') ? '' : ' '}${value}`);
    return `---\n${lines.join('\n')}\n---\n\n# A scratch page\n`;
  }

  const NOW = new Date('2026-09-30T12:00:00Z');

  function messages(text: string): string[] {
    return checkPageFrontmatter(text, (path: string) => EXISTING.has(path), NOW).map(
      (finding: { message: string }) => finding.message,
    );
  }

  it('passes a complete available page', () => {
    expect(messages(page({}))).toEqual([]);
  });

  it('passes a coming-soon page that carries a note and a tracking link', () => {
    const text = page({
      status: 'coming-soon',
      statusNote: 'The tool is registered but does nothing yet.',
      tracking: 'https://github.com/HJewkes/voltras-mcp/issues/1',
    });
    expect(messages(text)).toEqual([]);
  });

  it('names status when a page has no frontmatter at all', () => {
    expect(messages('# A scratch page\n')).toContain('status: missing');
  });

  it('names status when the field is missing', () => {
    expect(messages(page({ status: undefined }))).toEqual(['status: missing']);
  });

  it('names status when the value is outside the enum', () => {
    expect(messages(page({ status: 'beta' }))).toEqual([
      'status: "beta" is not one of available, experimental, coming-soon',
    ]);
  });

  it('names statusNote on an experimental page without one', () => {
    expect(messages(page({ status: 'experimental' }))).toEqual([
      'statusNote: required when status is experimental',
    ]);
  });

  it('names tracking on a coming-soon page without one', () => {
    expect(messages(page({ status: 'coming-soon', statusNote: 'Not wired yet.' }))).toEqual([
      'tracking: required when status is coming-soon',
    ]);
  });

  it('names each sources path that does not exist', () => {
    expect(messages(page({ sources: '\n  - src/server.ts\n  - src/gone.ts' }))).toEqual([
      'sources: no such path: src/gone.ts',
    ]);
  });

  it('names lastVerified when it is not a real calendar date', () => {
    expect(messages(page({ lastVerified: '2026-02-30' }))).toEqual([
      'lastVerified: "2026-02-30" is not a YYYY-MM-DD date',
    ]);
    expect(messages(page({ lastVerified: 'yesterday' }))).toEqual([
      'lastVerified: "yesterday" is not a YYYY-MM-DD date',
    ]);
  });

  it('passes a page marked with the date of its per-claim sourcing pass', () => {
    expect(messages(page({ sourced: '2026-09-30' }))).toEqual([]);
  });

  it('names sourced when it is not a real calendar date', () => {
    expect(messages(page({ sourced: 'yes' }))).toEqual(['sourced: "yes" is not a YYYY-MM-DD date']);
  });

  it('names a sourced or lastVerified date that is in the future', () => {
    expect(messages(page({ sourced: '2099-01-01' }))).toEqual([
      'sourced: "2099-01-01" is in the future',
    ]);
    expect(messages(page({ lastVerified: '2026-10-02' }))).toEqual([
      'lastVerified: "2026-10-02" is in the future',
    ]);
  });

  it('accepts tomorrow, the date an author east of UTC may already be on', () => {
    expect(messages(page({ sourced: '2026-10-01', lastVerified: '2026-10-01' }))).toEqual([]);
  });

  it('names an audience outside the enum', () => {
    expect(messages(page({ audience: '[lifter, investor]' }))).toEqual([
      'audience: "investor" is not one of lifter, coach, developer',
    ]);
  });

  it('reports the line the offending field sits on', () => {
    const [finding] = checkPageFrontmatter(page({ status: 'beta' }), () => true);
    expect(finding.line).toBe(4);
  });

  it('ignores a nested map such as the home page hero', () => {
    const text = page({}).replace('---\n', '---\nhero:\n  name: voltras-mcp\n  text: A title\n');
    expect(messages(text)).toEqual([]);
  });
});
