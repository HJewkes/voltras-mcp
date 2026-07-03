import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {
  reactNativeSvgWebResolver,
  reactNativeBodyHighlighterEsm,
  svgWebAliases,
  webResolveExtensions,
} from './vite-rn-svg-plugins';

/**
 * Vite config for the dashboard SPA (VMCP-01.44 / Phase 3 VMCP-01.47).
 *
 * `@titan-design/react-ui` is a React Native component library that runs on web
 * via react-native-web. Consuming its PUBLISHED `dist` (not its source) keeps the
 * resolution surface small, but its barrel reaches bare specifiers a browser
 * bundler can't resolve as-is:
 *
 *   1. `react-native`                  -> aliased to `react-native-web`
 *   2. `react-native-svg`              -> aliased to its ESM ("module") build,
 *      with its `.web.js` platform siblings selected by
 *      `reactNativeSvgWebResolver()` (Node resolvers ignore `.web.js` and would
 *      load the native Flow sources).
 *   3. `react-native-body-highlighter` -> esbuild-bundled to self-contained ESM
 *      by `reactNativeBodyHighlighterEsm()` (untranspiled-JSX CJS dist with no
 *      static ESM default; rn-svg web build inlined, react/react-native external).
 *
 * Phase 3 un-stubs BodyMap: (2) + (3) replace the former no-op body-highlighter
 * stub so the real muscle SVG renders. See `vite-rn-svg-plugins.ts` (an npm port
 * of titan-design's proven build-storybook resolution). The SPA is only produced
 * via `vite build`, so the production (Rollup) plugins suffice.
 *
 * The published `dist` bakes its own `$$css` JSX runtime, so plain
 * `@vitejs/plugin-react` is sufficient (no nativewind jsxImportSource).
 *
 * Theming (VMCP-01.45): those compiled components emit Tailwind class strings
 * (e.g. `text-text-primary`) with no inline colours, so the Tailwind CSS must be
 * generated for them to render legibly. `css.postcss` points at this directory,
 * whose `postcss.config.cjs` runs Tailwind (titan's theme) + autoprefixer — the
 * config path is a plain string so this typechecked file needs no `tailwindcss`
 * / `autoprefixer` type deps.
 *
 * Served by the sidecar under `/app/` (see src/dashboard/server.ts), hence
 * `base: '/app/'` so emitted asset URLs are `/app/assets/...`.
 */
export default defineConfig({
  root: __dirname,
  base: '/app/',
  plugins: [reactNativeSvgWebResolver(), reactNativeBodyHighlighterEsm(), react()],
  css: {
    postcss: __dirname,
  },
  resolve: {
    alias: [...svgWebAliases, { find: /^react-native$/, replacement: 'react-native-web' }],
    extensions: webResolveExtensions,
  },
  build: {
    outDir: path.resolve(__dirname, '../../../dist/spa'),
    emptyOutDir: true,
  },
});
