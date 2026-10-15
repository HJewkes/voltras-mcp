// Dev-only Vite plugin for the fidelity build (VW-431). It runs only under `--mode fidelity`.

import path from 'node:path';

import type { Plugin, ResolvedConfig } from 'vite';

export const FIDELITY_MODE = 'fidelity';
export const TITAN_SPECIFIERS: readonly string[] = [
  '@titan-design/react-ui',
  '@titan-design/react-ui/bodymap',
];
// Parents that match children by component type would see the wrapper instead (Carousel checks its slides).
export const FIDELITY_OPT_OUT: ReadonlySet<string> = new Set(['Carousel', 'CarouselSlide']);

const TITAN_VIRTUAL_PREFIX = 'virtual:vmcp-fidelity-titan?';
const RUNTIME_ID = 'virtual:vmcp-fidelity-runtime';
const WRAP_IDENTIFIER = '__vmcpWithProvenance';
const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*$/;
const COMPONENT_FACTORIES = /(^|\.)(memo|forwardRef)$/;

interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}
interface Identifier extends AstNode {
  readonly name: string;
}
interface Literal extends AstNode {
  readonly value: unknown;
}
interface ImportSpecifierNode extends AstNode {
  readonly imported?: Identifier | Literal;
}
interface ImportDeclarationNode extends AstNode {
  readonly source: Literal;
  readonly specifiers: readonly ImportSpecifierNode[];
}
interface DeclaratorNode extends AstNode {
  readonly id: AstNode;
  readonly init: (AstNode & { readonly callee?: AstNode }) | null;
}
interface DeclarationNode extends AstNode {
  readonly id?: Identifier | null;
  readonly declarations?: readonly DeclaratorNode[];
}
interface StatementNode extends AstNode {
  readonly declaration?: DeclarationNode | null;
}
export interface ProgramLike {
  readonly body: readonly AstNode[];
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface SpaModuleOptions {
  /** Repo-relative path recorded as the component's source. */
  readonly source: string;
  /** Top-level function components are only tagged in `.tsx` modules. */
  readonly tagComponents: boolean;
  readonly withProvenanceImport: string;
}

export interface SpaModuleResult {
  readonly code: string;
  readonly instrumented: readonly string[];
  readonly uninstrumented: readonly string[];
  readonly titanImports: number;
}

function isPascalCase(name: string | undefined): name is string {
  return name !== undefined && PASCAL_CASE.test(name);
}

function importedName(specifier: ImportSpecifierNode): string | undefined {
  if (specifier.type !== 'ImportSpecifier' || specifier.imported === undefined) return undefined;
  const imported = specifier.imported;
  return 'name' in imported ? imported.name : String(imported.value);
}

/** The virtual module id one SPA import site of a titan entry point is redirected to. */
export function titanVirtualId(
  specifier: string,
  names: readonly string[],
  importer: string,
): string {
  const query = new URLSearchParams({ spec: specifier, names: names.join(','), from: importer });
  return `${TITAN_VIRTUAL_PREFIX}${query.toString()}`;
}

function titanImportEdit(node: AstNode, importer: string): Edit | undefined {
  if (node.type !== 'ImportDeclaration') return undefined;
  const declaration = node as ImportDeclarationNode;
  const specifier = declaration.source.value;
  if (typeof specifier !== 'string' || !TITAN_SPECIFIERS.includes(specifier)) return undefined;
  const names = declaration.specifiers.map(importedName);
  if (names.length === 0 || names.some((name) => name === undefined)) return undefined;
  const id = titanVirtualId(specifier, names as string[], importer);
  return { start: declaration.source.start, end: declaration.source.end, text: JSON.stringify(id) };
}

/** The function declaration a top-level statement introduces, if it is a PascalCase one. */
function functionComponentName(node: AstNode): string | undefined {
  const statement = node as StatementNode;
  const declaration = node.type === 'ExportNamedDeclaration' ? statement.declaration : node;
  if (declaration?.type !== 'FunctionDeclaration') return undefined;
  const name = (declaration as DeclarationNode).id?.name;
  return isPascalCase(name) ? name : undefined;
}

/** PascalCase components the transform sees but cannot reassign: `const` components and default exports. */
function uninstrumentedNames(node: AstNode): string[] {
  const statement = node as StatementNode;
  if (node.type === 'ExportDefaultDeclaration') {
    const name = statement.declaration?.id?.name;
    return isPascalCase(name) ? [name] : [];
  }
  const declaration: DeclarationNode | null | undefined =
    node.type === 'ExportNamedDeclaration' ? statement.declaration : node;
  if (declaration?.type !== 'VariableDeclaration') return [];
  return (declaration.declarations ?? [])
    .filter(
      (declarator) => declarator.id.type === 'Identifier' && isComponentValue(declarator.init),
    )
    .map((declarator) => (declarator.id as Identifier).name)
    .filter(isPascalCase);
}

function calleeText(callee: AstNode | undefined): string {
  if (callee?.type === 'Identifier') return (callee as Identifier).name;
  if (callee?.type !== 'MemberExpression') return '';
  const member = callee as AstNode & { readonly object: AstNode; readonly property: AstNode };
  return `${calleeText(member.object)}.${calleeText(member.property)}`;
}

function isComponentValue(init: DeclaratorNode['init']): boolean {
  if (init === null) return false;
  if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') return true;
  return init.type === 'CallExpression' && COMPONENT_FACTORIES.test(calleeText(init.callee));
}

function applyEdits(code: string, edits: readonly Edit[]): string {
  return [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce((out, edit) => out.slice(0, edit.start) + edit.text + out.slice(edit.end), code);
}

function wrapStatement(name: string, source: string): string {
  const meta = JSON.stringify({ kind: 'spa', name, source });
  return `\n${name} = ${WRAP_IDENTIFIER}(${name}, ${meta});`;
}

/**
 * Pure transform of one SPA module, run after esbuild has stripped types and JSX: it redirects
 * titan imports to a per-importer virtual module and reassigns each top-level PascalCase function
 * component to its provenance wrapper, which also updates the live ES export.
 */
export function transformSpaModule(
  code: string,
  program: ProgramLike,
  options: SpaModuleOptions,
): SpaModuleResult {
  const edits: Edit[] = [];
  const instrumented: string[] = [];
  const uninstrumented: string[] = [];
  let titanImports = 0;
  for (const node of program.body) {
    const titanEdit = titanImportEdit(node, options.source);
    if (titanEdit !== undefined) {
      edits.push(titanEdit);
      titanImports += 1;
    }
    if (!options.tagComponents) continue;
    const name = functionComponentName(node);
    if (name !== undefined && !FIDELITY_OPT_OUT.has(name)) {
      instrumented.push(name);
      edits.push({ start: node.end, end: node.end, text: wrapStatement(name, options.source) });
    }
    uninstrumented.push(...uninstrumentedNames(node));
  }
  if (instrumented.length > 0) {
    const importLine = `import { withProvenance as ${WRAP_IDENTIFIER} } from ${JSON.stringify(options.withProvenanceImport)};\n`;
    edits.push({ start: 0, end: 0, text: importLine });
  }
  return { code: applyEdits(code, edits), instrumented, uninstrumented, titanImports };
}

/** Appended to a module with uninstrumented components so the overlay can list them at runtime. */
export function uninstrumentedNote(
  source: string,
  names: readonly string[],
  registryImport: string,
): string {
  if (names.length === 0) return '';
  return [
    '',
    `import { noteUninstrumented as __vmcpNoteUninstrumented } from ${JSON.stringify(registryImport)};`,
    `__vmcpNoteUninstrumented(${JSON.stringify(source)}, ${JSON.stringify(names)});`,
  ].join('\n');
}

/** Source of the virtual module one titan import site resolves to: components wrapped, the rest passed through. */
export function titanVirtualModule(id: string): string {
  const query = new URLSearchParams(id.slice(id.indexOf('?') + 1));
  const specifier = query.get('spec') ?? '';
  const names = (query.get('names') ?? '').split(',').filter(Boolean);
  const tagged = names.filter((name) => isPascalCase(name) && !FIDELITY_OPT_OUT.has(name));
  const passed = names.filter((name) => !tagged.includes(name));
  const lines = [`import { tagTitan } from ${JSON.stringify(RUNTIME_ID)};`];
  if (passed.length > 0)
    lines.push(`export { ${passed.join(', ')} } from ${JSON.stringify(specifier)};`);
  if (tagged.length > 0) {
    const locals = tagged.map((name) => `${name} as __titan_${name}`).join(', ');
    lines.push(`import { ${locals} } from ${JSON.stringify(specifier)};`);
    for (const name of tagged) {
      lines.push(
        `export const ${name} = tagTitan(__titan_${name}, ${JSON.stringify(name)}, ${JSON.stringify(specifier)});`,
      );
    }
  }
  return lines.join('\n');
}

/** Shared by every titan virtual module, so one titan component gets one wrapper; non-components pass through. */
function runtimeModule(withProvenancePath: string): string {
  return [
    `import { withProvenance } from ${JSON.stringify(withProvenancePath)};`,
    `const REACT_COMPONENT_TYPES = new Set([Symbol.for('react.forward_ref'), Symbol.for('react.memo')]);`,
    `const wrappers = new Map();`,
    `export function tagTitan(value, name, source) {`,
    `  const isComponent = typeof value === 'function' ||`,
    `    (typeof value === 'object' && value !== null && REACT_COMPONENT_TYPES.has(value.$$typeof));`,
    `  if (!isComponent) return value;`,
    `  const key = source + '#' + name;`,
    `  if (!wrappers.has(key)) wrappers.set(key, withProvenance(value, { kind: 'titan', name, source }));`,
    `  return wrappers.get(key);`,
    `}`,
  ].join('\n');
}

function spaModuleOptions(
  id: string,
  spaRoot: string,
  repoRoot: string,
): SpaModuleOptions | undefined {
  const file = id.split('?')[0] ?? id;
  if (!/\.tsx?$/.test(file) || !file.startsWith(spaRoot + path.sep)) return undefined;
  if (file.startsWith(path.join(spaRoot, 'dev') + path.sep)) return undefined;
  return {
    source: path.relative(repoRoot, file).split(path.sep).join('/'),
    tagComponents: file.endsWith('.tsx'),
    withProvenanceImport: path.join(spaRoot, 'dev', 'fidelity', 'with-provenance.tsx'),
  };
}

const MOUNT_TAG = {
  tag: 'script',
  attrs: { type: 'module', src: '/dev/fidelity/mount.tsx' },
  injectTo: 'body',
} as const;

/** Tags titan and SPA-local components with provenance and mounts the overlay entry; fidelity mode only. */
export function fidelityPlugin(spaRoot: string): Plugin {
  const repoRoot = path.resolve(spaRoot, '..', '..', '..');
  const uninstrumented: string[] = [];
  let instrumentedCount = 0;
  let logger: ResolvedConfig['logger'] | undefined;
  return {
    name: 'vmcp-fidelity',
    apply: (_config, env) => env.mode === FIDELITY_MODE,
    configResolved(config) {
      logger = config.logger;
    },
    resolveId(id) {
      return id === RUNTIME_ID || id.startsWith(TITAN_VIRTUAL_PREFIX) ? `\0${id}` : null;
    },
    load(id) {
      if (id === `\0${RUNTIME_ID}`) {
        return runtimeModule(path.join(spaRoot, 'dev', 'fidelity', 'with-provenance.tsx'));
      }
      return id.startsWith(`\0${TITAN_VIRTUAL_PREFIX}`) ? titanVirtualModule(id) : null;
    },
    transform(code, id) {
      const options = spaModuleOptions(id, spaRoot, repoRoot);
      if (options === undefined) return null;
      const result = transformSpaModule(code, this.parse(code) as unknown as ProgramLike, options);
      instrumentedCount += result.instrumented.length;
      uninstrumented.push(...result.uninstrumented.map((name) => `${options.source}#${name}`));
      const registry = path.join(spaRoot, 'dev', 'fidelity', 'registry.ts');
      const out = result.code + uninstrumentedNote(options.source, result.uninstrumented, registry);
      return out === code ? null : { code: out, map: null };
    },
    buildEnd() {
      logger?.info(
        `fidelity: ${instrumentedCount} SPA components tagged; not instrumented: ${uninstrumented.join(', ') || 'none'}`,
      );
    },
    transformIndexHtml: { order: 'pre', handler: () => [MOUNT_TAG] },
  };
}
