// Unit tests for src/tools/goal-guardrails.ts (VW-350, plan §2a).
//
// Every case here checks the same property twice over: the finding is
// reported, AND the declaration is untouched by it. These guardrails are
// advisory, so a rule that silently rewrote an item would be the bug.

import { describe, expect, it } from 'vitest';

import type { StoredPriority } from '../../store/types.js';
import {
  evaluateDeclaration,
  FAT_LOSS_DOWNGRADE_CODE,
  type DeclaredItem,
  type GoalGuardrailContext,
} from '../goal-guardrails.js';

function item(ref: string, level: DeclaredItem['level'] = 'specialize'): DeclaredItem {
  return { kind: 'muscle', ref, level };
}

function priority(overrides: Partial<StoredPriority> = {}): StoredPriority {
  return {
    id: `p-${overrides.ref ?? 'x'}`,
    userId: 'local',
    horizonWeeks: 6,
    kind: 'muscle',
    ref: 'chest',
    level: 'specialize',
    declaredAt: '2026-09-01T00:00:00.000Z',
    mesosHeld: 0,
    ...overrides,
  };
}

function context(overrides: Partial<GoalGuardrailContext> = {}): GoalGuardrailContext {
  return {
    items: [item('chest')],
    existing: [],
    dietPhase: 'maintenance',
    tier: 'intermediate',
    declinedRefs: [],
    ...overrides,
  };
}

const codesOf = (warnings: { code: string }[]) => warnings.map((warning) => warning.code);

describe('specialize cap', () => {
  it('passes two specialized items', () => {
    const result = evaluateDeclaration(context({ items: [item('chest'), item('back')] }));
    expect(codesOf(result.warnings)).toEqual([]);
  });

  it('warns at three, and does not touch the declaration', () => {
    const items = [item('chest'), item('back'), item('biceps')];
    const result = evaluateDeclaration(context({ items }));
    expect(codesOf(result.warnings)).toEqual(['specialize_cap_exceeded']);
    expect(items.every((declared) => declared.level === 'specialize')).toBe(true);
  });
});

describe('fat-loss specialization', () => {
  it('proposes a downgrade per specialized item without applying it', () => {
    const items = [item('chest'), item('back')];
    const result = evaluateDeclaration(context({ items, dietPhase: 'fat-loss' }));
    expect(result.proposals.map((proposal) => proposal.ref)).toEqual(['chest', 'back']);
    expect(result.proposals[0]).toMatchObject({
      code: FAT_LOSS_DOWNGRADE_CODE,
      from: 'specialize',
      to: 'maintain',
    });
    expect(result.proposals[0].rpIds).toContain('rp:rp-s5-fatloss-priority-training-rule');
    expect(items.every((declared) => declared.level === 'specialize')).toBe(true);
  });

  it('carries the beginner exception instead of a proposal', () => {
    const result = evaluateDeclaration(
      context({ items: [item('chest')], dietPhase: 'fat-loss', tier: 'beginner' }),
    );
    expect(result.proposals).toEqual([]);
    expect(codesOf(result.warnings)).toEqual(['fat_loss_specialize_beginner_exception']);
  });

  it('does not re-offer a downgrade this call declines', () => {
    const declining = { ...item('chest'), declineFatLossDowngrade: true };
    const result = evaluateDeclaration(context({ items: [declining], dietPhase: 'fat-loss' }));
    expect(result.proposals).toEqual([]);
    expect(result.declinedNow).toEqual(['chest']);
  });

  it('does not re-offer a downgrade declined in an earlier call', () => {
    const result = evaluateDeclaration(
      context({ items: [item('chest')], dietPhase: 'fat-loss', declinedRefs: ['chest'] }),
    );
    expect(result.proposals).toEqual([]);
    expect(result.declinedNow).toEqual([]);
  });

  it('leaves a maintain item alone in a fat-loss phase', () => {
    const result = evaluateDeclaration(
      context({ items: [item('chest', 'maintain')], dietPhase: 'fat-loss' }),
    );
    expect(result.proposals).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe('mid-block change', () => {
  it('warns when a block already holds a different priority', () => {
    const result = evaluateDeclaration(
      context({
        items: [item('back')],
        existing: [priority({ ref: 'chest', blockId: 'block-1' })],
        blockId: 'block-1',
      }),
    );
    expect(codesOf(result.warnings)).toContain('priority_changed_mid_block');
    expect(result.warnings[0].rpIds).toEqual(['rp:rp-s6-priority-muscle-held-constant-per-block']);
  });

  it('stays quiet when the same declaration is restated inside the block', () => {
    const result = evaluateDeclaration(
      context({
        items: [item('chest')],
        existing: [priority({ ref: 'chest', blockId: 'block-1' })],
        blockId: 'block-1',
      }),
    );
    expect(codesOf(result.warnings)).not.toContain('priority_changed_mid_block');
  });

  it('stays quiet when the change lands in a different block', () => {
    const result = evaluateDeclaration(
      context({
        items: [item('back')],
        existing: [priority({ ref: 'chest', blockId: 'block-1' })],
        blockId: 'block-2',
      }),
    );
    expect(codesOf(result.warnings)).not.toContain('priority_changed_mid_block');
  });
});

describe('persistence nudge', () => {
  it('fires for a specialized priority dropped after one mesocycle', () => {
    const result = evaluateDeclaration(
      context({
        items: [item('back')],
        existing: [priority({ ref: 'chest', mesosHeld: 1 })],
      }),
    );
    const nudge = result.warnings.find((w) => w.code === 'priority_persistence_nudge');
    expect(nudge?.ref).toBe('chest');
    expect(nudge?.rpIds).toEqual(['rp:rp-s5-goal-persistence-multi-meso']);
  });

  it('stays quiet once it has been held long enough', () => {
    const result = evaluateDeclaration(
      context({
        items: [item('back')],
        existing: [priority({ ref: 'chest', mesosHeld: 2 })],
      }),
    );
    expect(codesOf(result.warnings)).not.toContain('priority_persistence_nudge');
  });
});
