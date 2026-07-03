/**
 * Tailwind config for the dashboard SPA (VMCP-01.45).
 *
 * `@titan-design/react-ui`'s compiled components emit Tailwind utility class
 * strings (e.g. `text-4xl text-text-primary`) with no inline colours; those
 * classes only take effect if the consumer generates the matching CSS. This
 * reuses titan's own Tailwind theme (colours mapped to the `--color-*` CSS
 * variables in `theme/global.css`) and points `content` at the titan dist so
 * every class the shipped components use is generated.
 *
 * Mirrors titan's specimen build (packages/ui/specimen/vite.config.ts), which
 * runs the same tailwind + nativewind preset over the same theme.
 */
const path = require('node:path');
// Reusing titan's exported config also runs its `require('nativewind/preset')`,
// so `nativewind` is a build-time devDependency here.
const titanConfig = require('@titan-design/react-ui/tailwind.config.js');

// `./package.json` isn't in titan's exports map; `./tailwind.config.js` is, and
// it sits at the package root, so its dirname gives us the package directory.
const titanPkgDir = path.dirname(require.resolve('@titan-design/react-ui/tailwind.config.js'));

/** @type {import('tailwindcss').Config} */
module.exports = {
  ...titanConfig,
  content: [
    path.join(__dirname, '**/*.{ts,tsx,html}'),
    path.join(titanPkgDir, 'dist/**/*.{js,mjs}'),
  ],
};
