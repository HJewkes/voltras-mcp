// The source-level confidentiality guard (VW-213), tested against SHAPES.
//
// Every fixture here is synthetic. Naming a real register or quoting a real
// capture would put it in the repo, which is what the guard exists to prevent.
//
// The rule is off for this directory (it is a test path, deferred to w5-13), so
// the fixtures below do not trip it on their way past.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ESLint, Linter } from 'eslint';
import { describe, it, expect } from 'vitest';
// @ts-expect-error — the rule ships as plain ESM so `eslint.config.mjs` can load it.
import protocolPlugin, { findProtocolDetail } from '../../../eslint-rules/no-protocol-detail.mjs';
// @ts-expect-error — plain ESM, no declarations.
import { isScanned } from '../../../scripts/lib/text-confidentiality.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

interface Finding {
  kind: string;
  index: number;
  length: number;
}

const find = findProtocolDetail as (text: string) => Finding[];
const kinds = (text: string): string[] => [...new Set(find(text).map((f) => f.kind))].sort();

describe('encoded values', () => {
  it.each([
    ['a hex literal in code', 'const trigger = 0x1f;', 'hex-literal'],
    ['a hex literal inside an identifier', 'const Probe0xA9 = 1;', 'hex-literal'],
    ['a hex literal in a trailing comment', 'const n = 1; // observed 0x1f', 'hex-literal'],
    ['a hex literal inside a doc tag', '/** @remarks writes 0x1f */', 'hex-literal'],
    ['a spaced byte sequence', '// captured a9 c7 00 04 in a row', 'byte-sequence'],
    ['a hyphenated byte sequence', '// captured a9-c7-00-04 in a row', 'byte-sequence'],
    ['an underscored byte sequence', '// captured a9_c7_00_04 in a row', 'byte-sequence'],
    [
      'an underscored byte sequence behind a prefix',
      'const frame_a9_c7_00_04 = 1;',
      'byte-sequence',
    ],
    ['a value in a template literal', 'const probe = `writes 0x1f`;', 'hex-literal'],
    ['a free-standing hex run', "const probe = 'a9c7f0';", 'bare-hex'],
    ['a hex run inside an identifier', 'const REG_A9C7 = 1;', 'bare-hex'],
    ['a hex run across a case boundary', 'const probeA9C7Latch = 1;', 'bare-hex'],
    ['a command code with its number', '// the cmd 0x10 echo', 'command-code'],
    ['a command code written run-together', 'const cmdID10 = 1;', 'command-code'],
  ])('flags %s', (_label, text, kind) => {
    expect(kinds(text)).toContain(kind);
  });
});

describe('provenance', () => {
  it.each([
    ['the private repo', '// see voltra-private/src/protocol/enums.ts'],
    ['a capture session path', '// see captures/sessions/2026-01-01'],
    ['the internal research tree', '// see sources/research/some-note.md'],
    ['a decompilation reference', '// decompiled from the vendor app'],
    ['a device serial', "const unit = 'VTR-212006';"],
  ])('flags %s', (_label, text) => {
    expect(kinds(text)).toContain('private-provenance');
  });
});

describe('what the guard does not fire on', () => {
  // Each of these is a shape this repo actually writes. A guard that flags them
  // gets turned off within a week, which is worse than no guard at all.
  it.each([
    ['a ticket id', '// VW-168a and VMCP-02.40 and SDK-01'],
    ['a CSS colour', "const ground = '#1C1C1C';"],
    ['a pull-request number', '// reconciled with titan #120'],
    ['a hash name', "createHash('sha256').update(x)"],
    ['a CSS rotation', "transform: [{ rotate: '-90deg' }]"],
    ['a transcript timestamp', '// "[00:00:00.000 --> 00:00:01.100] stop"'],
    ['a date', '// bench 2026-07-07, second attempt'],
    ['a version', '// requires @voltras/node-sdk 0.12.0'],
    ['a viewport size', "const shot = { size: '1440x900' };"],
    ['ordinary prose', '// A read-only, best-effort back-fill of the self-report.'],
    ['a snake_case identifier', 'const set_weight_lbs = 1;'],
    ['a snake_case event name', "const name = 'on_per_rep';"],
    ['a multi-line source citation', '// see `scripts/drive.mjs:28-45,94`'],
  ])('lets %s through', (_label, text) => {
    expect(find(text)).toEqual([]);
  });
});

// VW-224: a value split across a `+` chain of string literals. Every hex-shaped
// token is assembled here at runtime, so no fixture below spells one.
describe('a value split across a concatenation (VW-224)', () => {
  const PAIR = 'a1';
  const OTHER = 'b2';
  const [THIRD, FOURTH, FIFTH] = ['c', 'd', 'e'].map((letter, i) => `${letter}${i + 3}`);
  const prefix = ['0', 'x'].join('');

  function messagesFor(code: string) {
    const linter = new Linter({ configType: 'flat' });
    return linter.verify(code, {
      plugins: { voltras: protocolPlugin },
      rules: { 'voltras/no-protocol-detail': 'error' },
    });
  }

  it.each([
    ['a hex literal split after its prefix', `const v = '${prefix}' + '${PAIR}';`],
    ['a hex literal split out of a template', `const v = \`${prefix}\` + '${PAIR}';`],
    ['a spaced byte sequence split in two', `const v = '${PAIR} ${PAIR}' + ' ${PAIR} ${PAIR}';`],
    ['an underscored byte sequence split in two', `const v = '${PAIR}_${PAIR}' + '_${PAIR}';`],
    ['a bare hex run split in two', `const v = '${PAIR}' + '${OTHER}';`],
    ['a run of literals behind an identifier', `const v = label + '${prefix}' + '${PAIR}';`],
    ['a nested chain', `const v = '${PAIR}' + ('${OTHER}' + '${PAIR}');`],
  ])('flags %s, once', (_label, code) => {
    expect(messagesFor(code).map((m) => m.ruleId)).toEqual(['voltras/no-protocol-detail']);
  });

  it('reports a chain holding two split values once, at its start', () => {
    const code = `const v = '${prefix}' + '${PAIR}' + ' ' + '${prefix}' + '${OTHER}';`;
    const messages = messagesFor(code);
    expect(messages).toHaveLength(1);
    expect(messages[0].column).toBe(code.indexOf(`'${prefix}'`) + 1);
  });

  it('does not report a value inside one piece a second time', () => {
    expect(messagesFor(`const v = '${prefix}${PAIR}' + ' units';`)).toHaveLength(1);
  });

  it('does not report a value a second time when the join extends it', () => {
    expect(messagesFor(`const v = '${prefix}${PAIR}' + '${OTHER}';`)).toHaveLength(1);
  });

  it('reports a new value across the join beside a hit already in the first piece', () => {
    const code = `const v = '${prefix}${PAIR} ${OTHER}' + '${THIRD}';`;
    expect(messagesFor(code)).toHaveLength(2);
  });

  it('reports a new value across the join beside a hit in a middle piece', () => {
    const middle = `${OTHER} ${prefix}${THIRD} ${FOURTH}`;
    const code = `const v = '${PAIR}' + '${middle}' + '${FIFTH}';`;
    expect(messagesFor(code)).toHaveLength(2);
  });

  const escapedZero = `\\x${'0'.charCodeAt(0).toString(16)}`;

  it('reports a split value whose first piece is spelled in an escape', () => {
    const code = `const v = '${escapedZero}x' + '${PAIR}';`;
    expect(messagesFor(code).map((m) => m.ruleId)).toEqual(['voltras/no-protocol-detail']);
  });

  it('reports an escaped piece that decodes to a hit, extended across the join', () => {
    const code = `const v = '${escapedZero}x${PAIR}' + '${OTHER}';`;
    expect(messagesFor(code).map((m) => m.ruleId)).toEqual(['voltras/no-protocol-detail']);
  });

  it.each([
    ['a snake_case name built in pieces', "const v = 'max_' + 'force_' + 'lbs';"],
    ['ordinary words', "const v = 'Set ' + 'complete' + ', rest ' + 'now';"],
    ['a prefix joined to an identifier', `const v = '${prefix}' + digits;`],
    ['a prefix joined to a call', `const v = '${prefix}' + pad(value);`],
    ['a prefix joined to an expression template', `const v = '${prefix}' + \`\${value}\`;`],
    ['numeric addition', 'const v = 1 + 2 + 3;'],
  ])('lets %s through', (_label, code) => {
    expect(messagesFor(code)).toEqual([]);
  });
});

// scripts/ was outside the ESLint target (`eslint src tools/truecoach-retro`), so a
// command code sitting in a script's header comment was invisible to this rule even
// though the rule itself scans comments fine (VW-497). This runs the real config the
// widened `npm run lint:scripts-confidentiality` uses, against a synthetic fixture, to
// prove the scripts/ glob is actually wired up rather than asserting on the detector
// in isolation again.
describe('the scripts/ scan (VW-497)', () => {
  const CONFIG = join(REPO_ROOT, 'eslint.scripts-confidentiality.config.mjs');
  const FIXTURE_PATH = join(REPO_ROOT, 'scripts/__synthetic-fixture-not-a-real-file__.mjs');

  async function lint(code: string) {
    const eslint = new ESLint({ cwd: REPO_ROOT, overrideConfigFile: CONFIG });
    const [result] = await eslint.lintText(code, { filePath: FIXTURE_PATH });
    return result.messages;
  }

  it('fails on a synthetic forbidden token planted in a script header comment', async () => {
    const messages = await lint(
      '#!/usr/bin/env node\n// driver header: observed 0x1f on the wire\n',
    );
    expect(messages.some((m) => m.ruleId === 'voltras/no-protocol-detail')).toBe(true);
  });

  it('lets an ordinary script header comment through', async () => {
    const messages = await lint('#!/usr/bin/env node\n// driver header: nothing notable here\n');
    expect(messages.some((m) => m.ruleId === 'voltras/no-protocol-detail')).toBe(false);
  });
});

// The rule reads the parsed source, not the file as a text tool classifies it.
// That is what makes it immune to VW-223: a NUL byte anywhere in a file makes
// `grep -r` report "Binary file ... matches" and print nothing, and every sweep
// in this campaign walked past `coercion-watch.ts` for exactly that reason.
describe('a NUL byte does not hide anything from it', () => {
  it('still finds a value in a file carrying one', () => {
    expect(kinds('const sep = `a\u0000b`; // observed 0x1f')).toContain('hex-literal');
  });
});

describe('the exemption list', () => {
  // An exclusion that governs FIXING must never govern COUNTING. Every
  // exemption in the repo is enumerated here rather than trusted, so a fourth
  // one cannot appear without someone editing this list and saying why.
  const DIRECTIVE =
    /eslint-disable(?:-next-line|-line)?\s+voltras\/no-protocol-detail\s+--\s+([^\n]*)/g;

  // Every path either pass reads: the text pass's own predicate, plus what ESLint parses.
  // A directive in any file type the text pass scans exempts a line (VW-497).
  const isPinned = (path: string): boolean =>
    isScanned(path) || /\.(ts|tsx|cjs|mjs|md)$/.test(path);

  function trackedFiles(): string[] {
    return execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\0')
      .filter((path) => path !== '' && isPinned(path));
  }

  function exemptionSites(files: string[], read: (file: string) => string): string[] {
    const sites: string[] = [];
    for (const file of files.filter(isPinned)) {
      for (const match of read(file).matchAll(DIRECTIVE)) {
        sites.push(`${file} — ${match[1].replace(/\s*-->$/, '').trim()}`);
      }
    }
    return sites;
  }

  it.each(['ci.yml', 'run.sh', 'app.js', 'view.vue', 'data.json', 'page.html'])(
    'catches a directive planted in a scanned %s file',
    (name) => {
      const planted = ['eslint-disable-next-line', 'voltras/no-protocol-detail', '-- planted'];
      const sites = exemptionSites([`fixtures/${name}`], () => `# ${planted.join(' ')}\nx\n`);
      expect(sites).toEqual([`fixtures/${name} — planted`]);
    },
  );

  it('is exactly these four sites, and nothing else', () => {
    const sites = exemptionSites(trackedFiles(), (file) =>
      readFileSync(join(REPO_ROOT, file), 'utf8'),
    );
    expect(sites).toEqual([
      'WISHLIST.md — a commit sha, not a device value (VW-497)',
      'src/tools/device-tools.ts — the hex alphabet, not a device value (VW-213)',
      'src/tools/device-tools.ts — a nibble mask, not a device value (VW-213)',
      'src/tools/device-tools.ts — a nibble mask, not a device value (VW-213)',
    ]);
  });
});
