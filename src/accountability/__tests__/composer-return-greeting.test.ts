// The first message back after a break (VW-991): one success from the record, the baseline offer
// and one question, never the length of the break and never "why". `accountability.preview`
// renders it while the lifter is away after a break of a short band or wider.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seedTrainingDay } from '../../__tests__/fixtures/training-day.js';
import { DAY_COUNT } from '../../coach-copy/return-path.js';
import type { ServerState } from '../../state/server-state.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';
import { describeAccountabilityPreview } from '../../tools/accountability-tools.js';
import { composeReturnGreeting, returnGreetingDue } from '../composer.js';
import { assertCopyRules } from './copy-rules.js';

const WEDNESDAY_NOON = '2026-09-16T12:00:00';

describe('composeReturnGreeting', () => {
  const greeting = composeReturnGreeting({ lifterName: 'Sam', trainingDaysLogged: 42 });

  it('is the return_greeting kind and obeys the copy rules', () => {
    expect(greeting.kind).toBe('return_greeting');
    expect(() => assertCopyRules(greeting.text)).not.toThrow();
  });

  it('states the training days logged as its one success fact', () => {
    expect(greeting.text).toContain('Training days on your record: 42');
  });

  it('offers a baseline session of at most 20 minutes, today or tomorrow', () => {
    expect(greeting.text).toContain('baseline session of at most 20 minutes, today or tomorrow');
  });

  it('asks exactly one question', () => {
    expect(greeting.text.match(/\?/g)).toEqual(['?']);
    expect(greeting.text).toContain('Which days are realistic now?');
  });

  it('never counts days and never asks why', () => {
    expect(greeting.text).not.toMatch(DAY_COUNT);
    expect(greeting.text).not.toMatch(/\bwhy\b/i);
  });

  it('takes a shorter offer when one is passed', () => {
    const shorter = composeReturnGreeting({
      lifterName: 'Sam',
      trainingDaysLogged: 1,
      reducedScopeMinutes: 15,
    });

    expect(shorter.text).toContain('at most 15 minutes');
  });
});

describe('returnGreetingDue', () => {
  it.each([
    ['in_gap', 'short', true],
    ['in_gap', 'medium', true],
    ['in_gap', 'long', true],
    ['in_gap', 'none', false],
    ['returning', 'short', false],
    ['training', 'none', false],
  ] as const)('phase %s with band %s gives %s', (phase, band, due) => {
    expect(returnGreetingDue({ phase, band })).toBe(due);
  });

  it('is not due with no history and no band', () => {
    expect(returnGreetingDue({ phase: 'no_history' })).toBe(false);
  });
});

describe('accountability.preview renders the return greeting', () => {
  let store: SessionStore;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(WEDNESDAY_NOON));
    store = openTestStore();
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  function makeState(): ServerState {
    return {
      config: { adapter: 'node' },
      store,
      exercises: { getById: () => undefined },
    } as unknown as ServerState;
  }

  async function previewAfterTraining(days: readonly string[]) {
    for (const day of days) {
      await seedTrainingDay(store, {
        id: `trained-${day}`,
        startedAt: `${day}T12:00:00`,
        endedAt: `${day}T12:30:00`,
      });
    }
    return describeAccountabilityPreview(makeState(), { at: WEDNESDAY_NOON });
  }

  it('renders on a silent day while the lifter is away after a short break', async () => {
    const result = await previewAfterTraining(['2026-08-20', '2026-08-25', '2026-09-01']);

    expect(result.decision.action).toBe('silent');
    expect(result.returnGreeting).toContain('Training days on your record: 3');
    expect(result.returnGreeting).not.toMatch(DAY_COUNT);
  });

  it('renders after a long break', async () => {
    const result = await previewAfterTraining(['2026-01-05']);

    expect(result.returnGreeting).toContain('Training days on your record: 1');
  });

  it.each([
    ['training normally', ['2026-09-14']],
    ['back from a break', ['2026-07-01', '2026-09-15']],
    ['with no history', []],
  ] as const)('is null %s', async (_label, days) => {
    const result = await previewAfterTraining(days);

    expect(result.returnGreeting).toBeNull();
  });
});
