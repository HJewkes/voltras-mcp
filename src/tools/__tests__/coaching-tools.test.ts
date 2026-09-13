// Unit tests for src/tools/coaching-tools.ts (VW-136/VW-137).
//
// What's load-bearing here: every topic resolves to real content (no gaps in
// the Record), tier-narrowing actually changes the response for topics that
// define it and leaves others alone, sources/caveats reach the caller, and
// the schema rejects an unknown topic/key.

import { beforeEach, describe, expect, it } from 'vitest';

import { CoachingTopic } from '../../schemas/coaching.js';
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

function setup(): Harness {
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
    undefined as unknown as Parameters<typeof registerCoachingTools>[1],
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
} {
  return JSON.parse(r.content[0].text);
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
