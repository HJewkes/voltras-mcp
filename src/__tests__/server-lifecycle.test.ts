// End-to-end lifecycle tests for the compiled server binary — VMCP-01.25
// (F11). Claude Code reloads of the MCP server can abandon the stdio pipe
// rather than close it cleanly; before this fix the old process stayed
// alive holding the dashboard port. These tests spawn the actual bin.js
// against the mock adapter and assert that:
//
//   1. SIGTERM triggers a clean exit (code 0) within 2s, even when the
//      dashboard sidecar is up.
//   2. Closing the child's stdin (the EOF path) triggers the same exit.
//   3. SIGTERM exits cleanly even when the dashboard is disabled
//      (`VMCP_DASHBOARD_PORT=off`) — the shutdown hook must be installed
//      regardless of dashboard state.
//
// We spawn the compiled binary (not the TS source) because the fix lives
// in process-wide signal/stdin handlers — in-process mocking would defeat
// the test. The mock adapter keeps spawn-time bootstrap fast and avoids
// touching real BLE.

import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const BIN_PATH = resolve(REPO_ROOT, 'dist/bin.js');

// Generous-but-bounded wall-clock budget. The fix's hard-timeout fallback
// inside `installShutdownHook` is 2s, so 4s here lets us distinguish
// "clean exit" from "hard-timeout exit" (which would surface as code 1).
const EXIT_TIMEOUT_MS = 4000;

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

/** Resolve when the child fires `exit`, or reject after `EXIT_TIMEOUT_MS`. */
function waitForExit(child: ChildProcessWithoutNullStreams): Promise<ExitResult> {
  const start = Date.now();
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectExit(new Error(`child did not exit within ${EXIT_TIMEOUT_MS}ms`));
    }, EXIT_TIMEOUT_MS);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal, durationMs: Date.now() - start });
    });
  });
}

/** Wait until the server has emitted the `voltras-mcp ready` signal on
 *  stderr (logger output), which `runServer` writes after the shutdown
 *  hook is armed. Watching the SDK's stdout `tools/list_changed` stream
 *  is too eager — those fire during placeholder registration before
 *  bootstrap (and the shutdown hook) is done. */
function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    let buf = '';
    const timer = setTimeout(
      () => rejectReady(new Error('server did not emit ready signal')),
      8000,
    );
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8');
      if (buf.includes('voltras-mcp ready')) {
        clearTimeout(timer);
        child.stderr.off('data', onData);
        resolveReady();
      }
    };
    child.stderr.on('data', onData);
  });
}

function spawnServer(env: Record<string, string> = {}): ChildProcessWithoutNullStreams {
  // Force pipes for stdin/stdout/stderr so we can drive EOF + capture
  // logs. `VOLTRA_ADAPTER=mock` skips real BLE bootstrap. Use a unique
  // dashboard port per spawn so parallel tests don't collide on bind.
  return spawn(process.execPath, [BIN_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      VOLTRA_ADAPTER: 'mock',
      VMCP_DB_PATH: ':memory:',
      ...env,
    },
  });
}

describe('server lifecycle (VMCP-01.25 / F11)', () => {
  beforeAll(() => {
    if (!existsSync(BIN_PATH)) {
      // Build once if dist is missing — this happens on fresh checkouts
      // and in CI where `npm test` is run before `npm run build`. The
      // build is fast (~2s) so paying it once per test process is fine.
      const result = spawnSync('npm', ['run', 'build'], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
      });
      if (result.status !== 0) {
        throw new Error('failed to build the server before lifecycle tests');
      }
    }
  });

  it('exits cleanly on SIGTERM within 2s (with dashboard sidecar up)', async () => {
    // Port 0 lets the OS pick a free port — avoids collisions across
    // concurrent test workers.
    const child = spawnServer({ VMCP_DASHBOARD_PORT: '0' });
    await waitForReady(child);
    child.kill('SIGTERM');
    const result = await waitForExit(child);
    expect(result.code).toBe(0);
    expect(result.durationMs).toBeLessThan(2000);
  });

  it('exits cleanly when stdin closes (EOF path)', async () => {
    const child = spawnServer({ VMCP_DASHBOARD_PORT: '0' });
    await waitForReady(child);
    // Closing the write side of the child's stdin is what Claude Code's
    // graceful shutdown does; before the fix the server ignored this
    // because the SDK's stdio transport doesn't end the process on EOF.
    child.stdin.end();
    const result = await waitForExit(child);
    expect(result.code).toBe(0);
    expect(result.durationMs).toBeLessThan(2000);
  });

  it('exits cleanly on SIGTERM with the dashboard disabled (VMCP_DASHBOARD_PORT=off)', async () => {
    // This is the explicit regression case: before the fix, the shutdown
    // hook was only installed when `dashboardHandle !== undefined`, so a
    // server started with the dashboard disabled would not exit on
    // SIGTERM at all (until the SDK's default signal handling killed it).
    const child = spawnServer({ VMCP_DASHBOARD_PORT: 'off' });
    await waitForReady(child);
    child.kill('SIGTERM');
    const result = await waitForExit(child);
    expect(result.code).toBe(0);
    expect(result.durationMs).toBeLessThan(2000);
  });
});
