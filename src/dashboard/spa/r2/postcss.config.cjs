/**
 * PostCSS config for the R2 harness entry — mirrors ../postcss.config.cjs
 * but points Tailwind at this directory's config (TITAN_DIST-aware).
 */
const path = require('node:path');

module.exports = {
  plugins: {
    tailwindcss: { config: path.join(__dirname, 'tailwind.config.cjs') },
    autoprefixer: {},
  },
};
