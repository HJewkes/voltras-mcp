// Integration test for the agent-transcript exporter (VW-597, VW-257 slice S2):
// `scripts/export-agent-transcript.mjs` boots the compiled server on the mock
// adapter, plays a synthetic exchange over stdio, and writes a transcript only
// when every redaction gate passes. Spawns real processes, so it runs in its
// own sequence group (vitest.config.ts).

import { beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentTranscriptSchema, assertScreenSafe } from '../../docs/agent-transcript.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const EXPORTER = join(REPO_ROOT, 'scripts/export-agent-transcript.mjs');
const FIXTURE = join(REPO_ROOT, 'src/__tests__/fixtures/connect-and-set.exchange.json');
const BUILT_MODULE = join(REPO_ROOT, 'dist/docs/agent-transcript.js');
// Same budget as server-lifecycle.test.ts: CI's test job builds on two loaded cores.
const BUILD_HOOK_TIMEOUT_MS = 180_000;
const EXPORT_TIMEOUT_MS = 120_000;

interface ExportRun {
  readonly code: number | null;
  readonly stderr: string;
  readonly out: string;
}

function runExporter(exchangePath: string, env: Record<string, string> = {}): Promise<ExportRun> {
  const out = join(mkdtempSync(join(tmpdir(), 'vmcp-export-it-')), 'transcript.json');
  const child = spawn(process.execPath, [EXPORTER, '--exchange', exchangePath, '--out', out], {
    cwd: REPO_ROOT,
    env: { ...process.env, VOLTRA_ADAPTER: 'mock', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  return new Promise((resolveRun) => {
    child.on('exit', (code) => resolveRun({ code, stderr, out }));
  });
}

/** The synthetic fixture with one extra call step, written to a scratch file. */
function exchangeWithCall(call: string): string {
  const exchange = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { steps: unknown[] };
  exchange.steps.splice(2, 0, { call, args: {} });
  const path = join(mkdtempSync(join(tmpdir(), 'vmcp-export-it-')), 'poisoned.exchange.json');
  writeFileSync(path, JSON.stringify(exchange));
  return path;
}

describe('export-agent-transcript against the mock server', () => {
  beforeAll(() => {
    if (existsSync(BUILT_MODULE)) return;
    const result = spawnSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
    if (result.status !== 0) throw new Error('failed to build the server before the export test');
  }, BUILD_HOOK_TIMEOUT_MS);

  it(
    'exports a schema-valid, screen-safe transcript that is byte-identical across two pinned runs',
    async () => {
      const [first, second] = await Promise.all([runExporter(FIXTURE), runExporter(FIXTURE)]);

      expect(first.stderr).toBe('');
      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      const firstBytes = readFileSync(first.out);
      expect(readFileSync(second.out).equals(firstBytes)).toBe(true);
      const transcript = agentTranscriptSchema.parse(JSON.parse(firstBytes.toString('utf8')));
      expect(() => assertScreenSafe(transcript)).not.toThrow();
      expect(transcript.source.kind).toBe('mock');
      expect(transcript.entries.map((entry) => entry.kind)).toEqual([
        'user',
        'assistant',
        'tool_call',
        'tool_result',
        'tool_call',
        'tool_result',
        'tool_call',
        'tool_result',
        'channel',
        'channel',
        'assistant',
        'tool_call',
        'tool_result',
        'channel',
        'assistant',
      ]);
      const reps = transcript.entries.flatMap((entry) =>
        entry.kind === 'channel' ? entry.fields.map((field) => field.value) : [],
      );
      expect(reps).toEqual(['1', '2', '3']);
      expect(firstBytes.toString('utf8')).not.toContain('mock-voltra');
    },
    EXPORT_TIMEOUT_MS,
  );

  it.each(['device.send_raw', 'debug.recent_events'])(
    'refuses an exchange that calls %s and writes nothing',
    async (tool) => {
      const run = await runExporter(exchangeWithCall(tool));

      expect(run.code).toBe(1);
      expect(run.stderr).toContain('TOOL_REFUSED');
      expect(existsSync(run.out)).toBe(false);
    },
    EXPORT_TIMEOUT_MS,
  );

  it(
    'refuses to run against a non-mock adapter and writes nothing',
    async () => {
      const run = await runExporter(FIXTURE, { VOLTRA_ADAPTER: 'node' });

      expect(run.code).toBe(1);
      expect(run.stderr).toContain('mock only');
      expect(existsSync(run.out)).toBe(false);
    },
    EXPORT_TIMEOUT_MS,
  );
});
