/**
 * Web resolution for the dashboard SPA's Vite build, and for the vitest run
 * that renders SPA components with `renderToStaticMarkup`.
 *
 * Ported from titan-design's `packages/ui/vite-rn-svg-plugins.ts`, which
 * already solved both halves for its own Storybook and test runs (VW-386).
 * `@titan-design/react-ui/bodymap` — the subpath `GoalMuscleCard` is published
 * on — reaches `react-native-body-highlighter`, and that package reaches
 * `react-native-svg`; neither resolves on web without the two plugins below.
 *
 * Confidentiality: pure build tooling — no protocol data of any kind.
 */
import { createRequire } from 'node:module';
import { dirname, resolve as resolvePath } from 'node:path';
import { existsSync } from 'node:fs';
import type { Alias, Plugin } from 'vite';
import type * as Esbuild from 'esbuild';

const require = createRequire(import.meta.url);
// esbuild ships as a vite dependency; resolve it from there rather than adding a direct one.
const esbuild = createRequire(require.resolve('vite'))('esbuild') as typeof Esbuild;

/** `.web.*`-first extension order so web platform files win over native. */
export const webResolveExtensions = [
  '.web.tsx',
  '.web.ts',
  '.web.jsx',
  '.web.js',
  '.mjs',
  '.js',
  '.mts',
  '.ts',
  '.jsx',
  '.tsx',
  '.json',
];

/** Absolute path to react-native-svg's ESM ("module") build entry. */
export const svgModuleEntry = ((): string => {
  try {
    return resolvePath(
      dirname(require.resolve('react-native-svg/package.json')),
      'lib/module/index.js',
    );
  } catch {
    return 'react-native-svg';
  }
})();

/**
 * react-native-svg ships its web implementations as `.web.js` siblings of the
 * native Flow sources and relies on React Native platform-extension resolution
 * to pick them. Node-based resolvers never honour `.web.js`, so its relative
 * imports would load the Flow files (`Unexpected token 'typeof'`). The bare
 * specifier is aliased by {@link svgWebAliases}; this rewrites each relative
 * import inside the package to its `.web.js` sibling when one exists.
 */
export function reactNativeSvgWebResolver(): Plugin {
  return {
    name: 'react-native-svg-web-resolver',
    enforce: 'pre',
    resolveId(source, importer) {
      if (
        importer === undefined ||
        !importer.includes('/react-native-svg/') ||
        !source.startsWith('.')
      ) {
        return null;
      }
      const base = resolvePath(dirname(importer), source);
      for (const candidate of [`${base}.web.js`, `${base}/index.web.js`]) {
        if (existsSync(candidate)) return candidate;
      }
      return null;
    },
  };
}

/**
 * Serve esbuild's own `__require` helper the one module the bundle below still
 * reaches for dynamically. That helper only throws when no `require` is in
 * scope, so declaring one here — over an import the bundler CAN resolve — is
 * what keeps the browser bundle from failing with `Dynamic require of "react"
 * is not supported` at first render. Node's CJS interop hid this: the vitest
 * run works without the banner and the `vite build` output does not.
 */
const BODY_HIGHLIGHTER_REQUIRE_BANNER = [
  'import * as __bodyHighlighterReact from "react";',
  'const require = (id) => {',
  '  if (id === "react") return __bodyHighlighterReact;',
  '  throw new Error(`react-native-body-highlighter required an unbundled module: ${id}`);',
  '};',
].join('\n');

/**
 * react-native-body-highlighter@3.2.0 ships untranspiled JSX inside a CommonJS
 * dist, which neither Rollup nor vitest's transform can parse, and its
 * `require('react-native-svg')` would load that package's native Flow sources.
 * Bundle the entry to one self-contained ESM module with esbuild instead: JSX
 * via the automatic runtime, react-native-svg's WEB build inlined, and
 * react/react-native left external so the app's own copies are used.
 */
export function reactNativeBodyHighlighterEsm(): Plugin {
  let entry: string | null = null;
  try {
    entry = require.resolve('react-native-body-highlighter');
  } catch {
    entry = null;
  }
  return {
    name: 'react-native-body-highlighter-esm',
    enforce: 'pre',
    async transform(_code, id) {
      if (entry === null || id.split('?')[0] !== entry) return null;
      const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        jsx: 'automatic',
        loader: { '.js': 'jsx' },
        alias: { 'react-native-svg': svgModuleEntry },
        resolveExtensions: webResolveExtensions,
        mainFields: ['module', 'main'],
        external: ['react', 'react/jsx-runtime', 'react-native'],
        banner: { js: BODY_HIGHLIGHTER_REQUIRE_BANNER },
        write: false,
        logLevel: 'silent',
      });
      return { code: result.outputFiles[0].text, map: null };
    },
  };
}

/** Alias entries that point react-native-svg at its web build. */
export const svgWebAliases: Alias[] = [{ find: /^react-native-svg$/, replacement: svgModuleEntry }];
