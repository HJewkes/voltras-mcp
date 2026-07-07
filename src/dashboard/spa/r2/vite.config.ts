import path from 'node:path';
import fs from 'node:fs';
import { defineConfig, type Alias, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import {
  reactNativeSvgWebResolver,
  reactNativeBodyHighlighterEsm,
  svgWebAliases,
  webResolveExtensions,
} from '../vite-rn-svg-plugins';

/**
 * Vite config for the R2 React harness (second SPA entry).
 *
 * A SEPARATE config (not a second rollup input in the main config) so the
 * harness makes zero edits to the shipping SPA's build — minimizing the
 * conflict surface with concurrent work in this repo. It reuses the main
 * config's proven titan/RNW/nativewind resolution (see ../vite.config.ts for
 * the full rationale) and adds ONE harness-only twist:
 *
 * TITAN_DIST (env): absolute path to a locally built titan-design
 * `packages/ui` (its main branch), aliasing `@titan-design/react-ui` to that
 * build so unreleased components/props (RestTimer `displayOnly`, titan #81)
 * render for real. Unset → the npm 0.4.0 install is used and the harness's
 * CSS fallback hides RestTimer's action buttons instead. `resolve.dedupe`
 * pins react/react-native-web/nativewind to THIS repo's copies so the aliased
 * dist can't drag in a second React.
 *
 * Build:  npm run build:dashboard:r2                (npm titan 0.4.0)
 *         TITAN_DIST=/path/to/titan/packages/ui npm run build:dashboard:r2
 * Output: dist/spa/r2/ — servable under any static prefix (base './').
 */
function stripCssInteropDoctorJsx(): Plugin {
  // Copied from ../vite.config.ts (kept local to avoid editing the shared
  // file): neutralises the lone JSX expression in react-native-css-interop's
  // dev-only dist/doctor.js that Rollup cannot parse.
  const targetId = 'react-native-css-interop/dist/doctor.js';
  const jsxExpr = 'return <react-native-css-interop-jsx-pragma-check /> === true;';
  return {
    name: 'strip-css-interop-doctor-jsx',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith(targetId) || !code.includes(jsxExpr)) return null;
      return {
        code: code.replace(jsxExpr, 'return true; /* dev-only check, unused on web */'),
        map: null,
      };
    },
  };
}

function titanLocalAliases(): Alias[] {
  const titanDir = process.env.TITAN_DIST;
  if (!titanDir) return [];
  const dist = path.join(titanDir, 'dist');
  if (!fs.existsSync(path.join(dist, 'index.mjs'))) {
    throw new Error(
      `TITAN_DIST=${titanDir} has no dist/index.mjs — build titan first (pnpm build)`,
    );
  }
  return [
    {
      find: /^@titan-design\/react-ui\/theme\/global\.css$/,
      replacement: path.join(titanDir, 'src/theme/global.css'),
    },
    { find: /^@titan-design\/react-ui\/bodymap$/, replacement: path.join(dist, 'bodymap.mjs') },
    { find: /^@titan-design\/react-ui$/, replacement: path.join(dist, 'index.mjs') },
  ];
}

export default defineConfig({
  root: __dirname,
  base: './',
  define: { global: 'globalThis' },
  plugins: [
    stripCssInteropDoctorJsx(),
    reactNativeSvgWebResolver(),
    reactNativeBodyHighlighterEsm(),
    react(),
  ],
  css: {
    postcss: __dirname,
  },
  resolve: {
    alias: [
      ...titanLocalAliases(),
      ...svgWebAliases,
      { find: /^react-native$/, replacement: 'react-native-web' },
    ],
    // With TITAN_DIST set the aliased dist resolves its bare imports from the
    // titan worktree's node_modules; dedupe forces the singletons back to this
    // repo's copies (dual-React guard).
    dedupe: [
      'react',
      'react-dom',
      'react-native-web',
      'nativewind',
      'react-native-css-interop',
      'clsx',
      'tailwind-merge',
      'lucide-react',
      'react-native-body-highlighter',
    ],
    extensions: webResolveExtensions,
  },
  build: {
    outDir: path.resolve(__dirname, '../../../../dist/spa/r2'),
    emptyOutDir: true,
  },
});
