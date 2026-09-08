// The sent-ledger, and the two run outcomes it decides on its own: a rerun of
// a finished session is a no-op, and a half-recorded session is refused.
//
// Both paths run through `runAll`, which never launches a browser when every
// entry is settled before the page pass — so these are unit tests despite
// exercising the real entry point.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendLedger, buildRecords, ledgerCoverage, readLedger } from '../src/ledger.js';
import { resolvePaths } from '../src/paths.js';
import { runAll } from '../src/run.js';
import { forbiddenLauncher } from './fake-page.js';

const SESSION_ID = 'session-ledger-1';

let root;
let paths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-submit-'));
  paths = resolvePaths({ HOME: root, VMCP_TRUECOACH_OUTBOX_DIR: join(root, 'outbox') });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function entry(exercises) {
  return {
    sessionId: SESSION_ID,
    endedAt: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    date: '2026-09-08',
    exercises,
  };
}

const TWO = [
  { exerciseId: 'row', exerciseName: 'Seated Row', result: '170 lb x 12' },
  { exerciseId: 'curl', exerciseName: 'Bicep Curl', result: '40 lb x 10' },
];

function writePending(payload) {
  mkdirSync(paths.pending, { recursive: true });
  writeFileSync(join(paths.pending, `${payload.sessionId}.json`), JSON.stringify(payload));
}

describe('ledger file', () => {
  it('reads an absent ledger as empty and appends without dropping records', () => {
    // Arrange
    expect(readLedger(paths.ledger)).toEqual([]);

    // Act
    appendLedger(paths.ledger, buildRecords(entry([TWO[0]]), '/tmp/a.png', 'T1'));
    appendLedger(paths.ledger, buildRecords(entry([TWO[1]]), '/tmp/b.png', 'T2'));

    // Assert
    expect(readLedger(paths.ledger).map((record) => record.exerciseId)).toEqual(['row', 'curl']);
  });
});

describe('ledgerCoverage', () => {
  it('reports none, partial and all', () => {
    // Arrange
    const full = buildRecords(entry(TWO), '/tmp/a.png', 'T1');

    // Act + Assert
    expect(ledgerCoverage([], entry(TWO))).toBe('none');
    expect(ledgerCoverage(full.slice(0, 1), entry(TWO))).toBe('partial');
    expect(ledgerCoverage(full, entry(TWO))).toBe('all');
  });
});

describe('runAll against the ledger', () => {
  it('is a no-op on rerun: the entry is moved to sent and nothing is posted', async () => {
    // Arrange
    writePending(entry(TWO));
    appendLedger(paths.ledger, buildRecords(entry(TWO), '/tmp/a.png', 'T1'));

    // Act
    const { results, exitCode } = await runAll(paths, {
      submit: true,
      launcher: forbiddenLauncher(),
    });

    // Assert
    expect(results).toEqual([
      { sessionId: SESSION_ID, code: 'already_sent', detail: 'every exercise in ledger' },
    ]);
    expect(exitCode).toBe(0);
    expect(existsSync(join(paths.sent, `${SESSION_ID}.json`))).toBe(true);
    expect(existsSync(join(paths.pending, `${SESSION_ID}.json`))).toBe(false);
  });

  it('refuses a half-recorded session with ledger_partial and leaves it pending', async () => {
    // Arrange
    writePending(entry(TWO));
    appendLedger(paths.ledger, buildRecords(entry([TWO[0]]), '/tmp/a.png', 'T1'));

    // Act
    const { results, exitCode } = await runAll(paths, {
      submit: true,
      launcher: forbiddenLauncher(),
    });

    // Assert
    expect(results[0]?.code).toBe('ledger_partial');
    expect(exitCode).toBe(1);
    expect(existsSync(join(paths.pending, `${SESSION_ID}.json`))).toBe(true);
  });
});
