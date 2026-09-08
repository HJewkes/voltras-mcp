// The two stop conditions that must never degrade into a click or a retry:
// a missing submit control, and a login wall.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertLoggedIn } from '../src/browser.js';
import { readLedger } from '../src/ledger.js';
import { notifyHuman } from '../src/notify.js';
import { resolvePaths } from '../src/paths.js';
import { runAll } from '../src/run.js';
import { clickSubmit, readSlots } from '../src/workout.js';
import { card, fakeLauncher, fakePage } from './fake-page.js';

const SESSION_ID = 'session-submit-1';

let root;
let paths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-submit-'));
  paths = resolvePaths({ HOME: root, VMCP_TRUECOACH_OUTBOX_DIR: join(root, 'outbox') });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writePending(exercises, date = '2026-09-08') {
  mkdirSync(paths.pending, { recursive: true });
  const now = new Date().toISOString();
  const entry = { sessionId: SESSION_ID, endedAt: now, generatedAt: now, date, exercises };
  writeFileSync(join(paths.pending, `${SESSION_ID}.json`), JSON.stringify(entry));
  return entry;
}

describe('clickSubmit', () => {
  it('finds the submit control by either label', async () => {
    // Arrange
    const page = fakePage('<button><span>Finish workout</span></button>');

    // Act
    await clickSubmit(page);

    // Assert
    expect(page.calls.click).toEqual(['[data-vmcp-submit="1"]']);
  });

  it('aborts with selector_missing and clicks nothing when the control is gone', async () => {
    // Arrange
    const page = fakePage('<button>Add a comment</button>');

    // Act
    const err = await clickSubmit(page).catch((caught) => caught);

    // Assert
    expect(err.code).toBe('selector_missing');
    expect(page.calls.click).toEqual([]);
  });
});

describe('readSlots', () => {
  it('aborts when no exercise card matches', async () => {
    // Arrange
    const page = fakePage('<ul><li class="renamed-card"></li></ul>');

    // Act
    const err = await readSlots(page).catch((caught) => caught);

    // Assert
    expect(err.code).toBe('selector_missing');
  });

  it('reads title, plan and results-box presence per card', async () => {
    // Arrange
    const page = fakePage(
      `<ul>${card('Seated Row', { plan: 'E1 4x10' })}${card('Curl', { box: false })}</ul>`,
    );

    // Act
    const slots = await readSlots(page);

    // Assert
    expect(slots).toEqual([
      { index: 0, title: 'Seated Row', plan: 'E1 4x10', hasResultsBox: true },
      { index: 1, title: 'Curl', plan: '', hasResultsBox: false },
    ]);
  });
});

describe('assertLoggedIn', () => {
  it('throws on a password field', async () => {
    // Arrange
    const page = fakePage('<form><input type="password" /></form>');

    // Act
    const err = await assertLoggedIn(page).catch((caught) => caught);

    // Assert
    expect(err.name).toBe('LoginRequiredError');
  });
});

describe('a run that hits a login wall', () => {
  it('stops the whole run, posts nothing, and never retries', async () => {
    // Arrange
    writePending([{ exerciseId: 'row', exerciseName: 'Seated Row', result: '170 lb x 12' }]);
    const page = fakePage('<form><input type="password" /></form>', {
      url: 'https://app.truecoach.co/login',
    });

    // Act
    const { results, exitCode } = await runAll(paths, {
      submit: true,
      launcher: fakeLauncher(page),
    });

    // Assert
    expect(results[0]?.code).toBe('login_required');
    expect(exitCode).toBe(1);
    expect(page.calls.goto).toHaveLength(1);
    expect(page.calls.click).toEqual([]);
    expect(readLedger(paths.ledger)).toEqual([]);
    expect(existsSync(join(paths.pending, `${SESSION_ID}.json`))).toBe(true);
  });

  it('raises the session id through the notifier exactly once', () => {
    // Arrange
    const run = vi.fn(() => 'ask <message>');

    // Act
    const channel = notifyHuman(
      `TrueCoach wants a login; session ${SESSION_ID} was not posted.`,
      run,
    );

    // Assert: one probe, then one delivery carrying the session id.
    expect(channel).toBe('agent-chat');
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[1]).toEqual(['ask', expect.stringContaining(SESSION_ID)]);
  });
});
