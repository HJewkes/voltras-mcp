// Argument parsing and the exit codes. Default is a dry run over everything
// pending; only `--submit` clicks.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { longCardDate } from '../src/date.js';
import { main, parseArgs } from '../src/cli.js';
import { notifyHuman } from '../src/notify.js';
import { resolvePaths } from '../src/paths.js';
import { fakeLauncher, fakePage } from './fake-page.js';

// The real notifier shells out to `agent-chat` or `osascript`; the delivery
// path itself is covered in submit.test.js.
vi.mock('../src/notify.js', () => ({ notifyHuman: vi.fn(() => 'stderr') }));

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

describe('parseArgs', () => {
  it('defaults to a dry run over every pending entry', () => {
    expect(parseArgs([])).toMatchObject({ submit: false, session: undefined, command: 'run' });
  });

  it('reads --submit, --session and --stale-hours', () => {
    // Act
    const options = parseArgs(['--submit', '--session', 'abc', '--stale-hours', '12']);

    // Assert
    expect(options).toMatchObject({ submit: true, session: 'abc', staleHours: 12 });
  });

  it('treats --all as "no session filter", overriding an earlier --session', () => {
    expect(parseArgs(['--session', 'abc', '--all']).session).toBeUndefined();
  });

  it('rejects an unknown flag and a flag missing its value', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--session'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--stale-hours', 'soon'])).toThrow(/needs a number/);
  });

  it('recognises the login command', () => {
    expect(parseArgs(['login']).command).toBe('login');
  });
});

describe('main', () => {
  it('exits 0 with nothing pending', async () => {
    expect(await main([], paths)).toBe(0);
  });

  it('exits 1 when an entry is refused', async () => {
    // Arrange: an entry with no exercises fails freshness before any browser.
    mkdirSync(paths.pending, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(paths.pending, 'session-cli-1.json'),
      JSON.stringify({
        sessionId: 'session-cli-1',
        endedAt: now,
        generatedAt: now,
        date: '2026-09-08',
        exercises: [],
      }),
    );

    // Act + Assert
    expect(await main([], paths)).toBe(1);
  });

  it('exits 2 and notifies when TrueCoach asks for a login', async () => {
    // Arrange
    mkdirSync(paths.pending, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(paths.pending, 'session-cli-2.json'),
      JSON.stringify({
        sessionId: 'session-cli-2',
        endedAt: now,
        generatedAt: now,
        date: '2026-09-08',
        exercises: [{ exerciseId: 'row', exerciseName: 'Seated Row', result: '170 lb x 12' }],
      }),
    );
    const page = fakePage(`<span>${longCardDate('2026-09-08')}</span><input type="password" />`);

    // Act
    const code = await main(['--submit'], paths, { launcher: fakeLauncher(page) });

    // Assert
    expect(code).toBe(2);
    expect(page.calls.click).toEqual([]);
    expect(notifyHuman).toHaveBeenCalledTimes(1);
    expect(notifyHuman).toHaveBeenCalledWith(expect.stringContaining('session-cli-2'));
  });
});
