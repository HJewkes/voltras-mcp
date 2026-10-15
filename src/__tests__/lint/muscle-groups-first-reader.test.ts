// No tool counts by the catalog's first muscle (VW-563, VW-665).
//
// An exercise's `muscleGroups[0]` is a coarse catalog string: a shoulder press
// files under `shoulders`, so a lateral raise and a face pull pool with it. Every
// per-muscle count reads the weight table instead (`attributionOfExercise`,
// `targetMusclesOf`). The table's fallback for an id it does not hold is the one
// legitimate reader, so `seed-attribution.ts` is the only exempt file.
//
// The scan walks the TypeScript AST rather than the text, so a comment or a
// string that mentions the pattern never trips it.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../..');
const EXEMPT = new Set(['exercises/seed-attribution.ts']);
const FIELD = 'muscleGroups';

function isTestPath(path: string): boolean {
  return path.split('/').includes('__tests__') || /\.test\.tsx?$/.test(path);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** `muscleGroups`, `x.muscleGroups`, `x?.muscleGroups` or `x['muscleGroups']`. */
function namesField(node: ts.Node): boolean {
  const inner = ts.skipOuterExpressions(node);
  if (ts.isIdentifier(inner)) return inner.text === FIELD;
  if (ts.isPropertyAccessExpression(inner)) return inner.name.text === FIELD;
  if (ts.isElementAccessExpression(inner)) {
    const key = inner.argumentExpression;
    return ts.isStringLiteralLike(key) && key.text === FIELD;
  }
  return false;
}

function isZero(node: ts.Node | undefined): boolean {
  return node !== undefined && ts.isNumericLiteral(node) && Number(node.text) === 0;
}

function isOne(node: ts.Node | undefined): boolean {
  return node !== undefined && ts.isNumericLiteral(node) && Number(node.text) === 1;
}

/** `.at(0)`, `.shift()` or `.slice(0, 1)` on the field. */
function readsFirstByCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || !namesField(callee.expression)) return false;
  const [first, second] = node.arguments;
  switch (callee.name.text) {
    case 'at':
      return isZero(first);
    case 'shift':
      return true;
    case 'slice':
      return isZero(first) && isOne(second);
    default:
      return false;
  }
}

/** `const [a] = x.muscleGroups`, `[a] = x.muscleGroups`, or `{ muscleGroups: [a] }`. */
function destructuresFirst(node: ts.Node): boolean {
  if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name)) {
    return node.initializer !== undefined && namesField(node.initializer);
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isArrayLiteralExpression(node.left)
  ) {
    return namesField(node.right);
  }
  if (ts.isBindingElement(node) && ts.isArrayBindingPattern(node.name)) {
    const key = node.propertyName;
    return key !== undefined && ts.isIdentifier(key) && key.text === FIELD;
  }
  return false;
}

function readsFirst(node: ts.Node): boolean {
  if (ts.isElementAccessExpression(node)) {
    return namesField(node.expression) && isZero(node.argumentExpression);
  }
  if (ts.isCallExpression(node)) return readsFirstByCall(node);
  return destructuresFirst(node);
}

/** `line N: <source text>` for each first-muscle read in `source`. */
function firstMuscleReaders(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (readsFirst(node)) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      hits.push(`line ${line + 1}: ${node.getText(file)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

describe('the guard itself', () => {
  it.each([
    ['index', 'const m = exercise.muscleGroups[0];'],
    ['optional index', 'const m = exercise?.muscleGroups?.[0];'],
    ['non-null index', 'const m = exercise.muscleGroups![0]!;'],
    ['bare local', 'const m = muscleGroups[0];'],
    ['string key', "const m = exercise['muscleGroups'][0];"],
    ['at(0)', 'const m = exercise.muscleGroups.at(0);'],
    ['slice(0, 1)', 'const m = exercise.muscleGroups.slice(0, 1);'],
    ['shift()', 'const m = [...list].shift() ?? exercise.muscleGroups.shift();'],
    ['array destructuring', 'const [primary] = exercise.muscleGroups;'],
    ['destructuring assignment', 'let p; [p] = exercise.muscleGroups;'],
    ['nested destructuring', 'const { muscleGroups: [primary] } = exercise;'],
    ['parameter destructuring', 'function f({ muscleGroups: [p] }: E) { return p; }'],
  ])('flags a %s read', (_label, source) => {
    expect(firstMuscleReaders('synthetic.ts', source)).toHaveLength(1);
  });

  it('ignores a comment and a string that mention the pattern', () => {
    const source = [
      '// exercise.muscleGroups[0] is the catalog primary',
      '/** const [p] = exercise.muscleGroups; */',
      "const note = 'reads muscleGroups[0]';",
      'const tpl = `muscleGroups.at(0)`;',
    ].join('\n');

    expect(firstMuscleReaders('synthetic.ts', source)).toEqual([]);
  });

  it('ignores reads that are not the first catalog muscle', () => {
    const source = [
      'const all = exercise.muscleGroups.join("/");',
      'const second = exercise.muscleGroups[1];',
      'const secondary = exercise.secondaryMuscleGroups[0];',
      'const [first] = targetMusclesOf(state, id);',
    ].join('\n');

    expect(firstMuscleReaders('synthetic.ts', source)).toEqual([]);
  });

  it('reports the line of each hit', () => {
    const source = 'const a = 1;\nconst m = exercise.muscleGroups[0];\n';

    expect(firstMuscleReaders('synthetic.ts', source)).toEqual([
      'line 2: exercise.muscleGroups[0]',
    ]);
  });

  it('would flag the exempt file if it were not exempt', () => {
    const exempt = join(SRC, 'exercises/seed-attribution.ts');

    expect(firstMuscleReaders(exempt, readFileSync(exempt, 'utf8'))).not.toEqual([]);
  });
});

/** `path line N: text` for each first-muscle read under `root`, tests and the exempt file aside. */
function offendersUnder(root: string): string[] {
  return sourceFiles(root)
    .map((path) => relative(root, path))
    .filter((path) => !isTestPath(path) && !EXEMPT.has(path))
    .flatMap((path) =>
      firstMuscleReaders(path, readFileSync(join(root, path), 'utf8')).map(
        (hit) => `${path} ${hit}`,
      ),
    );
}

describe('the directory walk', () => {
  it('flags a nested offender and passes the exempt file and tests', () => {
    const root = mkdtempSync(join(tmpdir(), 'muscle-groups-guard-'));
    const write = (path: string, source: string): void => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), source);
    };
    write('tools/deep/volume.ts', 'export const m = (e: E) => e.muscleGroups[0];\n');
    write('exercises/seed-attribution.ts', 'export const m = (e: E) => e.muscleGroups[0];\n');
    write('tools/__tests__/volume.test.ts', 'const m = e.muscleGroups[0];\n');
    write('tools/volume.test.ts', 'const m = e.muscleGroups[0];\n');

    try {
      expect(offendersUnder(root)).toEqual(['tools/deep/volume.ts line 1: e.muscleGroups[0]']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('src', () => {
  it('reads the first catalog muscle only in seed-attribution.ts', () => {
    expect(offendersUnder(SRC)).toEqual([]);
  });
});
