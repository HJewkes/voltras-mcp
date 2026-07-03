// ESLint 9 flat config for voltras-mcp.
//
// Notable rules:
// - `no-console`: only `warn`/`error` permitted; bare `log` is blocked so stdio
//   stays reserved for the MCP transport.
// - `no-restricted-syntax` (NF-07): tool handler functions (any function whose
//   identifier ends with `Handler`) must not reference `Buffer.*` directly.
//   Tool handler returns are JSON-typed; raw bytes never cross the MCP boundary.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
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
      'no-restricted-syntax': [
        'error',
        {
          selector:
            ':matches(FunctionDeclaration[id.name=/Handler$/], VariableDeclarator[id.name=/Handler$/]) MemberExpression[object.name="Buffer"]',
          message:
            'Tool handler functions must not reference Buffer directly (NF-07). Return JSON-typed values via textResult().',
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
