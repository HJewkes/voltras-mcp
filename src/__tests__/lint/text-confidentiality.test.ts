// The text pass of the confidentiality check (VW-497), run end to end through
// `npm run lint:text-confidentiality`'s own script against planted fixtures.
//
// Every forbidden token here is assembled at test time from harmless pieces, so
// no file in the repo carries it whole, and it is a synthetic value, not a
// device one. The script-comment case for .mjs files lives in
// no-protocol-detail.test.ts, which runs the ESLint pass (VW-497, #517).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error — the scanner ships as plain ESM for the npm script.
import { isScanned } from '../../../scripts/lib/text-confidentiality.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CHECK = join(REPO_ROOT, 'scripts/check-text-confidentiality.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'text-confidentiality-'));

const syntheticToken = (): string => ['0', 'x', '1', 'f'].join('');
const directive = (form: string, reason: string): string =>
  ['eslint-disable-' + form, 'voltras/no-protocol-detail', reason].join(' ');

function runCheck(name: string, contents: string) {
  const path = join(scratch, name);
  writeFileSync(path, contents);
  const run = spawnSync(process.execPath, [CHECK, path], { encoding: 'utf8' });
  return { status: run.status, output: run.stdout + run.stderr };
}

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('the text confidentiality pass', () => {
  it.each([
    ['a markdown page', 'page.md', (token: string) => `# Notes\n\nThe driver saw ${token} here.\n`],
    [
      'a TypeScript script comment',
      'probe.ts',
      (token: string) => `// driver header: observed ${token}\nexport const n = 1;\n`,
    ],
  ])('fails on a synthetic forbidden token planted in %s', (_label, name, write) => {
    const token = syntheticToken();

    const { status, output } = runCheck(name, write(token));

    expect(status).toBe(1);
    expect(output).toContain('hex-literal');
    expect(output).not.toContain(token);
  });

  it('passes an ordinary markdown page', () => {
    const { status } = runCheck('plain.md', '# Notes\n\nNothing notable on this page.\n');

    expect(status).toBe(0);
  });

  it('honours a reasoned next-line directive written as an HTML comment', () => {
    const exemption = `<!-- ${directive('next-line', '-- a synthetic value (VW-497)')} -->`;

    const { status } = runCheck('exempt.md', `${exemption}\nSaw ${syntheticToken()}.\n`);

    expect(status).toBe(0);
  });

  it('ignores a directive that gives no reason', () => {
    const exemption = `<!-- ${directive('next-line', '')} -->`;

    const { status } = runCheck('unreasoned.md', `${exemption}\nSaw ${syntheticToken()}.\n`);

    expect(status).toBe(1);
  });

  it.each([
    ['a capture image', 'site/public/captures/goals.png', false],
    ['a test fixture', 'packages/session-core/src/codecs/__tests__/fixtures.ts', false],
    ['a guide page', 'site/guides/first-workout.md', true],
    ['a script outside ESLint', 'scripts/sim/lifter-model.ts', true],
  ])('decides whether to read %s', (_label, path, expected) => {
    expect(isScanned(path)).toBe(expected);
  });
});
