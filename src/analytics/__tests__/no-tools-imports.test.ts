// VW-362: `src/analytics/**` must stay free of runtime imports from
// `src/tools/**`, which drags the MCP SDK and the store into an analytics
// module. `import type` is exempt: TypeScript erases it at compile time, so
// it carries no runtime dependency.

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { collectImports, pointsInto } from '../../__tests__/lint/import-boundary.js';

const ANALYTICS_DIR = join(import.meta.dirname, '..');

describe('src/analytics import boundary', () => {
  it('has no runtime import from src/tools/ in any non-test file', () => {
    const offenders = collectImports(ANALYTICS_DIR)
      .filter((ref) => !ref.typeOnly && pointsInto('tools', ref.specifier))
      .map((ref) => `${ref.file}: '${ref.specifier}'`);

    expect(offenders).toEqual([]);
  });
});
