import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config for the Phase 0 dashboard SPA (VMCP-01.44).
 *
 * `@titan-design/react-ui` is a React Native component library that runs on web
 * via react-native-web. Consuming its PUBLISHED `dist` (not its source) keeps the
 * resolution surface small — the compiled barrel only reaches two bare specifiers
 * that a browser bundler can't resolve as-is:
 *
 *   1. `react-native`                  -> aliased to `react-native-web`
 *   2. `react-native-body-highlighter` -> aliased to a no-op stub (Phase 3 concern;
 *      the package has no web build and does a dynamic `require('react')` that
 *      throws in browser ESM). Stubbing it also means the barrel never reaches
 *      `react-native-svg`, so — unlike titan-design's own specimen config — no svg
 *      web-resolver plugin is needed here.
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
  plugins: [react()],
  css: {
    postcss: __dirname,
  },
  resolve: {
    alias: [
      { find: /^react-native$/, replacement: 'react-native-web' },
      {
        find: /^react-native-body-highlighter$/,
        replacement: path.resolve(__dirname, 'stubs/react-native-body-highlighter.tsx'),
      },
    ],
    extensions: [
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
    ],
  },
  build: {
    outDir: path.resolve(__dirname, '../../../dist/spa'),
    emptyOutDir: true,
  },
});
