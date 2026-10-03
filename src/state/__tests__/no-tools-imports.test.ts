// VW-810: `src/state/**` must not import the tools layer at runtime. `import
// type` is exempt, as in the analytics rule. The two files below still call
// into `tools/set-tools.ts` until the set lifecycle moves into state/; the list
// may only shrink, so a fixed file must leave it and no file may join it.

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { collectImports, pointsInto } from '../../__tests__/lint/import-boundary.js';

const STATE_DIR = join(import.meta.dirname, '..');

const KNOWN_OFFENDERS = ['event-bridge.ts', 'guided-load-reap.ts'];

function runtimeToolsOffenders(): string[] {
  const files = collectImports(STATE_DIR)
    .filter((ref) => !ref.typeOnly && pointsInto('tools', ref.specifier))
    .map((ref) => ref.file);
  return [...new Set(files)].sort();
}

describe('src/state import boundary', () => {
  it('has runtime imports from src/tools/ only in the known offenders', () => {
    expect(runtimeToolsOffenders()).toEqual([...KNOWN_OFFENDERS].sort());
  });
});
