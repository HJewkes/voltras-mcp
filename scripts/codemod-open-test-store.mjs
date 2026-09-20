#!/usr/bin/env node
// Moves test files off `SqliteSessionStore.open(...)` and onto the helper in
// `src/store/__tests__/open-test-store.ts` (VW-532).
//
// A file that also opens the database with `node:sqlite` is bound to the engine, so it gets
// `openSqliteTestStore` and keeps its `SqliteSessionStore` annotations. Every other file gets
// `openTestStore` and is retyped to the port. The allow-list is the one `eslint.config.mjs`
// exempts from the guard.
//
// Usage: node scripts/codemod-open-test-store.mjs [--check], then `npm run format`.
//
// It does not touch dynamic `await import(...)` of the store, or a file whose annotations it
// cannot place; it names those on stdout so they can be fixed by hand.

import { globSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STORE_CONSTRUCTOR_ALLOW_LIST } from '../eslint-rules/store-constructor-allow-list.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = 'src/store/__tests__/open-test-store.ts';

/** A real call, not the class named inside a string (a describe title, say). */
const CONSTRUCTOR_CALL = /(?<!['"`])SqliteSessionStore\.open\(/;

/** The class named outside a string, on a line that is not a comment. */
const CLASS_IN_CODE = /^(?!\s*(?:\/\/|\*|\/\*)).*(?<!['"`])\bSqliteSessionStore\b/m;

const check = process.argv.includes('--check');
const notes = [];

/** The import specifier a file at `from` uses to reach the helper. */
function helperSpecifier(from) {
  const rel = relative(dirname(from), HELPER).replaceAll('\\', '/').replace(/\.ts$/, '.js');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** Rewrites both open shapes: the in-memory one takes no argument, every other one a path. */
function rewriteOpenCalls(text, fn) {
  return text
    .replaceAll("SqliteSessionStore.open(':memory:')", `${fn}()`)
    .replace(
      /SqliteSessionStore\.open\((?![')])([^()]*(?:\([^()]*\))?[^()]*)\)/g,
      (_match, arg) => `${fn}({ ${arg === 'path' ? 'path' : `path: ${arg}`} })`,
    );
}

/** In a bound file the class survives only as an annotation, so its import becomes type-only. */
function typeOnlyClassImport(text) {
  return text
    .replace(
      /^import \{ SqliteSessionStore \}( from '[^']*sqlite-store\.js';)$/m,
      'import type { SqliteSessionStore }$1',
    )
    .replace(
      /^(import \{ .*), SqliteSessionStore( \} from '[^']*sqlite-store\.js';)$/m,
      '$1, type SqliteSessionStore$2',
    );
}

/** The type positions the class appears in across the suite, all meaning "a store". */
function retypeToPort(text) {
  return text
    .replaceAll('InstanceType<typeof SqliteSessionStore>', 'SessionStore')
    .replaceAll(': SqliteSessionStore', ': SessionStore')
    .replaceAll('<SqliteSessionStore', '<SessionStore')
    .replaceAll('as SqliteSessionStore', 'as SessionStore');
}

/** Drops the class from its import, leaving whatever else that import brought in. */
function dropClassImport(text) {
  return text
    .replace(/^import \{ SqliteSessionStore \} from '[^']*sqlite-store\.js';\n/m, '')
    .replace(/^(import \{ )SqliteSessionStore, /m, '$1')
    .replace(/, SqliteSessionStore( \} from '[^']*sqlite-store\.js';)/m, '$1');
}

/** Puts the helper import after the last static import in the file. */
function addHelperImport(text, line) {
  const imports = [...text.matchAll(/^import .*?;$/gms)];
  if (imports.length === 0) return null;
  const last = imports[imports.length - 1];
  const at = last.index + last[0].length;
  return `${text.slice(0, at)}\n${line}${text.slice(at)}`;
}

function rewrite(file, text) {
  const bound = text.includes("from 'node:sqlite'");
  const fn = bound ? 'openSqliteTestStore' : 'openTestStore';
  let out = rewriteOpenCalls(text, fn);
  const names = [fn];
  if (bound) {
    out = typeOnlyClassImport(out);
  } else {
    out = retypeToPort(out);
    if (/\bSessionStore\b/.test(out)) names.push('type SessionStore');
    out = dropClassImport(out);
  }
  out = addHelperImport(out, `import { ${names.join(', ')} } from '${helperSpecifier(file)}';\n`);
  if (out === null) {
    notes.push(`${file}: no static import to anchor the helper import to`);
    return text;
  }
  if (CONSTRUCTOR_CALL.test(out)) {
    notes.push(`${file}: an open call the codemod could not read`);
  }
  if (/await import\('[^']*sqlite-store\.js'\)/.test(out)) {
    notes.push(`${file}: the store is pulled in by a dynamic import`);
  }
  if (!bound && CLASS_IN_CODE.test(out)) {
    notes.push(`${file}: the class survives in a position the codemod does not know`);
  }
  return out;
}

const files = globSync('src/**/*.test.ts', { cwd: REPO_ROOT })
  .map((f) => f.replaceAll('\\', '/'))
  .filter((f) => !STORE_CONSTRUCTOR_ALLOW_LIST.includes(f))
  .filter((f) => CONSTRUCTOR_CALL.test(readFileSync(join(REPO_ROOT, f), 'utf8')))
  .sort();

let changed = 0;
for (const file of files) {
  const before = readFileSync(join(REPO_ROOT, file), 'utf8');
  const after = rewrite(file, before);
  if (after === before) continue;
  changed += 1;
  if (!check) writeFileSync(join(REPO_ROOT, file), after);
}

console.warn(`${check ? 'would rewrite' : 'rewrote'} ${changed} of ${files.length} file(s)`);
for (const note of notes) console.warn(`  by hand: ${note}`);
