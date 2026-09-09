import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Spawns a real child process and waits on a boot-readiness line; under full-suite
// parallel load the boot can miss that wait (VW-210, two flakes on 2026-09-08).
// Its own sequence group (below) keeps it off the CPU while the rest of the suite runs.
const LAUNCHER_TEST_FILE = 'src/__tests__/launcher.test.ts';
const ALL_TESTS_GLOB = 'src/**/*.{test,spec}.ts';

const alias = {
  '@': resolve(__dirname, 'src'),
  // The SPA is react-native-web; the same alias `src/dashboard/spa/vite.config.ts`
  // sets, so a test can render an SPA component with `renderToStaticMarkup`.
  'react-native': 'react-native-web',
};

// Vitest's project `extends` merges arrays (via Vite's mergeConfig) rather than
// replacing them, so an `extends: true` project's `include` would concatenate with
// the root's instead of narrowing it. Each project is defined standalone instead.
const server = {
  deps: {
    // titan ships untransformed react-native syntax; inline it so the render
    // tests can mount its components under the node environment.
    // WA 1.0.0 ships a pure-ESM build whose namespace is sealed by Node's ESM
    // loader; inlining lets vitest transform it into a CJS-style module so tests
    // can `vi.spyOn(analytics, 'foo')` instead of rewriting every call to a
    // `vi.mock(...)` factory.
    inline: ['@voltras/workout-analytics', '@titan-design/react-ui'],
  },
};

export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    globals: false,
    include: [ALL_TESTS_GLOB],
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          globals: false,
          server,
          include: [ALL_TESTS_GLOB],
          exclude: [LAUNCHER_TEST_FILE],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'launcher',
          environment: 'node',
          globals: false,
          server,
          include: [LAUNCHER_TEST_FILE],
          // Runs after the 'unit' group (default groupOrder 0) finishes, never alongside it.
          sequence: { groupOrder: 1 },
        },
      },
    ],
    server,
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
