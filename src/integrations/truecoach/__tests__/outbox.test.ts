// Unit tests for the coach-results outbox (src/integrations/truecoach/outbox.ts).
//
// The flag and the skip conditions are what matter here: the rendering itself
// is covered by report-tools.test.ts, and this writer deliberately shares that
// one function. The `session.end` wiring — including that a failed write does
// not fail the close — lives in tools/__tests__/session-tools.test.ts.
//
// Every case writes into a fresh temp directory; nothing touches `~/.voltras`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerState } from '../../../state/server-state.js';
import type { StoredSession, StoredSet } from '../../../store/types.js';
import { writeSessionOutbox } from '../outbox.js';

const SESSION_ID = 'session-outbox-1';
const ROW_ID = 'seated-row';
/** Local noon on a past date: the rendered `date` is zone-independent, and
 *  `generatedAt` (written now) is genuinely later, as it is in production. */
const ENDED_AT = new Date(2026, 8, 1, 12, 0, 0).toISOString();

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-outbox-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeSet(overrides: Partial<StoredSet> & { id: string }): StoredSet {
  return {
    sessionId: SESSION_ID,
    startedAt: ENDED_AT,
    endedAt: ENDED_AT,
    partial: false,
    exerciseId: ROW_ID,
    reps: [],
    ...overrides,
  };
}

function makeState(sets: StoredSet[], mode: 'on' | 'off'): ServerState {
  const session: StoredSession = { id: SESSION_ID, startedAt: ENDED_AT, endedAt: ENDED_AT };
  return {
    config: { adapter: 'node', trueCoachOutbox: mode, trueCoachOutboxDir: dir },
    store: {
      getSession: () => Promise.resolve(session),
      getSetsForSession: () => Promise.resolve(sets),
      getAssignmentsForSession: () => Promise.resolve([]),
      getPlannedExercisesForTemplate: () => Promise.resolve([]),
      getPlannedExercise: () => Promise.resolve(undefined),
    },
    exercises: { getById: (id: string) => ({ id, name: 'Seated Row' }) },
  } as unknown as ServerState;
}

const WORKING_SETS = [
  makeSet({ id: 's1', weightLbs: 170, firmwareRepCount: 12 }),
  makeSet({ id: 's2', weightLbs: 170, firmwareRepCount: 10 }),
];

describe('coach-results outbox', () => {
  it('writes the rendered session to pending/<sessionId>.json when on', async () => {
    // Arrange
    const state = makeState(WORKING_SETS, 'on');

    // Act
    await writeSessionOutbox(state, SESSION_ID);

    // Assert
    const path = join(dir, 'pending', `${SESSION_ID}.json`);
    const payload = JSON.parse(readFileSync(path, 'utf8')) as {
      sessionId: string;
      endedAt: string;
      date: string;
      generatedAt: string;
      exercises: { exerciseName: string; result: string }[];
    };
    expect(payload.sessionId).toBe(SESSION_ID);
    expect(payload.date).toBe('2026-09-01');
    expect(payload.exercises[0]?.result).toBe('170 lb x 12\n170 lb x 10');
    expect(new Date(payload.generatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(payload.endedAt).getTime(),
    );
  });

  it('creates the pending directory owner-only', async () => {
    // Arrange
    const state = makeState(WORKING_SETS, 'on');

    // Act
    await writeSessionOutbox(state, SESSION_ID);

    // Assert
    expect(statSync(join(dir, 'pending')).mode & 0o777).toBe(0o700);
  });

  it('writes nothing when the flag is off', async () => {
    // Arrange
    const state = makeState(WORKING_SETS, 'off');

    // Act
    await writeSessionOutbox(state, SESSION_ID);

    // Assert
    expect(existsSync(join(dir, 'pending'))).toBe(false);
  });

  it('writes nothing for a session with no working sets', async () => {
    // Arrange: warm-ups only, so the report has no exercise to report.
    const state = makeState(
      [makeSet({ id: 'w1', weightLbs: 70, firmwareRepCount: 8, isWarmup: true })],
      'on',
    );

    // Act
    await writeSessionOutbox(state, SESSION_ID);

    // Assert
    expect(existsSync(join(dir, 'pending'))).toBe(false);
  });

  it('writes nothing when every set belongs to a guest lifter', async () => {
    // Arrange
    const state = makeState(
      [makeSet({ id: 'g1', weightLbs: 170, firmwareRepCount: 12, lifter: 'Jordan' })],
      'on',
    );

    // Act
    await writeSessionOutbox(state, SESSION_ID);

    // Assert
    expect(existsSync(join(dir, 'pending'))).toBe(false);
  });

  it('swallows a write failure instead of throwing', async () => {
    // Arrange: an outbox root that is a regular file, so creating `pending`
    // under it fails with ENOTDIR.
    const asFile = join(dir, 'not-a-directory');
    writeFileSync(asFile, 'occupied');
    const state = makeState(WORKING_SETS, 'on');
    (state.config as { trueCoachOutboxDir: string }).trueCoachOutboxDir = asFile;

    // Act + Assert
    await expect(writeSessionOutbox(state, SESSION_ID)).resolves.toBeUndefined();
    expect(readdirSync(dir)).toEqual(['not-a-directory']);
  });
});
