// Unit tests for src/tools/profile-tools.ts (VW-96 Wave 3).
//
// Coverage shape:
//   * `profile.get_training_background` returns `null` before any write.
//   * `profile.set_training_background` writes verbatim, no derivation.
//   * A second call with a different field MERGES onto the first rather than
//     wiping it — the whole reason the handler reads before it writes.
//   * `declaredAt`/`goalSetAt` only refresh when that specific field is
//     resupplied; `onboardedAt` is stamped once and never moves.
//   * `.strict()` rejects an unknown key with INVALID_INPUT.
import { describe, it, expect, beforeEach } from 'vitest';
import type { ServerState } from '../../state/server-state.js';
import type { StoredTrainingProfile } from '../../store/types.js';
import { LOCAL_USER_ID, SqliteSessionStore } from '../../store/sqlite-store.js';
import { registerProfileTools } from '../profile-tools.js';

interface FakeRegisteredTool {
  callback?: (args: unknown, extra?: unknown) => Promise<unknown>;
  update(updates: { callback: (args: unknown, extra?: unknown) => Promise<unknown> }): void;
  remove(): void;
}

const TOOL_NAMES = [
  'profile.set_training_background',
  'profile.get_training_background',
  'profile.get_tier_signal',
  'profile.get_starting_prescription',
  'profile.get_onboarding_gaps',
];

function makeFakePlaceholders(): {
  placeholders: Map<string, FakeRegisteredTool>;
  invokers: Record<
    string,
    (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>
  >;
} {
  const placeholders = new Map<string, FakeRegisteredTool>();
  for (const name of TOOL_NAMES) {
    const tool: FakeRegisteredTool = {
      update(updates) {
        tool.callback = updates.callback;
      },
      remove() {
        /* unused */
      },
    };
    placeholders.set(name, tool);
  }
  const invokers: Record<
    string,
    (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>
  > = {};
  for (const name of TOOL_NAMES) {
    invokers[name] = async (args: unknown) => {
      const cb = placeholders.get(name)?.callback;
      if (!cb) throw new Error(`no callback installed for ${name}`);
      return cb(args) as Promise<{ content: { text: string }[]; isError?: boolean }>;
    };
  }
  return { placeholders, invokers };
}

function parseResult(r: { content: { text: string }[] }): unknown {
  return JSON.parse(r.content[0].text);
}

interface Harness {
  store: SqliteSessionStore;
  invoke: (
    name: string,
    args: unknown,
  ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
}

function setup(): Harness {
  const store = SqliteSessionStore.open(':memory:');
  const state = { store } as unknown as ServerState;
  const { placeholders, invokers } = makeFakePlaceholders();
  registerProfileTools(
    undefined as unknown as Parameters<typeof registerProfileTools>[0],
    state,
    placeholders as unknown as Parameters<typeof registerProfileTools>[2],
  );
  return { store, invoke: (name, args) => invokers[name](args) };
}

describe('profile.get_training_background', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('returns null before any write', async () => {
    const r = await h.invoke('profile.get_training_background', {});
    expect(r.isError).toBeUndefined();
    expect(parseResult(r)).toEqual({ profile: null });
  });
});

describe('profile.get_tier_signal', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('is wired through to getTierSignal() and defaults to beginner/provisional', async () => {
    const r = await h.invoke('profile.get_tier_signal', {});
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { tierSignal: { tier: string; confidence: string } };
    expect(body.tierSignal.tier).toBe('beginner');
    expect(body.tierSignal.confidence).toBe('provisional');
  });
});

describe('profile.set_training_background', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('persists a declared field verbatim, with no derived tier', async () => {
    const r = await h.invoke('profile.set_training_background', {
      declaredTier: 'intermediate',
      yearsTraining: 3,
    });
    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as { profile: StoredTrainingProfile };
    expect(body.profile.declaredTier).toBe('intermediate');
    expect(body.profile.yearsTraining).toBe(3);
    expect(body.profile.userId).toBe(LOCAL_USER_ID);
    expect(body.profile.provenance).toEqual({ declaredTier: 'user', yearsTraining: 'user' });
    expect(typeof body.profile.declaredAt).toBe('string');
    expect(typeof body.profile.onboardedAt).toBe('string');

    const stored = await h.store.getTrainingProfile(LOCAL_USER_ID);
    expect(stored).toEqual(body.profile);
  });

  it('merges a later call onto the earlier one instead of wiping it', async () => {
    await h.invoke('profile.set_training_background', { declaredTier: 'beginner' });
    const r2 = await h.invoke('profile.set_training_background', { goal: 'hypertrophy' });
    const body = parseResult(r2) as { profile: StoredTrainingProfile };

    // The earlier answer must survive an unrelated later call.
    expect(body.profile.declaredTier).toBe('beginner');
    expect(body.profile.goal).toBe('hypertrophy');
    expect(body.profile.provenance).toEqual({ declaredTier: 'user', goal: 'user' });
  });

  it('stamps onboardedAt once and never moves it on later calls', async () => {
    const r1 = await h.invoke('profile.set_training_background', { declaredTier: 'beginner' });
    const first = (parseResult(r1) as { profile: StoredTrainingProfile }).profile.onboardedAt;

    const r2 = await h.invoke('profile.set_training_background', { goal: 'strength' });
    const second = (parseResult(r2) as { profile: StoredTrainingProfile }).profile.onboardedAt;

    expect(second).toBe(first);
  });

  it('only refreshes declaredAt when declaredTier is resupplied', async () => {
    const r1 = await h.invoke('profile.set_training_background', { declaredTier: 'beginner' });
    const firstDeclaredAt = (parseResult(r1) as { profile: StoredTrainingProfile }).profile
      .declaredAt;

    const r2 = await h.invoke('profile.set_training_background', { goal: 'strength' });
    const afterUnrelatedCall = (parseResult(r2) as { profile: StoredTrainingProfile }).profile
      .declaredAt;

    expect(afterUnrelatedCall).toBe(firstDeclaredAt);
  });

  it('rejects unknown keys with INVALID_INPUT', async () => {
    const r = await h.invoke('profile.set_training_background', {
      declaredTier: 'beginner',
      unexpected: true,
    });
    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
    const stored = await h.store.getTrainingProfile(LOCAL_USER_ID);
    expect(stored).toBeUndefined();
  });
});

describe('profile.set_training_background — the three split intake fields', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('round-trips currentBaseline, effortTolerance and target through the store', async () => {
    await h.invoke('profile.set_training_background', {
      currentBaseline: 'benching 185 for 5',
      effortTolerance: 'moderate',
      target: '225 for 3 by spring',
    });

    const r = await h.invoke('profile.get_training_background', {});

    const { profile } = parseResult(r) as { profile: StoredTrainingProfile };
    expect(profile).toMatchObject({
      currentBaseline: 'benching 185 for 5',
      effortTolerance: 'moderate',
      target: '225 for 3 by spring',
    });
    expect(profile.provenance).toMatchObject({
      currentBaseline: 'user',
      effortTolerance: 'user',
      target: 'user',
    });
  });

  it('keeps target separate from goal rather than overwriting it', async () => {
    await h.invoke('profile.set_training_background', { goal: 'hypertrophy' });

    await h.invoke('profile.set_training_background', { target: 'visible abs' });

    const stored = await h.store.getTrainingProfile(LOCAL_USER_ID);
    expect(stored?.goal).toBe('hypertrophy');
    expect(stored?.target).toBe('visible abs');
  });

  it('rejects an effortTolerance outside the enum', async () => {
    const r = await h.invoke('profile.set_training_background', { effortTolerance: 'ferocious' });

    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
  });
});

describe('profile.get_starting_prescription', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  interface PrescriptionBody {
    prescription: {
      tier: string;
      assumesBeginner: boolean;
      seeds: {
        sessionsPerWeek: [number, number];
        setsPerExercise: [number, number] | string;
        rirTarget: number | null;
      };
      reasons: string[];
    };
  }

  it('assumes a beginner and seeds beginner numbers when no profile exists', async () => {
    const r = await h.invoke('profile.get_starting_prescription', {});

    const { prescription } = parseResult(r) as PrescriptionBody;
    expect(prescription.assumesBeginner).toBe(true);
    expect(prescription.tier).toBe('beginner');
    expect(prescription.seeds.sessionsPerWeek).toEqual([2, 3]);
    expect(prescription.seeds.setsPerExercise).toEqual([2, 2]);
    expect(prescription.seeds.rirTarget).toBeNull();
  });

  it('caps sessions at the days the lifter said they can definitely make', async () => {
    await h.invoke('profile.set_training_background', { daysAvailable: 5, daysReliable: 2 });

    const r = await h.invoke('profile.get_starting_prescription', {});

    const { prescription } = parseResult(r) as PrescriptionBody;
    // daysAvailable is the aspirational 5; the cap must come from daysReliable.
    expect(prescription.seeds.sessionsPerWeek).toEqual([2, 2]);
  });

  it('never lets effortTolerance move a set count', async () => {
    await h.invoke('profile.set_training_background', { effortTolerance: 'low' });

    const r = await h.invoke('profile.get_starting_prescription', {});

    const { prescription } = parseResult(r) as PrescriptionBody;
    expect(prescription.seeds.setsPerExercise).toEqual([2, 2]);
    expect(prescription.seeds.sessionsPerWeek).toEqual([2, 3]);
  });

  it('rejects unknown keys with INVALID_INPUT', async () => {
    const r = await h.invoke('profile.get_starting_prescription', { userId: 'someone' });

    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
  });
});
