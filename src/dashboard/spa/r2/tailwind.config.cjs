/**
 * Tailwind config for the R2 harness entry.
 *
 * Same approach as ../tailwind.config.cjs (titan theme + content scan over
 * the titan dist so the compiled components' class strings resolve), plus:
 * when TITAN_DIST points at a locally built titan main, scan THAT dist too —
 * unreleased components (RestTimer displayOnly, #81) may use classes the npm
 * 0.4.0 dist never emits.
 */
const path = require('node:path');
const titanConfig = require('@titan-design/react-ui/tailwind.config.js');

const titanPkgDir = path.dirname(require.resolve('@titan-design/react-ui/tailwind.config.js'));
const content = [
  path.join(__dirname, '**/*.{ts,tsx,html}'),
  path.join(titanPkgDir, 'dist/**/*.{js,mjs}'),
];
if (process.env.TITAN_DIST) {
  content.push(path.join(process.env.TITAN_DIST, 'dist/**/*.{js,mjs}'));
}

/** @type {import('tailwindcss').Config} */
module.exports = {
  ...titanConfig,
  content,
};
