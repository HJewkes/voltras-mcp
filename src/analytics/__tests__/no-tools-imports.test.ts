// VW-362: `src/analytics/**` must stay free of runtime imports from
// `src/tools/**`, which drags the MCP SDK and the store into an analytics
// module. `import type` is exempt: TypeScript erases it at compile time, so
// it carries no runtime dependency.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ANALYTICS_DIR = join(import.meta.dirname, '..');

const TOOLS_IMPORT_RE = /^import\s+(type\s+)?(?:[^;]*?)from\s+['"]([^'"]+)['"]/gm;

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (entry === '__tests__') continue;
      files.push(...listSourceFiles(path));
    } else if (entry.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

function isToolsImport(specifier: string): boolean {
  return (
    specifier.includes('/tools/') ||
    specifier.startsWith('tools/') ||
    specifier.startsWith('src/tools/')
  );
}

describe('src/analytics import boundary', () => {
  it('has no runtime import from src/tools/ in any non-test file', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(ANALYTICS_DIR)) {
      const content = readFileSync(file, 'utf8');
      for (const match of content.matchAll(TOOLS_IMPORT_RE)) {
        const [, isTypeOnly, specifier] = match;
        if (isTypeOnly) continue;
        if (isToolsImport(specifier)) {
          offenders.push(`${relative(ANALYTICS_DIR, file)}: import ... from '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
