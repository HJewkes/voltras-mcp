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

const TOOL_NAMES = ['profile.set_training_background', 'profile.get_training_background'];

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
