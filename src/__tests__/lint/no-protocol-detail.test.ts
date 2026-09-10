// The source-level confidentiality guard (VW-213), tested against SHAPES.
//
// Every fixture here is synthetic. Naming a real register or quoting a real
// capture would put it in the repo, which is what the guard exists to prevent.
//
// The rule is off for this directory (it is a test path, deferred to w5-13), so
// the fixtures below do not trip it on their way past.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, it, expect } from 'vitest';
// @ts-expect-error — the rule ships as plain ESM so `eslint.config.mjs` can load it.
import { findProtocolDetail } from '../../../eslint-rules/no-protocol-detail.mjs';

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
  ])('lets %s through', (_label, text) => {
    expect(find(text)).toEqual([]);
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

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) sourceFiles(path, out);
      else if (/\.(ts|tsx|cjs)$/.test(path)) out.push(path);
    }
    return out;
  }

  it('is exactly the hex-encoding helper, and nothing else', () => {
    const sites: string[] = [];
    for (const file of sourceFiles(join(REPO_ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(DIRECTIVE)) {
        sites.push(`${relative(REPO_ROOT, file)} — ${match[1].trim()}`);
      }
    }
    expect(sites).toEqual([
      'src/tools/device-tools.ts — the hex alphabet, not a device value (VW-213)',
      'src/tools/device-tools.ts — a nibble mask, not a device value (VW-213)',
      'src/tools/device-tools.ts — a nibble mask, not a device value (VW-213)',
    ]);
  });
});
