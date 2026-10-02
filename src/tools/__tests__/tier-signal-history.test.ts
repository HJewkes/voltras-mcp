// `getTierSignal()` with an imported training-history summary (VW-551). Synthetic summaries only.
import { describe, expect, it } from 'vitest';
import type { StoredTrainingProfile } from '../../store/types.js';
import { LOCAL_USER_ID } from '../../store/types.js';
import { getTierSignal, type HistoricalTrainingSummary } from '../tier-signal.js';
import { validateHistory } from '../tier-history.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ANCHOR = Date.parse('2025-01-01T00:00:00.000Z');

/** One ended training session with a working set, `offset` days after 2025-01-01. */
async function seedTrainingDay(store: SessionStore, id: string, offset: number): Promise<void> {
  const startedAt = new Date(ANCHOR + offset * DAY_MS).toISOString();
  const endedAt = new Date(ANCHOR + offset * DAY_MS + 30 * 60 * 1000).toISOString();
  await store.putSession({ id, startedAt, endedAt, kind: 'training' });
  await store.putSet({
    id: `set-${id}`,
    sessionId: id,
    startedAt,
    endedAt,
    partial: false,
    reps: [],
  });
}

async function seedSpread(store: SessionStore, count: number, spanDays: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await seedTrainingDay(store, `s${i}`, Math.round((i * spanDays) / Math.max(1, count - 1)));
  }
}

/** `count` local dates, `stepDays` apart, starting on `first`. */
function datesFrom(first: string, count: number, stepDays: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.parse(first) + i * stepDays * DAY_MS).toISOString().slice(0, 10),
  );
}

function summary(overrides: Partial<HistoricalTrainingSummary> = {}): HistoricalTrainingSummary {
  return {
    source: 'synthetic-export',
    trainingDayDates: [],
    firstSustainedStallByLift: {},
    attendanceConsistency: null,
    ...overrides,
  };
}

async function storeWith(
  profile: Partial<StoredTrainingProfile>,
  seed: (store: SessionStore) => Promise<void> = async () => {},
): Promise<SessionStore> {
  const store = openTestStore();
  await seed(store);
  await store.putTrainingProfile({
    userId: LOCAL_USER_ID,
    updatedAt: new Date().toISOString(),
    ...profile,
  });
  return store;
}

function stateOf(store: SessionStore) {
  return { store };
}

const HISTORY_KEYS = [
  'historicalTrainingDays',
  'historySource',
  'plateauSource',
  'historyBreakMonths',
  'historyDropped',
];

describe('getTierSignal without a summary (VW-551)', () => {
  const fixtures: Array<[string, () => Promise<SessionStore>]> = [
    ['an empty store', async () => openTestStore()],
    [
      'a plateaued lifter past the gate',
      () => storeWith({ everPlateaued: true }, (s) => seedSpread(s, 24, 90)),
    ],
    [
      'an answered returner',
      () =>
        storeWith(
          {
            declaredTier: 'intermediate',
            everPlateaued: true,
            yearsTraining: 3,
            lastBreakMonths: 4,
          },
          (s) => seedSpread(s, 18, 126),
        ),
    ],
  ];

  it.each(fixtures)('reads byte-identically however asOf is passed: %s', async (_name, open) => {
    const store = await open();
    const asOf = new Date(ANCHOR + 60 * DAY_MS).toISOString();

    const bare = await getTierSignal(stateOf(store), LOCAL_USER_ID);
    const emptyOptions = await getTierSignal(stateOf(store), LOCAL_USER_ID, {});
    const positional = await getTierSignal(stateOf(store), LOCAL_USER_ID, asOf);
    const inOptions = await getTierSignal(stateOf(store), LOCAL_USER_ID, { asOf });
    await store.close();

    expect(JSON.stringify(emptyOptions)).toBe(JSON.stringify(bare));
    expect(JSON.stringify(inOptions)).toBe(JSON.stringify(positional));
    for (const key of HISTORY_KEYS) expect(Object.keys(bare.evidence)).not.toContain(key);
  });
});

describe('getTierSignal with an imported summary (VW-551)', () => {
  it('opens the returner path from a summary that ended three months before logging began', async () => {
    const store = await storeWith({ declaredTier: 'intermediate', yearsTraining: 1 }, (s) =>
      seedSpread(s, 6, 30),
    );
    const history = summary({
      trainingDayDates: datesFrom('2024-07-31', 10, 7),
      firstSustainedStallByLift: { squat: '2024-08-20', bench: null },
    });

    const without = await getTierSignal(stateOf(store), LOCAL_USER_ID);
    const signal = await getTierSignal(stateOf(store), LOCAL_USER_ID, { history });
    await store.close();

    expect(without.ceilingBasis).toBeNull();
    expect(signal).toMatchObject({
      tier: 'intermediate',
      derivedCeiling: 'intermediate',
      ceilingBasis: 'returner',
      confidence: 'provisional',
    });
    expect(signal.evidence).toMatchObject({
      plateauDetected: true,
      plateauSource: 'history',
      historyBreakMonths: 3,
      historySource: 'synthetic-export',
      historicalTrainingDays: 10,
    });
  });

  it('meets the 24-day, 12-week gate on the union, counting an overlapping day once', async () => {
    const store = await storeWith({ everPlateaued: true }, (s) => seedSpread(s, 12, 44));
    const history = summary({
      trainingDayDates: [...datesFrom('2024-10-02', 12, 7), '2025-01-01'],
    });

    const without = await getTierSignal(stateOf(store), LOCAL_USER_ID);
    const signal = await getTierSignal(stateOf(store), LOCAL_USER_ID, { history });
    await store.close();

    expect(without.confidence).toBe('provisional');
    expect(signal).toMatchObject({
      ceilingBasis: 'logged_history',
      confidence: 'confident',
      derivedCeiling: 'intermediate',
    });
    expect(signal.evidence).toMatchObject({
      trainingDaysLogged: 12,
      historicalTrainingDays: 12,
      weeksSpanned: 19,
      loggedHistoryMet: true,
      plateauSource: 'self_report',
    });
  });

  it('closes the returner path on a year-long gap inside the summary', async () => {
    const profile = { everPlateaued: true, yearsTraining: 3, lastBreakMonths: 4 };
    const store = await storeWith(profile, (s) => seedSpread(s, 18, 126));
    const history = summary({ trainingDayDates: ['2023-01-10', '2023-02-01', '2024-03-01'] });

    const without = await getTierSignal(stateOf(store), LOCAL_USER_ID);
    const signal = await getTierSignal(stateOf(store), LOCAL_USER_ID, { history });
    await store.close();

    expect(without.ceilingBasis).toBe('returner');
    expect(signal.evidence.longestLoggedGapDays).toBe(394);
    expect(signal.ceilingBasis).toBeNull();
    expect(signal.tier).toBe('beginner');
  });

  it('lets an answered break win over the break the summary implies', async () => {
    const store = await storeWith(
      { everPlateaued: true, yearsTraining: 3, lastBreakMonths: 14 },
      (s) => seedSpread(s, 6, 30),
    );
    const history = summary({ trainingDayDates: datesFrom('2024-11-01', 4, 7) });

    const signal = await getTierSignal(stateOf(store), LOCAL_USER_ID, { history });
    await store.close();

    expect(signal.ceilingBasis).toBeNull();
  });

  it('still clamps a declared advanced tier to the intermediate ceiling', async () => {
    const store = await storeWith({ declaredTier: 'advanced', yearsTraining: 1 }, (s) =>
      seedSpread(s, 6, 30),
    );
    const history = summary({
      trainingDayDates: datesFrom('2024-07-31', 10, 7),
      firstSustainedStallByLift: { deadlift: '2024-08-20' },
    });

    const signal = await getTierSignal(stateOf(store), LOCAL_USER_ID, { history });
    await store.close();

    expect(signal).toMatchObject({ declared: 'advanced', tier: 'intermediate', source: 'derived' });
  });

  it.each([
    [0.8, true],
    [0.75, true],
    [0.5, false],
    [null, null],
  ])(
    'maps attendance %s to frequencyConsistent %s and nothing else',
    async (attendance, expected) => {
      const store = await storeWith({ declaredTier: 'intermediate', everPlateaued: true }, (s) =>
        seedSpread(s, 6, 30),
      );

      const without = await getTierSignal(stateOf(store), LOCAL_USER_ID);
      const signal = await getTierSignal(stateOf(store), LOCAL_USER_ID, {
        history: summary({ attendanceConsistency: attendance }),
      });
      await store.close();

      expect(signal.evidence.frequencyConsistent).toBe(expected);
      expect(signal.tier).toBe(without.tier);
      expect(signal.confidence).toBe(without.confidence);
      expect(signal.ceilingBasis).toBe(without.ceilingBasis);
    },
  );

  it('ignores imported days after asOf', async () => {
    const store = await storeWith({ everPlateaued: true }, (s) => seedSpread(s, 12, 44));
    const history = summary({ trainingDayDates: datesFrom('2025-03-01', 12, 7) });

    const signal = await getTierSignal(stateOf(store), LOCAL_USER_ID, {
      asOf: new Date(ANCHOR + 50 * DAY_MS).toISOString(),
      history,
    });
    await store.close();

    expect(signal.evidence.historicalTrainingDays).toBe(0);
    expect(signal.confidence).toBe('provisional');
  });

  it('reports a rejected summary in the evidence instead of throwing', async () => {
    const store = await storeWith({ everPlateaued: true });

    const signal = await getTierSignal(stateOf(store), LOCAL_USER_ID, {
      history: 'not a summary' as unknown as HistoricalTrainingSummary,
    });
    await store.close();

    expect(signal.evidence).toMatchObject({
      historySource: null,
      historicalTrainingDays: 0,
      historyDropped: ['summary: not an object'],
    });
  });
});

describe('validateHistory', () => {
  it('drops bad dates, duplicates, bad stall dates and out-of-range attendance with reasons', () => {
    const { history, dropped } = validateHistory({
      source: 'synthetic-export',
      trainingDayDates: ['2024-05-02', '2024-05-01', '2024-05-01', '2024-02-30', 'yesterday', 7],
      firstSustainedStallByLift: { squat: '2024-13-01', bench: null, row: '2024-04-01' },
      attendanceConsistency: 1.5,
    });

    expect(history).toEqual({
      source: 'synthetic-export',
      trainingDayDates: ['2024-05-01', '2024-05-02'],
      stallDates: ['2024-04-01'],
      attendanceConsistency: null,
    });
    expect(dropped).toEqual([
      'trainingDayDates: duplicate 2024-05-01',
      'trainingDayDates: not an ISO date: 2024-02-30',
      'trainingDayDates: not an ISO date: yesterday',
      'trainingDayDates: not an ISO date: 7',
      'firstSustainedStallByLift.squat: not an ISO date or null',
      'attendanceConsistency: outside 0..1: 1.5',
    ]);
  });

  it.each([
    [null, 'summary: not an object'],
    [{ trainingDayDates: [] }, 'summary: source missing'],
    [{ source: 'x', trainingDayDates: 'nope' }, 'summary: trainingDayDates is not an array'],
  ])('rejects a malformed summary without throwing (%j)', (raw, reason) => {
    expect(validateHistory(raw)).toEqual({ history: null, dropped: [reason] });
  });
});
