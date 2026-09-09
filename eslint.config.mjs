// ESLint 9 flat config for voltras-mcp.
//
// Notable rules:
// - `no-console`: only `warn`/`error` permitted; bare `log` is blocked so stdio
//   stays reserved for the MCP transport.
// - `no-restricted-syntax` (NF-07): tool handler functions (any function whose
//   identifier ends with `Handler`) must not reference `Buffer.*` directly.
//   Tool handler returns are JSON-typed; raw bytes never cross the MCP boundary.
// - VW-64: derived view-model metrics must come from
//   `@voltras/workout-analytics/view`, not the package root (a `no-restricted-syntax`
//   selector on named import specifiers) or a `dist/**` deep import
//   (`no-restricted-imports`). Root-only exports (types, rep/phase/set primitives,
//   non-view-model analytics functions) are unaffected.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `tools/**` holds standalone packages with their own dependencies and
    // toolchains (see tools/truecoach-submit). They are never part of this
    // package's lint, typecheck, test or build.
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'tools/**',
      'site/.vitepress/dist/**',
      'site/.vitepress/cache/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        projectService: false,
      },
    },
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // NF-07: ban Buffer.* references inside any function whose identifier
      // ends with `Handler`. Handler returns must be JSON-typed.
      // VW-64: restrict only the named view-model exports the root re-exports
      // during the WA 2.x deprecation window. A selector (not `no-restricted-imports`
      // `importNames`) so a bare `import * as analytics from '@voltras/workout-analytics'`
      // (several test files, none of which touch these names) is not flagged —
      // `importNames` cannot statically tell what a namespace import accesses and
      // would flag every one of them regardless of use.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            ':matches(FunctionDeclaration[id.name=/Handler$/], VariableDeclarator[id.name=/Handler$/]) MemberExpression[object.name="Buffer"]',
          message:
            'Tool handler functions must not reference Buffer directly (NF-07). Return JSON-typed values via textResult().',
        },
        {
          selector:
            'ImportDeclaration[source.value="@voltras/workout-analytics"] > ImportSpecifier[imported.name=/^(estimateSetRpe|velocityLossVerdict|getSetRepPeakVelocities|getSetRepMeanVelocities|getSetTempoSeconds|bestE1RMAcrossSets|isNewE1RM|weightDeviationRatio|classifyWeeklyVolume|E1RMSetInput|VolumeLandmarks|VolumeStatusName|VelocityLossVerdict)$/]',
          message:
            'Import view-model metrics from "@voltras/workout-analytics/view", not the package root (VW-64).',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@voltras/workout-analytics/dist/*', '@voltras/workout-analytics/dist/**'],
              message:
                'Do not deep-import into @voltras/workout-analytics/dist; use "@voltras/workout-analytics/view" instead (VW-64).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // CommonJS build-config files (dashboard SPA Tailwind/PostCSS). These run in
    // a Node CJS context (require/module/__dirname) and are not part of any
    // tsconfig — allow the CJS idioms the flat/TS recommended configs forbid.
    files: ['src/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', __dirname: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-undef': 'off',
    },
  },
  {
    // Phase 0 dashboard SPA (VMCP-01.44): browser-targeted React (.tsx) plus its
    // Vite/node build config. These files are excluded from the main tsconfig
    // (they use jsx + DOM libs) and typechecked separately via
    // `npm run typecheck:spa`. `no-undef` is off here — the correct setting for
    // TypeScript sources, where the compiler (not ESLint) resolves symbols; the
    // SPA's own tsconfig provides the DOM/browser lib so undefined-symbol errors
    // still surface at typecheck.
    files: ['src/dashboard/spa/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'no-undef': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
