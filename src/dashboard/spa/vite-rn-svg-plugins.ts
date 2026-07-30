/**
 * Web-resolution extension order for the dashboard SPA's Vite build.
 *
 * Confidentiality: pure build tooling — no protocol data of any kind.
 */

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
