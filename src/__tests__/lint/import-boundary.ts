// Shared scanner for the layer boundary tests (VW-810). It reads source text
// rather than resolving modules, so it sees what a reviewer sees: static
// `import`, `export ... from` and dynamic `import()`. Counting the last two
// keeps a re-export shim or a lazy import from slipping past a rule.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface ImportRef {
  /** Path relative to the scanned directory. */
  file: string;
  specifier: string;
  /** `import type` / `export type`, or `typeof import(...)`: erased at compile time. */
  typeOnly: boolean;
}

const STATIC_FROM_RE =
  /^[ \t]*(?:import|export)\s+(type\s+)?[^;'"=()]*?\bfrom\s+['"]([^'"]+)['"]/gm;
const SIDE_EFFECT_RE = /^[ \t]*import\s+['"]([^'"]+)['"]/gm;
const DYNAMIC_RE = /(\btypeof\s+)?\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every import-like reference in one file's source text. */
export function scanImports(source: string, file: string): ImportRef[] {
  const refs: ImportRef[] = [];
  for (const [, typeKeyword, specifier] of source.matchAll(STATIC_FROM_RE)) {
    refs.push({ file, specifier, typeOnly: typeKeyword !== undefined });
  }
  for (const [, specifier] of source.matchAll(SIDE_EFFECT_RE)) {
    refs.push({ file, specifier, typeOnly: false });
  }
  for (const [, typeofKeyword, specifier] of source.matchAll(DYNAMIC_RE)) {
    refs.push({ file, specifier, typeOnly: typeofKeyword !== undefined });
  }
  return refs;
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== '__tests__') files.push(...listSourceFiles(path));
    } else if (entry.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

/** Every import-like reference in the non-test `.ts` files under `dir`. */
export function collectImports(dir: string): ImportRef[] {
  return listSourceFiles(dir).flatMap((path) =>
    scanImports(readFileSync(path, 'utf8'), relative(dir, path)),
  );
}

/** Whether a specifier points into `src/<layer>/`, relatively or from the root. */
export function pointsInto(layer: string, specifier: string): boolean {
  return (
    specifier.includes(`/${layer}/`) ||
    specifier.startsWith(`${layer}/`) ||
    specifier.startsWith(`src/${layer}/`)
  );
}
