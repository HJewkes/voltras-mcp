// Unit tests for src/tools/coaching-tools.ts (VW-136/VW-137).
//
// What's load-bearing here: every topic resolves to real content (no gaps in
// the Record), tier-narrowing actually changes the response for topics that
// define it and leaves others alone, sources/caveats reach the caller, and
// the schema rejects an unknown topic/key.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  fitRirVelocityModel,
  GENERAL_MODEL_CAVEAT,
  type RirVelocityModel,
  type RirVelocityObservation,
} from '../../analytics/rir-velocity.js';
import { CoachingTopic } from '../../schemas/coaching.js';
import type { SessionStore } from '../../store/types.js';
import { COACHING_CONTENT } from '../coaching-content.js';
import { registerCoachingTools } from '../coaching-tools.js';

interface FakeRegisteredTool {
  callback?: (args: unknown, extra?: unknown) => Promise<unknown>;
  update(updates: {
    callback: (args: unknown, extra?: unknown) => Promise<unknown>;
    description?: string;
  }): void;
  remove(): void;
}

type ToolResult = { content: { text: string }[]; isError?: boolean };

const TOOL_NAME = 'coaching.explain';

interface Harness {
  invoke: (args: unknown) => Promise<ToolResult>;
  description: () => string | undefined;
}

function setup(store?: SessionStore): Harness {
  const placeholders = new Map<string, FakeRegisteredTool>();
  let installedDescription: string | undefined;
  const tool: FakeRegisteredTool = {
    update(updates) {
      tool.callback = updates.callback;
      installedDescription = updates.description;
    },
    remove() {
      /* unused */
    },
  };
  placeholders.set(TOOL_NAME, tool);

  registerCoachingTools(
    undefined as unknown as Parameters<typeof registerCoachingTools>[0],
    { store } as unknown as Parameters<typeof registerCoachingTools>[1],
    placeholders as unknown as Parameters<typeof registerCoachingTools>[2],
  );

  return {
    invoke: async (args: unknown) => {
      if (!tool.callback) throw new Error(`no callback installed for ${TOOL_NAME}`);
      return (await tool.callback(args)) as ToolResult;
    },
    description: () => installedDescription,
  };
}

function parseResult(r: ToolResult): {
  topic: string;
  explanation: string;
  sources: string[];
  caveats?: string[];
  rirVelocityTarget?: {
    velocityTargetMps: number | null;
    withinFittedRange: boolean | null;
    caveat: string | null;
  };
} {
  return JSON.parse(r.content[0].text);
}

/** A store holding one fitted curve per exercise id, and nothing else. */
function storeWithCurves(curves: Record<string, RirVelocityModel>): SessionStore {
  return {
    getRirVelocityModel: (userId: string, exerciseId: string) => {
      const model = curves[exerciseId];
      return Promise.resolve(
        model === undefined
          ? undefined
          : {
              userId,
              exerciseId,
              model: model as unknown as Record<string, unknown>,
              fittedAt: '2026-09-10T00:00:00.000Z',
              sampleSize: model.pointCount,
              fitQuality: model.r2,
            },
      );
    },
  } as unknown as SessionStore;
}

/** A fitted curve from three sessions of six-rep sets on a known line. */
function curve(intercept: number, slope: number): RirVelocityModel {
  const observations: RirVelocityObservation[] = ['s1', 's2', 's3'].map((sessionId, i) => ({
    setId: `set-${String(i)}`,
    sessionId,
    performedAt: `2026-09-0${String(i + 1)}T10:00:00.000Z`,
    relativeIntensity: 0.8,
    anchorSource: 'failure',
    points: Array.from({ length: 6 }, (_, r) => ({
      rir: 5 - r,
      velocityMps: intercept + slope * (5 - r),
    })),
  }));
  const model = fitRirVelocityModel(observations).model;
  if (model === null) throw new Error('fixture corpus should fit');
  return model;
}

describe('coaching.explain', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('installs a non-empty description', () => {
    expect(h.description()).toBeDefined();
    expect((h.description() ?? '').length).toBeGreaterThan(0);
  });

  it('resolves every topic in the enum to real content', () => {
    // The Record<CoachingTopic, ...> exhaustiveness check already proves this
    // at compile time; this test proves it at the actual call path too.
    for (const topic of CoachingTopic.options) {
      const content = COACHING_CONTENT[topic];
      expect(content.allTiers.length).toBeGreaterThan(0);
      expect(content.sources.length).toBeGreaterThan(0);
    }
  });

  it('returns the full tiered explanation when no tier is given', async () => {
    // Arrange / Act
    const r = await h.invoke({ topic: 'live.cue_budget' });

    // Assert: the untiered response mentions every tier, not just one
    const body = parseResult(r);
    expect(body.explanation).toContain('advanced');
    expect(body.explanation).toContain('beginner');
    expect(body.sources.length).toBeGreaterThan(0);
  });

  it('narrows to the requested tier when a perTier entry exists', async () => {
    // Arrange / Act
    const r = await h.invoke({ topic: 'live.cue_budget', tier: 'advanced' });

    // Assert: the narrowed response is the shorter single-tier variant
    const body = parseResult(r);
    expect(body.explanation).toBe(COACHING_CONTENT['live.cue_budget'].perTier?.advanced);
    expect(body.explanation).not.toBe(COACHING_CONTENT['live.cue_budget'].allTiers);
  });

  it('falls back to the full explanation when the topic has no perTier entry', async () => {
    // Arrange: onboarding.tier_inference defines no perTier variants
    // Act
    const r = await h.invoke({ topic: 'onboarding.tier_inference', tier: 'beginner' });

    // Assert
    const body = parseResult(r);
    expect(body.explanation).toBe(COACHING_CONTENT['onboarding.tier_inference'].allTiers);
  });

  it('surfaces caveats only for topics whose source material self-contradicts', async () => {
    // Arrange / Act
    const withCaveat = parseResult(await h.invoke({ topic: 'diet.phase_durations' }));
    const withoutCaveat = parseResult(await h.invoke({ topic: 'diet.disruption_handling' }));

    // Assert
    expect(withCaveat.caveats?.length).toBeGreaterThan(0);
    expect(withoutCaveat.caveats).toBeUndefined();
  });

  it('explains e1RM as a trend instrument, with its error figures (VW-267)', async () => {
    // Arrange / Act
    const body = parseResult(await h.invoke({ topic: 'meso.e1rm_interpretation' }));

    // Assert: the two pooled figures and the trend-only framing, not a number
    // a reader could mistake for a measurement.
    expect(body.explanation).toContain('9.8%');
    expect(body.explanation).toContain('3.7%');
    expect(body.explanation).toContain('TREND INSTRUMENT');
    expect(body.sources).toContain(
      'greig-2023-load-velocity-1rm-ipd-meta-analysis-sports-medicine',
    );
    expect(body.caveats?.length).toBeGreaterThan(0);
  });

  it('flags warm-up-velocity readiness as an unvalidated heuristic (VW-269)', async () => {
    // Arrange / Act
    const body = parseResult(await h.invoke({ topic: 'live.readiness_interpretation' }));

    // Assert: the no-validation claim and the light-end citation, not a bare zone
    expect(body.explanation).toContain('ENGINEERING HEURISTIC');
    expect(body.explanation).toContain('no published study');
    expect(body.explanation).toContain('8.3 kg');
    expect(body.explanation).toContain('32.6 kg');
    expect(body.sources).toContain('senturk-2026-load-velocity-fatigue-discrimination-bmc-sports');
    expect(body.caveats?.length).toBeGreaterThan(0);
  });

  it('frames eccentric overload as a stimulus-cost knob, never extra growth (VW-303)', async () => {
    // Arrange / Act
    const body = parseResult(await h.invoke({ topic: 'live.eccentric_overload_cost' }));

    // Assert: the null-result citation and the cost framing, never a growth claim
    expect(body.explanation).toContain('stimulus');
    expect(body.explanation).toContain('cost');
    expect(body.explanation).toContain('49 studies');
    expect(body.explanation).toContain('773 participants');
    expect(body.sources.some((s) => s.includes('Zhang') && s.includes('2026'))).toBe(true);
    expect(body.sources.some((s) => s.includes('10.1007/s40279-026-02422-7'))).toBe(true);
    expect(body.caveats?.length).toBeGreaterThan(0);

    // The entry must state the null result outright, never imply overload
    // adds hypertrophy or strength beyond a matched constant load.
    expect(body.explanation).toContain('not a growth multiplier');
    expect(body.explanation).toContain('none of the outcomes it measured showed an AEL advantage');
    expect(body.explanation).toContain(
      'must never be presented as adding extra hypertrophy or extra strength',
    );
  });

  it('states the diet-phase tolerance rule and cites the S12 notes (VW-277)', async () => {
    // Arrange / Act
    const body = parseResult(await h.invoke({ topic: 'meso.diet_phase_tolerance' }));

    // Assert: both directions of the rule, the slope override, and the
    // ahead-of-schedule branch — never one of the three alone.
    expect(body.explanation).toContain('WIDENS');
    expect(body.explanation).toContain('TIGHTENS');
    expect(body.explanation).toContain('Check the slope before you act');
    expect(body.explanation).toContain('present the three, never');
    expect(body.sources).toContain('rp-s12-calorie-adjustment-magnitude-by-divergence-and-slope');
    expect(body.sources).toContain('rp-s12-trend-slope-overrides-raw-deviation');
    expect(body.sources).toContain('rp-s12-ahead-of-schedule-fat-loss-options');
    // The corpus is about calories; this server applies it to training load.
    // That gap is a caveat, not something to leave implicit.
    expect(body.caveats?.some((c) => c.includes('CALORIE'))).toBe(true);
  });

  it('states that a declared recomposition runs the same table as maintenance (VW-363)', async () => {
    const body = parseResult(await h.invoke({ topic: 'meso.diet_phase_tolerance' }));

    expect(body.explanation).toContain('RECOMPOSITION RUNS THIS SAME TABLE AS MAINTENANCE');
    expect(body.sources).toContain('rp-s12-recomposition-requires-maintenance-calories');
  });

  // VW-273: the asymmetry topic must never turn a measurement into a
  // prescription. The intervention literature does not support corrective
  // unilateral work, so an entry that recommended it would be telling a coach
  // something the citations underneath it contradict.
  describe('no corrective unilateral work from a detected asymmetry', () => {
    // The banned sentence is one that TELLS a coach to add single-limb work
    // BECAUSE a difference was detected. Prescribing unilateral work because
    // single-limb capacity is the goal is fine and is what the evidence
    // supports, so all three parts have to co-occur in one sentence.
    //
    // Each part is spelled widely, because the first version of this guard
    // matched only the words already in the corpus and a reviewer walked three
    // ordinary rewordings straight past it — "consider adding single-arm work",
    // "prescribe one-arm rows", "warrant adding some single-leg work". Those
    // three are fixtures below. A guard that only recognises the phrasing
    // already written is a guard against nothing.
    const PRESCRIBING =
      /\b(?:add|adds|adding|added|prescrib(?:e|es|ing|ed)|assign(?:s|ing|ed)?|program(?:me)?(?:s|ming|med)?|introduc(?:e|es|ing|ed)|start(?:s|ing|ed)?)\b/i;
    const SINGLE_LIMB =
      /\b(?:unilateral|single[ -](?:limb|arm|leg|side)|one[ -](?:arm|leg|side)|per[ -]limb)\b/i;
    const A_DETECTED_DIFFERENCE =
      /\b(?:asymmetr\w*|imbalance[sd]?|difference[sd]?|(?:weaker|weak|lagging|underperforming|deficit|dominant|non-dominant)\s+(?:side|limb|arm|leg))\b/i;
    /** A negation only excuses the sentence when it attaches to the verb itself. */
    const NEGATED_VERB = /\b(?:do not|does not|never|not|rather than|instead of|no)\s+\S{0,20}$/i;

    /**
     * True when `sentence` prescribes single-limb work as the answer to a
     * detected difference. The verb and the limb term have to sit within one
     * clause of each other, in either order — "prescribe one-arm rows" and
     * "single-leg work is worth adding" are the same recommendation.
     */
    function prescribesCorrectiveSingleLimbWork(sentence: string): boolean {
      if (!A_DETECTED_DIFFERENCE.test(sentence)) return false;
      const limb = SINGLE_LIMB.exec(sentence);
      if (limb === null) return false;
      // EVERY verb, not the first: "do not add load; prescribe one-arm rows
      // for the weaker limb" negates the first one and prescribes on the second.
      for (const verb of sentence.matchAll(new RegExp(PRESCRIBING.source, 'gi'))) {
        if (Math.abs(verb.index - limb.index) > 60) continue;
        if (NEGATED_VERB.test(sentence.slice(0, verb.index))) continue;
        return true;
      }
      return false;
    }

    // The reviewer's three rewordings, none of which the first guard caught.
    it.each([
      'Consider adding single-arm work for the lagging side.',
      'If a difference is found, prescribe one-arm dumbbell rows for the underperforming limb.',
      'A consistent asymmetry may warrant adding some single-leg work to that side.',
      'Do not add load; prescribe one-arm rows for the weaker limb.',
    ])('flags the recommendation however it is worded: %s', (sentence) => {
      expect(prescribesCorrectiveSingleLimbWork(sentence)).toBe(true);
    });

    // …while the sentences the corpus is supposed to be allowed to say pass.
    it.each([
      'DO NOT PRESCRIBE CORRECTIVE UNILATERAL WORK OFF A DETECTED ASYMMETRY.',
      'Never add single-leg work because an asymmetry was measured.',
      'So prescribe unilateral work when single-limb capacity is the GOAL.',
      'Answer a detected difference with consistent strength training over time.',
    ])('leaves a legitimate sentence alone: %s', (sentence) => {
      expect(prescribesCorrectiveSingleLimbWork(sentence)).toBe(false);
    });

    it('states the rule outright in the asymmetry topic', async () => {
      const body = parseResult(await h.invoke({ topic: 'meso.asymmetry_interpretation' }));
      expect(body.explanation).toContain('DO NOT PRESCRIBE CORRECTIVE UNILATERAL WORK');
      // …and says what to do instead, so the rule is not just a prohibition.
      expect(body.explanation).toContain('consistent strength training over time');
      expect(body.explanation).toContain('GOAL-SPECIFIC');
      expect(body.sources).toContain(
        'liao-2022-unilateral-vs-bilateral-training-meta-analysis-biology-of-sport',
      );
    });

    it('recommends it nowhere in the corpus', () => {
      const offenders: string[] = [];
      for (const topic of CoachingTopic.options) {
        const content = COACHING_CONTENT[topic];
        const text = [content.allTiers, ...Object.values(content.perTier ?? {})].join(' ');
        for (const sentence of text.split(/(?<=\.)\s+/)) {
          if (prescribesCorrectiveSingleLimbWork(sentence)) {
            offenders.push(`${topic}: ${sentence.trim()}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  // VW-357: priorities-not-numbers goal setting, committed/stretch bands,
  // fixed-for-the-meso targets decided only at the block boundary.
  it('states the goal-setting rule: bands, fixed targets, block-boundary decisions (VW-357)', async () => {
    // Arrange / Act
    const body = parseResult(await h.invoke({ topic: 'meso.goal_setting' }));

    // Assert
    expect(body.explanation).toContain('committed');
    expect(body.explanation).toContain('stretch');
    expect(body.explanation).toMatch(/fixed|block boundary/i);
    expect(body.explanation).toContain('BEGINNER EXCEPTION');
    expect(body.sources).toContain('rp-s10-underpromise-overdeliver-goal-setting');
    expect(body.sources).toContain('rp-s5-fatloss-priority-training-rule');
    expect(body.sources).toContain('rp-s3-old-prs-irrelevant-reframe');
    expect(body.caveats?.length).toBeGreaterThan(0);
  });

  it.each(['beginner', 'intermediate', 'advanced'] as const)(
    'returns non-empty goal-setting prose for tier %s',
    async (tier) => {
      // Arrange / Act
      const body = parseResult(await h.invoke({ topic: 'meso.goal_setting', tier }));

      // Assert: this topic has no perTier entry, so every tier falls back to
      // the same complete, non-empty explanation.
      expect(body.explanation.length).toBeGreaterThan(0);
      expect(body.sources.length).toBeGreaterThan(0);
    },
  );

  it('rejects an unknown topic', async () => {
    // Arrange / Act
    const r = await h.invoke({ topic: 'not.a.real.topic' });

    // Assert
    expect(r.isError).toBe(true);
  });

  it('rejects an unknown key rather than silently ignoring it', async () => {
    // Arrange / Act
    const r = await h.invoke({ topic: 'live.cue_budget', exercise: 'bench-press' });

    // Assert
    expect(r.isError).toBe(true);
  });

  it('rejects an invalid tier value', async () => {
    // Arrange / Act
    const r = await h.invoke({ topic: 'live.cue_budget', tier: 'expert' });

    // Assert
    expect(r.isError).toBe(true);
  });
});

// VW-298: translating an RP RIR prescription into a velocity is what makes the
// prescription actionable on this device, and it is only defensible off the
// lifter's OWN curve.
describe('coaching.explain — RIR to velocity', () => {
  it('gives two lifters with different curves different targets for the same RIR', async () => {
    // Arrange: one lifter grinds slowly, the other moves fast and decays hard.
    const slow = setup(storeWithCurves({ row: curve(0.15, 0.03) }));
    const fast = setup(storeWithCurves({ row: curve(0.35, 0.09) }));
    const args = { topic: 'live.rir_estimation', exerciseId: 'row', rir: 2 };

    // Act
    const slowBody = parseResult(await slow.invoke(args));
    const fastBody = parseResult(await fast.invoke(args));

    // Assert
    expect(slowBody.rirVelocityTarget?.velocityTargetMps).toBeCloseTo(0.21, 2);
    expect(fastBody.rirVelocityTarget?.velocityTargetMps).toBeCloseTo(0.53, 2);
    expect(slowBody.explanation).toEqual(fastBody.explanation);
  });

  it('returns the stated general-model caveat when the lifter has no curve', async () => {
    // Arrange
    const h = setup(storeWithCurves({}));

    // Act
    const body = parseResult(
      await h.invoke({ topic: 'live.rir_estimation', exerciseId: 'row', rir: 2 }),
    );

    // Assert
    expect(body.rirVelocityTarget?.velocityTargetMps).toBeNull();
    expect(body.rirVelocityTarget?.caveat).toBe(GENERAL_MODEL_CAVEAT);
  });

  it('omits the target when no exercise is named', async () => {
    // Arrange
    const h = setup(storeWithCurves({ row: curve(0.2, 0.05) }));

    // Act
    const body = parseResult(await h.invoke({ topic: 'live.rir_estimation' }));

    // Assert: the prose still answers the question asked.
    expect(body.rirVelocityTarget).toBeUndefined();
    expect(body.explanation).toContain('RIR');
  });

  it('ignores the pair on a topic that prescribes no RIR', async () => {
    // Arrange
    const h = setup(storeWithCurves({ row: curve(0.2, 0.05) }));

    // Act
    const body = parseResult(
      await h.invoke({ topic: 'live.cue_budget', exerciseId: 'row', rir: 2 }),
    );

    // Assert
    expect(body.rirVelocityTarget).toBeUndefined();
    expect(body.topic).toBe('live.cue_budget');
  });

  it('rejects an exercise with no reps-in-reserve beside it', async () => {
    // Arrange / Act: half a target claim answers nothing.
    const h = setup(storeWithCurves({}));
    const r = await h.invoke({ topic: 'live.rir_estimation', exerciseId: 'row' });

    // Assert
    expect(r.isError).toBe(true);
  });
});
