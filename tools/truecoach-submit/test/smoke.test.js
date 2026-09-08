// The one test that starts a real chromium. Gated on TRUECOACH_SMOKE=1 and
// never run in CI — this package is excluded from the repo's CI gate entirely.
//
// It stops at the dry-run screenshot. It never clicks submit, and it needs a
// profile that `truecoach-submit login` has already signed in, plus at least
// one pending outbox entry dated for a workout the account can see.
//
//   TRUECOACH_SMOKE=1 npm test -- smoke

import { describe, it, expect } from 'vitest';

import { listPending, readEntry } from '../src/outbox.js';
import { resolvePaths } from '../src/paths.js';
import { runAll } from '../src/run.js';

const enabled = process.env.TRUECOACH_SMOKE === '1';
const SMOKE_TIMEOUT_MS = 180_000;

describe.runIf(enabled)('playwright smoke (real browser, dry run only)', () => {
  it(
    "fills the day's workout and stops at the screenshot",
    async () => {
      // Arrange
      const paths = resolvePaths();
      const pending = listPending(paths);
      expect(pending.length, 'no pending outbox entry to smoke-test with').toBeGreaterThan(0);
      const session = readEntry(paths, pending[0]).sessionId;

      // Act: no `submit`, so nothing is ever clicked.
      const { results } = await runAll(paths, { session });

      // Assert
      expect(results[0]?.code).toBe('dry_run');
      expect(results[0]?.screenshot).toMatch(/\.png$/);
      console.error(`smoke screenshot: ${results[0]?.screenshot}`);
    },
    SMOKE_TIMEOUT_MS,
  );
});
