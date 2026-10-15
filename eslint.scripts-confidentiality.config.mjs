// Confidentiality-only ESLint pass over scripts/ (VW-497).
//
// scripts/ is deliberately not part of the main `eslint src tools/truecoach-retro`
// target: turning on the full recommended rule set there surfaces hundreds of
// pre-existing, unrelated violations (missing Node globals such as `process` and
// `console`, which src/**/*.ts never hits because typescript-eslint's recommended
// config turns `no-undef` off). A separate config file — rather than a second block
// in eslint.config.mjs — is what keeps this pass from ever loading js.configs.recommended
// or typescript-eslint's recommended config for these files, so it only ever runs the
// one rule it exists for.

import voltras from './eslint-rules/no-protocol-detail.mjs';

export default [
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    plugins: { voltras },
    rules: { 'voltras/no-protocol-detail': 'error' },
  },
];
