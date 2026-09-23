// Reading one exported table file and hashing text the way `digestTable` does
// (VW-534). Shared by `import` and `verify` so the two agree by construction.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type TableManifest } from './manifest.js';

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function readTableFile(inDir: string, table: TableManifest): string {
  return readFileSync(join(inDir, table.file), 'utf8');
}
