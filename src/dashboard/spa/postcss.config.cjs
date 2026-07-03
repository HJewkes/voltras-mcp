/**
 * PostCSS config for the dashboard SPA (VMCP-01.45).
 *
 * Runs Tailwind (with titan's theme via tailwind.config.cjs) + autoprefixer so
 * the Tailwind class strings baked into the titan-design components resolve to
 * real CSS. Vite loads this via `css.postcss` pointed at this directory (see
 * vite.config.ts). Kept as `.cjs` so it stays out of the SPA tsconfig.
 */
const path = require('node:path');

module.exports = {
  plugins: {
    tailwindcss: { config: path.join(__dirname, 'tailwind.config.cjs') },
    autoprefixer: {},
  },
};
