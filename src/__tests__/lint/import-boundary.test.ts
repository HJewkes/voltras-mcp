import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { collectImports, pointsInto, scanImports } from './import-boundary.js';

describe('scanImports', () => {
  it('counts a re-export as an import', () => {
    const refs = scanImports("export { x } from '../tools/y.js';\n", 'a.ts');

    expect(refs).toEqual([{ file: 'a.ts', specifier: '../tools/y.js', typeOnly: false }]);
  });

  it('marks import type and export type as type-only', () => {
    const source = [
      "import type { A } from '../tools/a.js';",
      "export type { B } from '../tools/b.js';",
    ].join('\n');

    const refs = scanImports(source, 'a.ts');

    expect(refs.map((ref) => ref.typeOnly)).toEqual([true, true]);
  });

  it('reads a static import that spans several lines', () => {
    const source = "import {\n  one,\n  two,\n} from '../tools/many.js';\n";

    expect(scanImports(source, 'a.ts')).toEqual([
      { file: 'a.ts', specifier: '../tools/many.js', typeOnly: false },
    ]);
  });

  it('counts a dynamic import as runtime and typeof import as type-only', () => {
    const source = [
      "const mod = await import('../tools/lazy.js');",
      "type Mod = typeof import('../tools/typed.js');",
    ].join('\n');

    expect(scanImports(source, 'a.ts')).toEqual([
      { file: 'a.ts', specifier: '../tools/lazy.js', typeOnly: false },
      { file: 'a.ts', specifier: '../tools/typed.js', typeOnly: true },
    ]);
  });

  it('counts a side-effect import', () => {
    expect(scanImports("import '../tools/setup.js';\n", 'a.ts')).toEqual([
      { file: 'a.ts', specifier: '../tools/setup.js', typeOnly: false },
    ]);
  });

  it('ignores a declaration that merely mentions from', () => {
    const source = "export const label = 'from somewhere';\nexport function f() {}\n";

    expect(scanImports(source, 'a.ts')).toEqual([]);
  });
});

describe('collectImports', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it('walks nested directories and skips __tests__', () => {
    dir = mkdtempSync(join(tmpdir(), 'import-boundary-'));
    mkdirSync(join(dir, 'nested'));
    mkdirSync(join(dir, '__tests__'));
    writeFileSync(join(dir, 'nested', 'kept.ts'), "import { a } from '../tools/a.js';\n");
    writeFileSync(join(dir, '__tests__', 'skipped.ts'), "import { b } from '../tools/b.js';\n");
    writeFileSync(join(dir, 'notes.md'), "import { c } from '../tools/c.js';\n");

    const refs = collectImports(dir);

    expect(refs).toEqual([
      { file: join('nested', 'kept.ts'), specifier: '../tools/a.js', typeOnly: false },
    ]);
  });
});

describe('pointsInto', () => {
  it('matches relative and root-anchored specifiers for the layer only', () => {
    expect(pointsInto('tools', '../tools/set-tools.js')).toBe(true);
    expect(pointsInto('tools', 'src/tools/set-tools.js')).toBe(true);
    expect(pointsInto('tools', './toolset.js')).toBe(false);
    expect(pointsInto('tools', '../state/server-state.js')).toBe(false);
  });
});
