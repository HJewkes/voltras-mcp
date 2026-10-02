// The fidelity build's Vite plugin (VW-797, VW-431 S2). The transform runs on esbuild output,
// so fixtures are plain JavaScript with `jsx()` calls where the source had JSX.

import { parseAst } from 'rollup/parseAst';
import type { ConfigEnv, Plugin } from 'vite';
import { describe, expect, it } from 'vitest';

import {
  fidelityPlugin,
  titanVirtualId,
  titanVirtualModule,
  transformSpaModule,
  type ProgramLike,
  type SpaModuleOptions,
} from '../spa/dev/fidelity/vite-plugin.js';

const SOURCE = 'src/dashboard/spa/goals/Example.tsx';
const OPTIONS: SpaModuleOptions = {
  source: SOURCE,
  tagComponents: true,
  withProvenanceImport: '/spa/dev/fidelity/with-provenance.tsx',
};

function transform(code: string, options: SpaModuleOptions = OPTIONS) {
  return transformSpaModule(code, parseAst(code) as unknown as ProgramLike, options);
}

function exportedFunctionNames(code: string): string[] {
  return parseAst(code).body.flatMap((node) =>
    node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration'
      ? [node.declaration.id.name]
      : [],
  );
}

describe('transformSpaModule', () => {
  it('reassigns a top-level function component to its provenance wrapper', () => {
    const result = transform(`function PanelCard(props) { return jsx('div', props); }\n`);

    expect(result.instrumented).toEqual(['PanelCard']);
    expect(result.code).toContain(
      `PanelCard = __vmcpWithProvenance(PanelCard, {"kind":"spa","name":"PanelCard","source":"${SOURCE}"});`,
    );
    expect(result.code).toMatch(/^import \{ withProvenance as __vmcpWithProvenance \} from "\/spa/);
  });

  it('leaves hooks, helpers and constants alone', () => {
    const code = [
      `function useGoalPoll() { return null; }`,
      `function formatLoad(value) { return String(value); }`,
      `const Limit = 3;`,
      `const ThemeContext = createContext(null);`,
      '',
    ].join('\n');

    const result = transform(code);

    expect(result).toEqual({ code, instrumented: [], uninstrumented: [], titanImports: 0 });
  });

  it('keeps an exported function component exported after wrapping it', () => {
    const result = transform(
      `export function GoalsView() { return jsx(Inner, {}); }\nfunction Inner() { return null; }\n`,
    );

    expect(result.instrumented).toEqual(['GoalsView', 'Inner']);
    expect(exportedFunctionNames(result.code)).toEqual(['GoalsView']);
    expect(result.code).toContain('GoalsView = __vmcpWithProvenance(GoalsView,');
  });

  it('reports const and default-export components as not instrumented, unchanged', () => {
    const code = [
      `const StatRow = (props) => jsx('div', props);`,
      `export const Tile = memo(function Tile() { return null; });`,
      `const Field = React.forwardRef((props, ref) => jsx('input', { ...props, ref }));`,
      `export default function Page() { return null; }`,
      '',
    ].join('\n');

    const result = transform(code);

    expect(result.code).toBe(code);
    expect(result.instrumented).toEqual([]);
    expect(result.uninstrumented).toEqual(['StatRow', 'Tile', 'Field', 'Page']);
  });

  it('skips an opted-out name even when it is a function component', () => {
    const result = transform(`function Carousel() { return null; }\n`);

    expect(result.instrumented).toEqual([]);
    expect(result.code).not.toContain('__vmcpWithProvenance');
  });

  it('redirects named titan imports to a per-importer virtual module', () => {
    const code = [
      `import { Surface, useTimer } from '@titan-design/react-ui';`,
      `import { BodyMap } from '@titan-design/react-ui/bodymap';`,
      `import * as titan from '@titan-design/react-ui';`,
      `import { useState } from 'react';`,
      '',
    ].join('\n');

    const result = transform(code, { ...OPTIONS, tagComponents: false });

    const sources = parseAst(result.code).body.map((node) =>
      node.type === 'ImportDeclaration' ? node.source.value : null,
    );
    expect(result.titanImports).toBe(2);
    expect(sources).toEqual([
      titanVirtualId('@titan-design/react-ui', ['Surface', 'useTimer'], SOURCE),
      titanVirtualId('@titan-design/react-ui/bodymap', ['BodyMap'], SOURCE),
      '@titan-design/react-ui',
      'react',
    ]);
  });

  it('does not tag function components in a .ts module', () => {
    const result = transform(`export function Helper() { return null; }\n`, {
      ...OPTIONS,
      tagComponents: false,
    });

    expect(result.instrumented).toEqual([]);
    expect(result.code).not.toContain('__vmcpWithProvenance');
  });
});

describe('titanVirtualModule', () => {
  it('wraps PascalCase bindings and passes hooks, constants and opted-out names through', () => {
    const id = titanVirtualId(
      '@titan-design/react-ui',
      ['Surface', 'useTimer', 'TONE_TOKEN', 'Carousel'],
      SOURCE,
    );

    const code = titanVirtualModule(`\0${id}`);

    expect(code).toContain(
      'export { useTimer, TONE_TOKEN, Carousel } from "@titan-design/react-ui";',
    );
    expect(code).toContain(
      'export const Surface = tagTitan(__titan_Surface, "Surface", "@titan-design/react-ui");',
    );
    expect(code).not.toContain('__titan_Carousel');
  });
});

describe('fidelityPlugin', () => {
  const applies = (plugin: Plugin, mode: string): boolean => {
    const env: ConfigEnv = { mode, command: 'build' };
    return typeof plugin.apply === 'function' && plugin.apply({}, env);
  };

  it('applies only in fidelity mode', () => {
    const plugin = fidelityPlugin('/repo/src/dashboard/spa');

    expect(applies(plugin, 'fidelity')).toBe(true);
    expect(applies(plugin, 'production')).toBe(false);
    expect(applies(plugin, 'development')).toBe(false);
  });
});
