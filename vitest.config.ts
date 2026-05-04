import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.{test,spec}.ts', 'src/bin.ts', 'src/types/**'],
      // NF-03 thresholds: 80% branch for tools/resources/state/store/errors,
      // 70% branch for the event-bridge.
      thresholds: {
        'src/tools/**/*.ts': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        'src/resources/**/*.ts': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        'src/state/**/*.ts': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        'src/state/event-bridge.ts': {
          branches: 70,
          functions: 70,
          lines: 70,
          statements: 70,
        },
        'src/store/**/*.ts': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        'src/errors.ts': {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
      },
    },
  },
});
