// session.checkin's `feel` answer (VW-993): how a session felt, -5 to +5, stored only when given
// within 2 minutes of the session's last set, so the climb-back ramp's gate reads real ratings.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seedTrainingDay } from '../../__tests__/fixtures/training-day.js';
import type { ServerState } from '../../state/server-state.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

vi.mock('@voltras/node-sdk', () => ({
  VoltraSDKError: class extends Error {},
  TrainingMode: { Idle: 0, WeightTraining: 1 },
  TrainingModeNames: { 0: 'Idle', 1: 'WeightTraining' },
}));

const { LiveState } = await import('../../state/live-state.js');
const { registerSessionTools } = await import('../session-tools.js');
const { ModeRevertGuard } = await import('../../state/mode-revert-guard.js');
const { CORE_TOOL_NAMES } = await import('../../tool-registry.js');

type Result = { content: { text: string }[]; isError?: boolean };
type Callback = (args: unknown) => Promise<Result>;

const LAST_SET_ENDED = '2026-04-08T12:00:00.000Z';
const SESSION_ID = 'sess-return';

let store: SessionStore;
let callbacks: Map<string, Callback>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  store = openTestStore();
  const publisher: { publish: () => void; forSlot: () => unknown } = {
    publish: () => {},
    forSlot: () => publisher,
  };
  const slot = { slotId: 'primary', client: {}, live: new LiveState() };
  const state = {
    config: { adapter: 'node' },
    slots: new Map([['primary', { ...slot, modeRevertGuard: new ModeRevertGuard() }]]),
    store,
    exercises: { getById: () => undefined },
    channels: { forSlot: () => publisher },
    slotBindings: { get: () => null },
  } as unknown as ServerState;
  callbacks = new Map();
  const placeholders = new Map(
    CORE_TOOL_NAMES.filter((name) => name.startsWith('session.')).map((name) => [
      name,
      { update: (u: { callback: Callback }) => callbacks.set(name, u.callback), remove: () => {} },
    ]),
  );
  registerSessionTools({ tool: vi.fn() } as never, state, placeholders as never);
  await seedTrainingDay(store, {
    id: 'sess-before',
    startedAt: '2026-04-01T12:00:00.000Z',
    endedAt: '2026-04-01T12:00:00.000Z',
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await store.close();
});

async function checkinFeelAt(minutesAfter: number, value: string): Promise<Result> {
  vi.setSystemTime(new Date(Date.parse(LAST_SET_ENDED) + minutesAfter * 60 * 1000));
  return callbacks.get('session.checkin')!({
    sessionId: SESSION_ID,
    answers: [{ code: 'feel', value }],
  });
}

async function seedReturnSession(): Promise<void> {
  await seedTrainingDay(store, {
    id: SESSION_ID,
    startedAt: '2026-04-08T11:30:00.000Z',
    endedAt: LAST_SET_ENDED,
  });
}

function body(result: Result): { written: number; withheld: string[] } {
  return JSON.parse(result.content[0].text) as { written: number; withheld: string[] };
}

describe('session.checkin feel', () => {
  it.each([
    ['-3', -3],
    ['+2', 2],
    ['0', 0],
  ])('stores %s given within 2 minutes of the last set, as a number', async (value, number) => {
    await seedReturnSession();

    const result = await checkinFeelAt(2, value);

    expect(result.isError).toBeUndefined();
    expect(body(result)).toMatchObject({ written: 1, withheld: [] });
    const rows = await store.getSelfReportsForSession(SESSION_ID, 'checkin');
    expect(rows).toEqual([
      expect.objectContaining({ questionCode: 'feel', valueText: value, valueNum: number }),
    ]);
  });

  it('withholds a feel answer given after the 2-minute capture window', async () => {
    await seedReturnSession();

    const result = await checkinFeelAt(3, '-2');

    expect(body(result)).toMatchObject({ written: 0, withheld: ['feel'] });
    expect(await store.getSelfReportsForSession(SESSION_ID, 'checkin')).toEqual([]);
  });

  it('withholds a feel answer on a session with no set', async () => {
    await store.putSession({ kind: 'training', id: SESSION_ID, startedAt: LAST_SET_ENDED });

    const result = await checkinFeelAt(1, '1');

    expect(body(result)).toMatchObject({ written: 0, withheld: ['feel'] });
  });

  it('stores the other answers when only the feel answer is late', async () => {
    await seedReturnSession();
    vi.setSystemTime(new Date(Date.parse(LAST_SET_ENDED) + 10 * 60 * 1000));

    const result = await callbacks.get('session.checkin')!({
      sessionId: SESSION_ID,
      answers: [
        { code: 'feel', value: '-1' },
        { code: 'soreness', value: 'high' },
      ],
    });

    expect(body(result)).toMatchObject({ written: 1, withheld: ['feel'] });
  });

  it.each(['6', '-6', '1.5', 'high', '--1'])('refuses a feel answer of %s', async (value) => {
    await seedReturnSession();

    const result = await checkinFeelAt(1, value);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('-5 to +5');
  });

  it('still refuses a number on the three-point codes', async () => {
    await seedReturnSession();
    vi.setSystemTime(new Date(LAST_SET_ENDED));

    const result = await callbacks.get('session.checkin')!({
      sessionId: SESSION_ID,
      answers: [{ code: 'soreness', value: '2' }],
    });

    expect(result.isError).toBe(true);
  });
});
