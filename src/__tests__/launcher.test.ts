// Exercises the plugin launcher shim (plugins/voltras-channel/bin/voltras-mcp-launch.sh)
// against the mock adapter — VW-66. Mirrors server-lifecycle.test.ts's spawn/wait
// helpers, but spawns the shell script rather than dist/bin.js directly, so a
// regression in the script's env resolution or SPA-freshness check shows up here.

import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const LAUNCHER_PATH = resolve(REPO_ROOT, 'plugins/voltras-channel/bin/voltras-mcp-launch.sh');

const EXIT_TIMEOUT_MS = 15000;
const READY_TIMEOUT_MS = 15000;

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<ExitResult> {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectExit(new Error(`launcher did not exit within ${EXIT_TIMEOUT_MS}ms`));
    }, EXIT_TIMEOUT_MS);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    let buf = '';
    const timer = setTimeout(
      () => rejectReady(new Error(`launcher did not print its ready line: ${buf}`)),
      READY_TIMEOUT_MS,
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

describe('plugin launcher shim (VW-66)', () => {
  beforeAll(() => {
    const binPath = resolve(REPO_ROOT, 'dist/bin.js');
    if (!existsSync(binPath)) {
      const result = spawnSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
      if (result.status !== 0) throw new Error('failed to build the server before launcher tests');
    }
  });

  it('launches against the mock adapter and exits cleanly on SIGTERM', async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), 'vmcp-launcher-test-'));
    const dbPath = resolve(tmpDir, 'vmcp.sqlite');
    try {
      const child = spawn(LAUNCHER_PATH, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          VOLTRAS_MCP_HOME: REPO_ROOT,
          VOLTRA_ADAPTER: 'mock',
          VMCP_DB_PATH: dbPath,
          VMCP_DASHBOARD_PORT: '0',
        },
      });
      await waitForReady(child);
      child.kill('SIGTERM');
      const result = await waitForExit(child);
      expect(result.code).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
