import { describe, expect, it } from 'vitest';

import { findNulByteFiles } from '../../../scripts/lib/nul-byte-check.mjs';

describe('findNulByteFiles', () => {
  it('flags a file with a NUL byte inside a string literal', () => {
    const buffer = Buffer.from("const key = 'left\x00right';", 'utf8');
    expect(findNulByteFiles([{ path: 'src/example.ts', buffer }])).toEqual([
      { path: 'src/example.ts', offset: 17 },
    ]);
  });

  it('does not flag a clean text file', () => {
    const buffer = Buffer.from("const key = 'left\\0right';", 'utf8');
    expect(findNulByteFiles([{ path: 'src/example.ts', buffer }])).toEqual([]);
  });

  it('reports every offending file, not just the first', () => {
    const clean = { path: 'src/clean.ts', buffer: Buffer.from('const n = 1;', 'utf8') };
    const dirty = { path: 'src/dirty.ts', buffer: Buffer.from('const n\x00 = 1;', 'utf8') };
    expect(findNulByteFiles([clean, dirty])).toEqual([{ path: 'src/dirty.ts', offset: 7 }]);
  });
});
