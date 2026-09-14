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
//   * `profile.set_diet_phase` (VW-149/VW-150) declares an open range, closes
//     the previous one, corrects history retroactively, and stamps a session.
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
  'profile.set_diet_phase',
  'profile.log_bodyweight',
  'profile.get_body_metrics',
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

describe('profile.set_training_background - injuries and program history', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('round-trips an injury list and a named program through the store', async () => {
    await h.invoke('profile.set_training_background', {
      namedProgramHistory: '5/3/1',
      injuries: [
        { area: 'left shoulder', kind: 'lingering_joint', note: 'aches on overhead press' },
        { area: 'heart', kind: 'other', cardioLimitation: true },
      ],
    });

    const r = await h.invoke('profile.get_training_background', {});

    const { profile } = parseResult(r) as { profile: StoredTrainingProfile };
    expect(profile.namedProgramHistory).toBe('5/3/1');
    expect(profile.injuries).toEqual([
      { area: 'left shoulder', kind: 'lingering_joint', note: 'aches on overhead press' },
      { area: 'heart', kind: 'other', cardioLimitation: true },
    ]);
    expect(profile.provenance).toMatchObject({
      namedProgramHistory: 'user',
      injuries: 'user',
    });
  });

  it('replaces the injury list rather than merging, so a resolved injury can go', async () => {
    await h.invoke('profile.set_training_background', {
      injuries: [
        { area: 'left shoulder', kind: 'lingering_joint' },
        { area: 'right knee', kind: 'sharp_in_set' },
      ],
    });

    await h.invoke('profile.set_training_background', {
      injuries: [{ area: 'right knee', kind: 'sharp_in_set' }],
    });

    const r = await h.invoke('profile.get_training_background', {});
    const { profile } = parseResult(r) as { profile: StoredTrainingProfile };
    expect(profile.injuries).toEqual([{ area: 'right knee', kind: 'sharp_in_set' }]);
  });

  it('leaves the injury list alone on a call that does not mention it', async () => {
    await h.invoke('profile.set_training_background', {
      injuries: [{ area: 'right knee', kind: 'sharp_in_set' }],
    });

    await h.invoke('profile.set_training_background', { goal: 'hypertrophy' });

    const r = await h.invoke('profile.get_training_background', {});
    const { profile } = parseResult(r) as { profile: StoredTrainingProfile };
    expect(profile.injuries).toEqual([{ area: 'right knee', kind: 'sharp_in_set' }]);
  });

  it('rejects an injury kind outside the enum', async () => {
    const r = await h.invoke('profile.set_training_background', {
      injuries: [{ area: 'lower back', kind: 'twinge' }],
    });

    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
  });
});

describe('profile.get_onboarding_gaps', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  interface GapsBody {
    gaps: {
      missing: string[];
      medicalClearanceRequired: boolean;
      medicalClearanceNote: string | null;
      goalRealism: { goal: string | null; target: string | null; note: string } | null;
    };
  }

  function gaps(r: { content: { text: string }[] }): GapsBody['gaps'] {
    return (parseResult(r) as GapsBody).gaps;
  }

  it('lists every field in the RP session-0 asking order before anything is captured', async () => {
    const r = await h.invoke('profile.get_onboarding_gaps', {});

    // Order is the contract: an agent walks this list top to bottom to pick
    // the next question. §1a intake first, then §1b tier, §1c volume history,
    // §1j injuries (sources/mined/mcp-audit-rp-docs.md).
    expect(gaps(r).missing).toEqual([
      'goal',
      'daysAvailable',
      'daysReliable',
      'currentBaseline',
      'effortTolerance',
      'target',
      'declaredTier',
      'yearsTraining',
      'historyConsistent',
      'everPlateaued',
      'reportedSetsPerMuscle',
      'namedProgramHistory',
      'injuries',
    ]);
  });

  it('drops answered fields and keeps the rest in order', async () => {
    await h.invoke('profile.set_training_background', {
      goal: 'add visible arm size',
      daysReliable: 3,
      namedProgramHistory: 'German Volume Training',
    });

    const r = await h.invoke('profile.get_onboarding_gaps', {});

    expect(gaps(r).missing).toEqual([
      'daysAvailable',
      'currentBaseline',
      'effortTolerance',
      'target',
      'declaredTier',
      'yearsTraining',
      'historyConsistent',
      'everPlateaued',
      'reportedSetsPerMuscle',
      'injuries',
    ]);
  });

  it('treats an empty injury list as answered, not as a gap', async () => {
    await h.invoke('profile.set_training_background', { injuries: [] });

    const r = await h.invoke('profile.get_onboarding_gaps', {});

    expect(gaps(r).missing).not.toContain('injuries');
    expect(gaps(r).medicalClearanceRequired).toBe(false);
    expect(gaps(r).medicalClearanceNote).toBeNull();
  });

  it('requires medical clearance and quotes the gate when a cardio limitation is reported', async () => {
    await h.invoke('profile.set_training_background', {
      injuries: [{ area: 'heart', kind: 'other', cardioLimitation: true }],
    });

    const r = await h.invoke('profile.get_onboarding_gaps', {});

    expect(gaps(r).medicalClearanceRequired).toBe(true);
    expect(gaps(r).medicalClearanceNote).toBe(
      "Cardiovascular limitations of any kind — ALWAYS defer to a doctor's clearance; never " +
        'interpret these as a non-clinically-trained coach. This is a liability boundary, not a ' +
        'feature flag.',
    );
  });

  it('does not gate on a non-cardiovascular injury', async () => {
    await h.invoke('profile.set_training_background', {
      injuries: [
        { area: 'lower back', kind: 'lingering_joint', note: 'stiff most mornings' },
        { area: 'right knee', kind: 'sharp_in_set' },
      ],
    });

    const r = await h.invoke('profile.get_onboarding_gaps', {});

    expect(gaps(r).medicalClearanceRequired).toBe(false);
    expect(gaps(r).medicalClearanceNote).toBeNull();
  });

  it('returns no goal realism until a goal or target exists', async () => {
    await h.invoke('profile.set_training_background', { daysReliable: 3 });

    const r = await h.invoke('profile.get_onboarding_gaps', {});

    expect(gaps(r).goalRealism).toBeNull();
  });

  it('returns the stored goal and target with the corpus note, not a verdict', async () => {
    await h.invoke('profile.set_training_background', {
      goal: 'lose fat',
      target: 'visible abs by June',
    });

    const r = await h.invoke('profile.get_onboarding_gaps', {});

    const realism = gaps(r).goalRealism;
    expect(realism?.goal).toBe('lose fat');
    expect(realism?.target).toBe('visible abs by June');
    // Prose to apply WITH the lifter. Nothing here says achievable or not.
    expect(realism?.note).toContain('mathematically sufficient for the');
    expect(realism?.note).toContain('Never proceed on a silent mismatch');
  });

  it('rejects unknown keys with INVALID_INPUT', async () => {
    const r = await h.invoke('profile.get_onboarding_gaps', { userId: 'someone' });

    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
  });
});

describe('profile.set_diet_phase (VW-149 / VW-150)', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  interface DietPhaseBody {
    declared: { phase: string; startedAt: string; endedAt?: string };
    timeline: { phase: string; startedAt: string; endedAt?: string }[];
  }

  it('declares an open range starting now and returns the timeline', async () => {
    const before = new Date().toISOString();
    const r = await h.invoke('profile.set_diet_phase', { phase: 'fat-loss' });

    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as DietPhaseBody;
    expect(body.declared.phase).toBe('fat-loss');
    expect(body.declared.startedAt >= before).toBe(true);
    expect(body.declared.endedAt).toBeUndefined();
    expect(body.timeline).toHaveLength(1);
  });

  it('closes the previous phase at the new start', async () => {
    await h.invoke('profile.set_diet_phase', {
      phase: 'gain',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    await h.invoke('profile.set_diet_phase', {
      phase: 'maintenance',
      startedAt: '2026-03-01T00:00:00.000Z',
    });

    const body = parseResult(
      await h.invoke('profile.set_diet_phase', {
        phase: 'fat-loss',
        startedAt: '2026-02-01T00:00:00.000Z',
      }),
    ) as DietPhaseBody;

    // The retroactive correction supersedes March entirely and leaves one
    // covering range per instant — read back so the lifter can see it.
    expect(body.timeline.map((p) => [p.phase, p.startedAt, p.endedAt])).toEqual([
      ['gain', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'],
      ['fat-loss', '2026-02-01T00:00:00.000Z', undefined],
    ]);
  });

  it('stamps a session written after the declaration', async () => {
    await h.invoke('profile.set_diet_phase', {
      phase: 'gain',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    await h.store.putSession({ id: 'sess-1', startedAt: '2026-02-01T00:00:00.000Z' });

    expect(await h.store.getSessionDietPhase('sess-1')).toBe('gain');
  });

  it('rejects a phase outside the four-value vocabulary', async () => {
    const r = await h.invoke('profile.set_diet_phase', { phase: 'recomp' });

    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('accepts recomposition as a fourth phase and stamps sessions with it (VW-363)', async () => {
    const r = await h.invoke('profile.set_diet_phase', {
      phase: 'recomposition',
      startedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(r.isError).toBeUndefined();
    const body = parseResult(r) as DietPhaseBody;
    expect(body.declared.phase).toBe('recomposition');

    await h.store.putSession({ id: 'sess-1', startedAt: '2026-02-01T00:00:00.000Z' });
    expect(await h.store.getSessionDietPhase('sess-1')).toBe('recomposition');
  });

  it('rejects unknown keys with INVALID_INPUT', async () => {
    const r = await h.invoke('profile.set_diet_phase', { phase: 'gain', lifter: 'Jordan' });

    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
  });
});

describe('profile.log_bodyweight / profile.get_body_metrics (VW-327)', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  interface BodyMetricEntry {
    id: string;
    userId: string;
    measuredAt: string;
    bodyweightLbs: number;
    note?: string;
  }
  interface LogBody {
    entry: BodyMetricEntry;
  }
  interface GetBody {
    series: BodyMetricEntry[];
    sevenDayMeanBodyweightLbs: number | null;
  }

  it('logs a reading defaulting measuredAt to now', async () => {
    const before = new Date().toISOString();
    const r = await h.invoke('profile.log_bodyweight', { bodyweightLbs: 180 });

    expect(r.isError).toBeUndefined();
    const { entry } = parseResult(r) as LogBody;
    expect(entry.bodyweightLbs).toBe(180);
    expect(entry.userId).toBe(LOCAL_USER_ID);
    expect(entry.measuredAt >= before).toBe(true);
    expect(entry.note).toBeUndefined();
  });

  it('records an explicit measuredAt and note', async () => {
    const r = await h.invoke('profile.log_bodyweight', {
      bodyweightLbs: 179.5,
      measuredAt: '2026-01-01T00:00:00.000Z',
      note: 'after breakfast',
    });

    const { entry } = parseResult(r) as LogBody;
    expect(entry.measuredAt).toBe('2026-01-01T00:00:00.000Z');
    expect(entry.note).toBe('after breakfast');
  });

  it('a second log at the same measuredAt corrects rather than duplicates', async () => {
    await h.invoke('profile.log_bodyweight', {
      bodyweightLbs: 180,
      measuredAt: '2026-01-01T00:00:00.000Z',
    });
    const r2 = await h.invoke('profile.log_bodyweight', {
      bodyweightLbs: 181,
      measuredAt: '2026-01-01T00:00:00.000Z',
    });
    const { entry: second } = parseResult(r2) as LogBody;

    const r3 = await h.invoke('profile.get_body_metrics', {});
    const { series } = parseResult(r3) as GetBody;
    expect(series).toHaveLength(1);
    expect(series[0]?.bodyweightLbs).toBe(181);
    expect(series[0]?.id).toBe(second.id);
  });

  it('returns an empty series and a null mean before anything is logged', async () => {
    const r = await h.invoke('profile.get_body_metrics', {});

    const { series, sevenDayMeanBodyweightLbs } = parseResult(r) as GetBody;
    expect(series).toEqual([]);
    expect(sevenDayMeanBodyweightLbs).toBeNull();
  });

  it('returns the series newest-first', async () => {
    await h.invoke('profile.log_bodyweight', {
      bodyweightLbs: 180,
      measuredAt: '2026-01-01T00:00:00.000Z',
    });
    await h.invoke('profile.log_bodyweight', {
      bodyweightLbs: 179,
      measuredAt: '2026-01-03T00:00:00.000Z',
    });

    const r = await h.invoke('profile.get_body_metrics', {});
    const { series } = parseResult(r) as GetBody;
    expect(series.map((m) => m.measuredAt)).toEqual([
      '2026-01-03T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ]);
  });

  it('reports the 7-day mean once at least 3 readings fall in that window', async () => {
    const now = Date.now();
    const daysAgo = (n: number): string => new Date(now - n * 24 * 60 * 60 * 1000).toISOString();

    await h.invoke('profile.log_bodyweight', { bodyweightLbs: 180, measuredAt: daysAgo(1) });
    await h.invoke('profile.log_bodyweight', { bodyweightLbs: 182, measuredAt: daysAgo(3) });

    const before3 = await h.invoke('profile.get_body_metrics', {});
    expect((parseResult(before3) as GetBody).sevenDayMeanBodyweightLbs).toBeNull();

    await h.invoke('profile.log_bodyweight', { bodyweightLbs: 181, measuredAt: daysAgo(5) });

    const after3 = await h.invoke('profile.get_body_metrics', {});
    expect((parseResult(after3) as GetBody).sevenDayMeanBodyweightLbs).toBe(181);
  });

  it('excludes a reading older than 7 days from the mean', async () => {
    const now = Date.now();
    const daysAgo = (n: number): string => new Date(now - n * 24 * 60 * 60 * 1000).toISOString();

    await h.invoke('profile.log_bodyweight', { bodyweightLbs: 180, measuredAt: daysAgo(1) });
    await h.invoke('profile.log_bodyweight', { bodyweightLbs: 180, measuredAt: daysAgo(3) });
    await h.invoke('profile.log_bodyweight', { bodyweightLbs: 400, measuredAt: daysAgo(30) });

    const r = await h.invoke('profile.get_body_metrics', {});
    const { sevenDayMeanBodyweightLbs } = parseResult(r) as GetBody;
    expect(sevenDayMeanBodyweightLbs).toBeNull();
  });

  it('filters the series by sinceDays independently of the 7-day mean', async () => {
    const now = Date.now();
    const daysAgo = (n: number): string => new Date(now - n * 24 * 60 * 60 * 1000).toISOString();

    await h.invoke('profile.log_bodyweight', { bodyweightLbs: 180, measuredAt: daysAgo(1) });
    await h.invoke('profile.log_bodyweight', { bodyweightLbs: 190, measuredAt: daysAgo(30) });

    const r = await h.invoke('profile.get_body_metrics', { sinceDays: 7 });
    const { series } = parseResult(r) as GetBody;
    expect(series).toHaveLength(1);
    expect(series[0]?.bodyweightLbs).toBe(180);
  });

  it('rejects a non-positive bodyweightLbs', async () => {
    const r = await h.invoke('profile.log_bodyweight', { bodyweightLbs: 0 });

    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('rejects unknown keys on both tools with INVALID_INPUT', async () => {
    const r1 = await h.invoke('profile.log_bodyweight', { bodyweightLbs: 180, userId: 'someone' });
    expect(r1.isError).toBe(true);
    expect((parseResult(r1) as { code: string }).code).toBe('INVALID_INPUT');

    const r2 = await h.invoke('profile.get_body_metrics', { userId: 'someone' });
    expect(r2.isError).toBe(true);
    expect((parseResult(r2) as { code: string }).code).toBe('INVALID_INPUT');
  });
});

describe('profile leanness fields (VW-364)', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  interface GradedReading {
    measuredAt: string;
    bodyFatPct: number;
    bodyFatSource: string;
    tier: string;
    absoluteSeePctPoints: number | null;
    citationIds: string[];
    sourceNote: string;
    displayOnly: boolean;
    displayOnlyReason: string;
  }
  interface Change {
    fromMeasuredAt: string;
    toMeasuredAt: string;
    fromSource: string;
    toSource: string;
    delta: { deltaPctPoints: number; bandPctPoints: number; verdict: string } | null;
    reason: string | null;
  }
  interface LeanBody {
    series: {
      measuredAt: string;
      leannessBand?: string;
      waistIn?: number;
      bodyFatPct?: number;
      bodyFatSource?: string;
      measurementProtocol?: string;
    }[];
    leannessSeries: { measuredAt: string; leannessBand: string }[];
    waistSeries: { measuredAt: string; waistIn: number }[];
    bodyFatReadings: GradedReading[];
    bodyFatChanges: Change[];
  }

  async function log(args: Record<string, unknown>): Promise<void> {
    const r = await h.invoke('profile.log_bodyweight', args);
    expect(r.isError).toBeUndefined();
  }

  it('stores the band, the tape, the percentage, its source and the protocol', async () => {
    await log({
      bodyweightLbs: 330,
      measuredAt: '2026-06-01T09:00:00.000Z',
      leannessBand: 'high',
      waistIn: 48.5,
      bodyFatPct: 34,
      bodyFatSource: 'consumer_bia',
      measurementProtocol: 'morning, fasted, same scale',
    });

    const body = parseResult(await h.invoke('profile.get_body_metrics', {})) as LeanBody;
    expect(body.series[0]).toMatchObject({
      leannessBand: 'high',
      waistIn: 48.5,
      bodyFatPct: 34,
      bodyFatSource: 'consumer_bia',
      measurementProtocol: 'morning, fasted, same scale',
    });
    expect(body.leannessSeries).toEqual([
      { measuredAt: '2026-06-01T09:00:00.000Z', leannessBand: 'high' },
    ]);
    expect(body.waistSeries).toEqual([{ measuredAt: '2026-06-01T09:00:00.000Z', waistIn: 48.5 }]);
  });

  it('returns every body-fat reading display-only, with its tier and a reason', async () => {
    await log({
      bodyweightLbs: 330,
      measuredAt: '2026-06-01T09:00:00.000Z',
      bodyFatPct: 34,
      bodyFatSource: 'consumer_bia',
    });

    const body = parseResult(await h.invoke('profile.get_body_metrics', {})) as LeanBody;
    const [graded] = body.bodyFatReadings;
    expect(graded?.displayOnly).toBe(true);
    expect(graded?.displayOnlyReason.length).toBeGreaterThan(0);
    expect(graded?.tier).toBe('low');
    expect(graded?.absoluteSeePctPoints).toBe(7.5);
    expect(graded?.citationIds).toEqual(['C42']);
  });

  it('bands a same-source pair and never names a direction inside the band', async () => {
    await log({
      bodyweightLbs: 330,
      measuredAt: '2026-06-01T09:00:00.000Z',
      bodyFatPct: 34,
      bodyFatSource: 'consumer_bia',
    });
    await log({
      bodyweightLbs: 320,
      measuredAt: '2026-09-01T09:00:00.000Z',
      bodyFatPct: 32,
      bodyFatSource: 'consumer_bia',
    });

    const body = parseResult(await h.invoke('profile.get_body_metrics', {})) as LeanBody;
    expect(body.bodyFatChanges).toHaveLength(1);
    expect(body.bodyFatChanges[0]).toEqual({
      fromMeasuredAt: '2026-06-01T09:00:00.000Z',
      toMeasuredAt: '2026-09-01T09:00:00.000Z',
      fromSource: 'consumer_bia',
      toSource: 'consumer_bia',
      delta: { deltaPctPoints: -2, bandPctPoints: 2.6, verdict: 'no measurable change' },
      reason: null,
    });
  });

  it('renders no delta across two different sources and says why', async () => {
    await log({
      bodyweightLbs: 330,
      measuredAt: '2026-06-01T09:00:00.000Z',
      bodyFatPct: 34,
      bodyFatSource: 'consumer_bia',
    });
    await log({
      bodyweightLbs: 320,
      measuredAt: '2026-09-01T09:00:00.000Z',
      bodyFatPct: 29,
      bodyFatSource: 'dexa',
    });

    const body = parseResult(await h.invoke('profile.get_body_metrics', {})) as LeanBody;
    expect(body.bodyFatChanges[0]?.delta).toBeNull();
    expect(body.bodyFatChanges[0]?.reason).toBe('different source');
  });

  it('rejects a body-fat percentage with no source', async () => {
    const r = await h.invoke('profile.log_bodyweight', { bodyweightLbs: 330, bodyFatPct: 30 });

    expect(r.isError).toBe(true);
    expect((parseResult(r) as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('rejects a leanness band outside the four and a source outside the enum', async () => {
    const band = await h.invoke('profile.log_bodyweight', {
      bodyweightLbs: 330,
      leannessBand: 'shredded',
    });
    expect(band.isError).toBe(true);

    const source = await h.invoke('profile.log_bodyweight', {
      bodyweightLbs: 330,
      bodyFatPct: 30,
      bodyFatSource: 'mirror',
    });
    expect(source.isError).toBe(true);
  });

  it('returns a waist series with no derived percentage anywhere on it', async () => {
    await log({ bodyweightLbs: 330, measuredAt: '2026-06-01T09:00:00.000Z', waistIn: 48.5 });
    await log({ bodyweightLbs: 326, measuredAt: '2026-07-01T09:00:00.000Z', waistIn: 47 });

    const body = parseResult(await h.invoke('profile.get_body_metrics', {})) as LeanBody;
    expect(body.waistSeries).toEqual([
      { measuredAt: '2026-07-01T09:00:00.000Z', waistIn: 47 },
      { measuredAt: '2026-06-01T09:00:00.000Z', waistIn: 48.5 },
    ]);
    expect(body.bodyFatReadings).toEqual([]);
    expect(body.bodyFatChanges).toEqual([]);
  });
});
