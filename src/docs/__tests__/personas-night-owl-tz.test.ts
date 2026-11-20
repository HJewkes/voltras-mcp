// The night-owl persona under a zone with daylight saving (VW-940). The rest of
// the suite runs in UTC, where a local date is always the UTC date, so this file
// pins its own zone before anything reads the clock.

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/Los_Angeles';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { localDay } from '../personas/calendar.js';
import { PERSONA_NOW, seedInMemory, type SeededPersona } from './persona-fixture.js';

let seeded: SeededPersona;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(PERSONA_NOW);
  seeded = await seedInMemory('night-owl');
});

afterAll(async () => {
  await seeded.store.close();
  vi.useRealTimers();
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('the night-owl persona in Los Angeles', () => {
  it('starts every session between 23:00 and 01:00 local', () => {
    const hours = new Set(seeded.sessions.map((s) => new Date(s.startedAt).getHours()));

    expect([...hours].sort()).toEqual([1, 23]);
  });

  it('has a session whose local date is not its UTC date', () => {
    const shifted = seeded.sessions.filter(
      (s) => localDay(new Date(s.startedAt)) !== s.startedAt.slice(0, 10),
    );

    expect(shifted.length).toBeGreaterThan(0);
  });

  it('has a session that runs across a daylight-saving change', () => {
    const across = seeded.sessions.filter(
      (s) => new Date(s.startedAt).getTimezoneOffset() !== new Date(s.endedAt!).getTimezoneOffset(),
    );

    expect(across).toHaveLength(1);
  });
});
