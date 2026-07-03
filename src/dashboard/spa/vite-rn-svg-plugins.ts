/**
 * Web-resolution plugins for `react-native-svg` + `react-native-body-highlighter`
 * (Phase 3 BodyMap — VMCP-01.47).
 *
 * Both packages ship native (Flow) Fabric sources that a Node/esbuild resolver
 * loads instead of their `.web.js` siblings, and body-highlighter ships an
 * untranspiled-JSX CommonJS dist whose `exports.default` Rollup can't statically
 * import. This is a trimmed, npm-adapted port of titan-design's
 * `packages/ui/vite-rn-svg-plugins.ts` — the resolution proven by titan's
 * `build-storybook` PRODUCTION path. The SPA is only ever produced via
 * `vite build` (see package.json `build:dashboard`), so only the production
 * (Rollup) plugins are needed here; titan's dev-server optimizer variant is
 * intentionally omitted.
 *
 * NDA: pure build tooling — no protocol data of any kind.
 */
import { createRequire } from 'node:module';
import { dirname, resolve as resolvePath } from 'node:path';
import { existsSync } from 'node:fs';
import type { Alias, Plugin } from 'vite';
import type * as Esbuild from 'esbuild';

const require = createRequire(import.meta.url);

/**
 * esbuild resolution. Under npm's hoisted layout esbuild is a top-level
 * dependency of vite, so a plain `require('esbuild')` resolves it; fall back to
 * resolving it relative to vite (the pnpm-nested layout titan runs under).
 */
const esbuild = ((): typeof Esbuild => {
  try {
    return require('esbuild') as typeof Esbuild;
  } catch {
    return createRequire(require.resolve('vite'))('esbuild') as typeof Esbuild;
  }
})();

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
 * react-native-svg ships web implementations as `.web.js` siblings of its
 * native (Flow) Fabric sources and relies on a bundler's React Native
 * platform-extension resolution to pick them. Node-based resolvers never honor
 * `.web.js`, so its relative imports would load the native Flow files
 * (`Unexpected token 'typeof'`). The bare specifier is aliased to the ESM build
 * (see svgWebAliases); this plugin rewrites each relative import inside the
 * package to its `.web.js` sibling when one exists.
 */
export function reactNativeSvgWebResolver(): Plugin {
  return {
    name: 'react-native-svg-web-resolver',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !importer.includes('/react-native-svg/') || !source.startsWith('.')) {
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
 * react-native-body-highlighter@3.2.0 ships JSX-preserved (untranspiled)
 * CommonJS whose `require('react-native-svg')` would, under a Node resolver,
 * load react-native-svg's native Flow sources. Rollup's own commonjs pass can't
 * parse the JSX, so bundle the package entry to a single ESM module with esbuild
 * — JSX compiled via the automatic runtime and react-native-svg's WEB build
 * inlined, with react / react-native / react/jsx-runtime kept external so the
 * app's single copies are shared (body-highlighter calls `useCallback`, so a
 * duplicate React would trip "invalid hook call").
 *
 * esbuild wraps the CJS entry and lowers its `require("react")` calls to a
 * `__require` shim that throws in the browser ("Dynamic require of react is not
 * supported") — the exact failure titan's Storybook flagged. body-highlighter's
 * only react member is `useCallback` (its JSX already lowers to real
 * `react/jsx-runtime` ESM imports), so we rewrite those `__require("react")`
 * calls to a prepended `import * as … from "react"` namespace, keeping react a
 * shared external ESM import rather than a runtime require.
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
      if (!entry || id.split('?')[0] !== entry) return null;
      const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        jsx: 'automatic',
        loader: { '.js': 'jsx' },
        alias: { 'react-native-svg': svgModuleEntry },
        resolveExtensions: [
          '.web.js',
          '.web.ts',
          '.web.tsx',
          '.web.jsx',
          '.js',
          '.ts',
          '.tsx',
          '.jsx',
          '.json',
        ],
        mainFields: ['module', 'main'],
        external: ['react', 'react/jsx-runtime', 'react-native'],
        write: false,
        logLevel: 'silent',
      });
      const bundled = result.outputFiles[0].text;
      const code = `import * as __bhReact from "react";\n${bundled.replace(
        /__require\(\s*["']react["']\s*\)/g,
        '__bhReact',
      )}`;
      return { code, map: null };
    },
  };
}

/** Alias entries that point react-native-svg at its web build. */
export const svgWebAliases: Alias[] = [{ find: /^react-native-svg$/, replacement: svgModuleEntry }];

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
