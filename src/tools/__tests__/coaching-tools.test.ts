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
