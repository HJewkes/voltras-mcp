// The whole per-entry pass, against the fake page: locate the workout, fill
// every box, screenshot, and then either stop (dry run) or submit once.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { longCardDate } from '../src/date.js';
import { readLedger } from '../src/ledger.js';
import { resolvePaths } from '../src/paths.js';
import { runAll } from '../src/run.js';
import { card, fakeLauncher, fakePage } from './fake-page.js';

const SESSION_ID = 'session-pass-1';
const DATE = '2026-09-08';

const EXERCISES = [
  { exerciseId: 'row', exerciseName: 'Seated Row', result: '170 lb x 12\n170 lb x 10' },
  { exerciseId: 'push', exerciseName: 'Tricep Pushdown', result: '60 lb x 12' },
];

let root;
let paths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-submit-'));
  paths = resolvePaths({ HOME: root, VMCP_TRUECOACH_OUTBOX_DIR: join(root, 'outbox') });
  mkdirSync(paths.pending, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(paths.pending, `${SESSION_ID}.json`),
    JSON.stringify({
      sessionId: SESSION_ID,
      endedAt: now,
      generatedAt: now,
      date: DATE,
      exercises: EXERCISES,
    }),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** The list page and the edit page in one DOM; the fake page never navigates. */
function workoutDom({ submitLabel = 'Update results' } = {}) {
  return `
    <button role="tab"><span class="sr-only">Upcoming</span></button>
    <button role="tab"><span class="sr-only">Past</span></button>
    <div><a href="/client/workouts/595828381">View workout</a>
      <span>${longCardDate(DATE)}</span></div>
    <ul>${card('Tricep Pushdown', { plan: 'E2 3x12' })}${card('Seated Row', { plan: 'E1 4x10' })}</ul>
    <button><span class="sr-only">${submitLabel}</span></button>`;
}

function textareaValues(page) {
  return [...page.dom.window.document.querySelectorAll('textarea')].map((el) => el.value);
}

describe('a dry run', () => {
  it('fills every box, screenshots, submits nothing and leaves the entry pending', async () => {
    // Arrange
    const page = fakePage(workoutDom());

    // Act
    const { results, exitCode } = await runAll(paths, { launcher: fakeLauncher(page) });

    // Assert
    expect(results[0]).toMatchObject({ sessionId: SESSION_ID, code: 'dry_run' });
    expect(exitCode).toBe(0);
    expect(textareaValues(page)).toEqual(['60 lb x 12', '170 lb x 12\n170 lb x 10']);
    expect(page.calls.screenshot[0]).toContain(`${SESSION_ID}-`);
    expect(page.calls.click).toEqual([]);
    expect(readLedger(paths.ledger)).toEqual([]);
    expect(existsSync(join(paths.pending, `${SESSION_ID}.json`))).toBe(true);
  });
});

describe('a submit run', () => {
  it('clicks once, records every exercise in the ledger and moves the entry to sent', async () => {
    // Arrange
    const page = fakePage(workoutDom());

    // Act
    const { results, exitCode } = await runAll(paths, {
      submit: true,
      launcher: fakeLauncher(page),
    });

    // Assert
    expect(results[0]?.code).toBe('sent');
    expect(exitCode).toBe(0);
    expect(page.calls.click).toEqual(['[data-vmcp-submit="1"]']);
    expect(readLedger(paths.ledger).map((record) => record.exerciseId)).toEqual(['row', 'push']);
    expect(existsSync(join(paths.sent, `${SESSION_ID}.json`))).toBe(true);
  });

  it('does not click and does not record when the submit control is missing', async () => {
    // Arrange: the page renders the cards but no submit button.
    const page = fakePage(
      workoutDom().replace(/<button><span class="sr-only">Update results.*/s, ''),
    );

    // Act
    const { results } = await runAll(paths, { submit: true, launcher: fakeLauncher(page) });

    // Assert
    expect(results[0]?.code).toBe('selector_missing');
    expect(page.calls.click).toEqual([]);
    expect(readLedger(paths.ledger)).toEqual([]);
  });

  it('refuses the entry with unmatched and fills nothing when a card is renamed', async () => {
    // Arrange
    const page = fakePage(workoutDom().replace('Seated Row', 'Chest Press'));

    // Act
    const { results } = await runAll(paths, { submit: true, launcher: fakeLauncher(page) });

    // Assert
    expect(results[0]?.code).toBe('unmatched');
    expect(results[0]?.detail).toContain('Seated Row');
    expect(textareaValues(page)).toEqual(['', '']);
  });

  it('refuses with workout_not_found when no card carries the entry date', async () => {
    // Arrange
    const page = fakePage(workoutDom().replace(longCardDate(DATE), longCardDate('2026-09-11')));

    // Act
    const { results } = await runAll(paths, { submit: true, launcher: fakeLauncher(page) });

    // Assert
    expect(results[0]?.code).toBe('workout_not_found');
    expect(page.calls.click).toEqual([]);
  });
});
