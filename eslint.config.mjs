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
);
