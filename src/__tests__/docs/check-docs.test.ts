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
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  checkPathCitations,
  checkProtocolLeakage,
  checkToolNames,
  extractPathCitations,
} from '../../../scripts/lib/docs-checks.mjs';
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

describe('ANALYTICS_PIPELINE_IDS', () => {
  it('lists exactly the pipelines metrics.compute dispatches on', () => {
    const source = readFileSync(new URL('src/tools/metrics-tools.ts', REPO_ROOT), 'utf8');
    const dispatched = [...source.matchAll(/^\s*case '([a-z_]+\.[a-z_]+)':/gm)].map(
      (match) => match[1],
    );
    expect([...ANALYTICS_PIPELINE_IDS].sort()).toEqual([...new Set(dispatched)].sort());
  });
});
