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
    const PRESCRIBES_SINGLE_LIMB =
      /\b(?:add|prescribe|assign|program|introduce|start)\b[^.]{0,60}\b(?:unilateral|single-limb)\b/i;
    const TRIGGERED_BY_A_DIFFERENCE = /\b(?:asymmetr|imbalance|weaker (?:side|limb))/i;
    /** A negation only excuses the sentence when it attaches to the verb itself. */
    const NEGATED_VERB = /\b(?:do not|does not|never|not|rather than|instead of|no)\s+\S{0,20}$/i;

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
          const match = PRESCRIBES_SINGLE_LIMB.exec(sentence);
          if (match === null) continue;
          if (!TRIGGERED_BY_A_DIFFERENCE.test(sentence)) continue;
          if (NEGATED_VERB.test(sentence.slice(0, match.index))) continue;
          offenders.push(`${topic}: ${sentence.trim()}`);
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
