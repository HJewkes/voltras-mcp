// Unit tests for the bench pre-flight's pure gate evaluation
// (scripts/lib/preflight-gates.mjs).
//
// Each gate stands for a configuration mistake that produces silence rather
// than an error, so the assertions are about level (`fail` blocks the launch,
// `warn` does not) and about the message naming the fix.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  DASHBOARD_PORT,
  evaluateGates,
  exitCodeFor,
  isNodeTooOld,
  parseLsofListeners,
  readSqliteUserVersion,
} from '../../scripts/lib/preflight-gates.mjs';
import { SCHEMA_VERSION } from '../store/sqlite-store.js';

/** A snapshot where every gate passes; each test perturbs one field. */
const HEALTHY = {
  whisperCliPresent: true,
  whisperModelPresent: true,
  nodeVersion: 'v22.5.0',
  buildSchemaVersion: 41,
  storeSchemaVersion: 41,
  storePath: '/home/lifter/.voltras/vmcp.sqlite',
  env: { VMCP_CUES: 'on', VMCP_CUES_MIDSET: 'on' },
  portListeners: [],
  selfPid: 999,
};

function gate(id, overrides = {}) {
  const found = evaluateGates({ ...HEALTHY, ...overrides }).find((g) => g.id === id);
  if (found === undefined) throw new Error(`no gate ${id}`);
  return found;
}

describe('isNodeTooOld', () => {
  it.each([
    ['v22.4.9', true],
    ['v21.99.0', true],
    ['v22.5.0', false],
    ['v22.11.0', false],
    ['v25.1.0', false],
  ])('%s -> %s', (version, expected) => {
    expect(isNodeTooOld(version)).toBe(expected);
  });

  it('does not block on an unparseable version string', () => {
    expect(isNodeTooOld('nightly')).toBe(false);
  });
});

describe('parseLsofListeners', () => {
  it('extracts command and pid, skipping the header row', () => {
    const stdout = [
      'COMMAND   PID    USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
      'node    41231 hjewkes   23u  IPv4  0x1a1     0t0  TCP 127.0.0.1:7723 (LISTEN)',
      '',
    ].join('\n');
    expect(parseLsofListeners(stdout)).toEqual([{ command: 'node', pid: 41231 }]);
  });

  it('returns nothing for the empty output of a free port', () => {
    expect(parseLsofListeners('')).toEqual([]);
  });
});

describe('readSqliteUserVersion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-uv-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the version a store was stamped with', () => {
    const path = join(dir, 'stamped.sqlite');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 37; CREATE TABLE t (x INTEGER)');
    db.close();
    expect(readSqliteUserVersion(path)).toBe(37);
  });

  it('returns null for a file that is absent', () => {
    expect(readSqliteUserVersion(join(dir, 'absent.sqlite'))).toBeNull();
  });

  it('returns null for a file that is not a sqlite database', () => {
    const path = join(dir, 'junk.sqlite');
    writeFileSync(path, 'not a database, but longer than the header would need '.repeat(3));
    expect(readSqliteUserVersion(path)).toBeNull();
  });
});

describe('schema gate', () => {
  it('exports a build version the gate can compare against', () => {
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it('passes when the store and the build are on the same version', () => {
    expect(gate('schema').level).toBe('ok');
  });

  it('fails when the store is newer than the build, naming both versions', () => {
    const found = gate('schema', { storeSchemaVersion: 42 });
    expect(found.level).toBe('fail');
    expect(found.message).toContain('42');
    expect(found.message).toContain('41');
    expect(exitCodeFor(evaluateGates({ ...HEALTHY, storeSchemaVersion: 42 }))).toBe(1);
  });

  it('warns, without blocking, when the build will migrate the store forward', () => {
    const snapshot = { ...HEALTHY, storeSchemaVersion: 39 };
    const found = evaluateGates(snapshot).find((g) => g.id === 'schema');
    expect(found.level).toBe('warn');
    expect(found.message).toContain('migrate');
    expect(exitCodeFor(evaluateGates(snapshot))).toBe(0);
  });

  it('passes with a note when there is no store file yet', () => {
    const found = gate('schema', { storeSchemaVersion: null });
    expect(found.level).toBe('ok');
    expect(found.message).toContain('/home/lifter/.voltras/vmcp.sqlite');
  });

  it('warns rather than passes when the build version cannot be read', () => {
    expect(gate('schema', { buildSchemaVersion: null }).level).toBe('warn');
  });
});

describe('evaluateGates', () => {
  it('passes every gate on a correctly configured bench', () => {
    const gates = evaluateGates(HEALTHY);
    expect(gates.every((g) => g.level === 'ok')).toBe(true);
    expect(exitCodeFor(gates)).toBe(0);
  });

  it('fails when whisper-cli is missing, naming the rebuild script', () => {
    const found = gate('whisper', { whisperCliPresent: false });
    expect(found.level).toBe('fail');
    expect(found.message).toContain('ensure-whisper.mjs');
  });

  it('only warns when the model is missing, since it downloads on demand', () => {
    expect(gate('whisper', { whisperModelPresent: false }).level).toBe('warn');
  });

  it('fails on a Node older than node:sqlite requires', () => {
    expect(gate('node', { nodeVersion: 'v22.4.0' }).level).toBe('fail');
  });

  it('warns that VOLTRA_PT_DEV=1 registers no push channel', () => {
    const found = gate('push-channel', { env: { ...HEALTHY.env, VOLTRA_PT_DEV: '1' } });
    expect(found.level).toBe('warn');
    expect(found.message).toContain('VW-158');
  });

  it('warns when VMCP_CUES is unset and prints both effective values', () => {
    const found = gate('cues', { env: {} });
    expect(found.level).toBe('warn');
    expect(found.message).toContain('VMCP_CUES=off VMCP_CUES_MIDSET=off');
  });

  it('reports the effective values even when cues are configured', () => {
    const found = gate('cues', { env: { VMCP_CUES: 'on' } });
    expect(found.level).toBe('ok');
    expect(found.message).toContain('VMCP_CUES=on VMCP_CUES_MIDSET=off');
  });

  it('warns when another process already holds the dashboard port', () => {
    const found = gate('dashboard-port', {
      portListeners: [{ command: 'node', pid: 41231 }],
    });
    expect(found.level).toBe('warn');
    expect(found.message).toContain(`Port ${DASHBOARD_PORT}`);
    expect(found.message).toContain('node(41231)');
    // VW-167: the session no longer loses its dashboard outright, so the gate
    // must point the operator at server.health rather than at the taken port.
    expect(found.message).toContain('server.health');
  });

  it('ignores a listener that is this process itself', () => {
    const found = gate('dashboard-port', { portListeners: [{ command: 'node', pid: 999 }] });
    expect(found.level).toBe('ok');
  });

  it('never exits non-zero for the advisory gates alone', () => {
    const gates = evaluateGates({
      ...HEALTHY,
      env: { VOLTRA_PT_DEV: '1' },
      portListeners: [{ command: 'node', pid: 41231 }],
    });
    expect(gates.filter((g) => g.level === 'warn')).toHaveLength(3);
    expect(exitCodeFor(gates)).toBe(0);
  });
});
