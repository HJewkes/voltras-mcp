import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // The SPA is react-native-web; the same alias `src/dashboard/spa/vite.config.ts`
      // sets, so a test can render an SPA component with `renderToStaticMarkup`.
      'react-native': 'react-native-web',
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.{test,spec}.ts'],
    server: {
      // WA 1.0.0 ships a pure-ESM build whose namespace is sealed by Node's
      // ESM loader. Inlining lets vitest transform it into a CJS-style module
      // so tests can `vi.spyOn(analytics, 'foo')` instead of rewriting every
      // call to a `vi.mock(...)` factory.
      deps: {
        // titan ships untransformed react-native syntax; inline it so the render
        // tests can mount its components under the node environment.
        inline: ['@voltras/workout-analytics', '@titan-design/react-ui'],
      },
    },
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
