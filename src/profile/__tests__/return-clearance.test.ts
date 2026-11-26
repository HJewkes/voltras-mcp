// The return clearance answer is one of three words and a date, never the lifter's own account of
// a limit, and the latest answer is the one that stands (VW-976).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerState } from '../../state/server-state.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';
import { registerProfileTools } from '../../tools/profile-tools.js';
import { latestReturnClearance } from '../return-clearance.js';

type Result = { content: { text: string }[]; isError?: boolean };
type Callback = (args: unknown) => Promise<Result>;

let store: SessionStore;
let callbacks: Map<string, Callback>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'));
  store = openTestStore();
  callbacks = new Map();
  const placeholders = {
    get: (name: string) => ({
      update: (u: { callback: Callback }) => callbacks.set(name, u.callback),
    }),
  };
  registerProfileTools({} as never, { store } as unknown as ServerState, placeholders as never);
});

afterEach(async () => {
  vi.useRealTimers();
  await store.close();
});

async function setBackground(args: unknown): Promise<Result> {
  return callbacks.get('profile.set_training_background')!(args);
}

async function storedClearance(): Promise<unknown> {
  const result = await callbacks.get('profile.get_training_background')!({});
  const { profile } = JSON.parse(result.content[0].text) as {
    profile: { returnClearance?: unknown } | null;
  };
  return profile?.returnClearance;
}

describe('profile.set_training_background returnClearance', () => {
  it('stores the answer with today as its date when no date is given', async () => {
    const result = await setBackground({ returnClearance: 'cleared_with_limit' });

    expect(result.isError).not.toBe(true);
    expect(await storedClearance()).toEqual({
      answer: 'cleared_with_limit',
      answeredOn: '2026-10-03',
    });
  });

  it('rejects a free-text answer in place of one of the three words', async () => {
    const result = await setBackground({ returnClearance: 'cleared, but no overhead work' });

    expect(result.isError).toBe(true);
    expect(await storedClearance()).toBeUndefined();
  });

  it('rejects a field that would carry what the limit is', async () => {
    const result = await setBackground({
      returnClearance: 'cleared_with_limit',
      returnClearanceNote: 'no overhead work',
    });

    expect(result.isError).toBe(true);
    expect(await storedClearance()).toBeUndefined();
  });

  it('rejects a date with no answer beside it', async () => {
    const result = await setBackground({ returnClearanceOn: '2026-10-01' });

    expect(result.isError).toBe(true);
  });

  it('lets a later answer replace an earlier one', async () => {
    await setBackground({ returnClearance: 'not_yet', returnClearanceOn: '2026-09-28' });
    await setBackground({ returnClearance: 'cleared', returnClearanceOn: '2026-10-02' });

    expect(await storedClearance()).toEqual({ answer: 'cleared', answeredOn: '2026-10-02' });
  });

  it('keeps the newer answer when a backdated one arrives after it', async () => {
    await setBackground({ returnClearance: 'cleared', returnClearanceOn: '2026-10-02' });
    await setBackground({ returnClearance: 'not_yet', returnClearanceOn: '2026-09-28' });

    expect(await storedClearance()).toEqual({ answer: 'cleared', answeredOn: '2026-10-02' });
  });

  it('shows the stored answer on the onboarding gaps so it is not asked twice', async () => {
    await setBackground({ returnClearance: 'cleared' });

    const result = await callbacks.get('profile.get_onboarding_gaps')!({});
    const { gaps } = JSON.parse(result.content[0].text) as { gaps: { returnClearance: unknown } };

    expect(gaps.returnClearance).toEqual({ answer: 'cleared', answeredOn: '2026-10-03' });
  });

  it('leaves the answer alone when a later call sets only other fields', async () => {
    await setBackground({ returnClearance: 'not_yet' });
    await setBackground({ goal: 'strength' });

    expect(await storedClearance()).toEqual({ answer: 'not_yet', answeredOn: '2026-10-03' });
  });
});

describe('latestReturnClearance', () => {
  it('takes the new answer on the same day, so a slip can be corrected', () => {
    const existing = { answer: 'not_yet', answeredOn: '2026-10-03' } as const;
    const incoming = { answer: 'cleared', answeredOn: '2026-10-03' } as const;

    expect(latestReturnClearance(existing, incoming)).toEqual(incoming);
  });
});
