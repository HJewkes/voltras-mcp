// Unit tests for the deterministic cue-template catalog and selector
// (VMCP-02.79, PR2). Pure module — imported directly, no vi.mock needed.

import { describe, expect, it } from 'vitest';

import {
  CUE_CATALOG,
  CueSelector,
  slotFill,
  templateSlots,
  type CueCategory,
} from '../cue-templates.js';

// The fixed slot contract per category — the guard test asserts no template
// references a slot outside its category's allowed set.
const ALLOWED_SLOTS: Record<CueCategory, Set<string>> = {
  set_intro: new Set(['weight', 'ordinal']),
  target_hit: new Set(['target', 'actual']),
  slowdown: new Set(['pct', 'rep']),
  set_complete: new Set(['reps', 'seconds', 'loss']),
};

const CATEGORIES = Object.keys(CUE_CATALOG) as CueCategory[];

// Deterministic rng that walks a fixed sequence, wrapping around. Lets tests
// drive the selector's rotation without relying on Math.random.
function sequenceRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('templateSlots', () => {
  it('extracts unique slot names in first-appearance order', () => {
    expect(templateSlots('${a} then ${b} then ${a}')).toEqual(['a', 'b']);
  });

  it('returns an empty array for a template with no slots', () => {
    expect(templateSlots('no slots here')).toEqual([]);
  });
});

describe('slotFill', () => {
  it('interpolates all referenced slots, leaving no ${ markers', () => {
    const out = slotFill('${reps} reps in ${seconds} seconds.', { reps: 8, seconds: 42 });
    expect(out).toBe('8 reps in 42 seconds.');
    expect(out).not.toContain('${');
  });

  it('accepts both string and number slot values', () => {
    expect(slotFill('${ordinal} at ${weight}', { ordinal: '3', weight: 185 })).toBe('3 at 185');
  });

  it('throws when a referenced slot is missing', () => {
    expect(() => slotFill('${target} down', {})).toThrow(/missing slot "target"/);
  });
});

describe('CueSelector', () => {
  it('never repeats a template until the satisfiable set is exhausted, then resets', () => {
    // rng always picks index 0 of the remaining candidates, so each pick is
    // deterministic and rotation alone drives coverage.
    const selector = new CueSelector({ rng: () => 0 });
    const satisfiable = CUE_CATALOG.target_hit.filter((t) =>
      templateSlots(t).every((s) => ALLOWED_SLOTS.target_hit.has(s)),
    );
    const slots = ['target', 'actual'];

    const firstCycle = satisfiable.map(() => selector.pick('target_hit', slots));
    expect(new Set(firstCycle).size).toBe(satisfiable.length); // all unique
    expect(new Set(firstCycle)).toEqual(new Set(satisfiable)); // covers every template

    // After exhaustion the used-set resets, so the next pick is drawn from the
    // full satisfiable set again.
    const afterReset = selector.pick('target_hit', slots);
    expect(satisfiable).toContain(afterReset);
    expect(afterReset).toBe(firstCycle[0]);
  });

  it('respects rng ordering across a full cycle (no repeats)', () => {
    const selector = new CueSelector({ rng: sequenceRng([0.99, 0.5, 0.0, 0.7, 0.2, 0.9, 0.4]) });
    const slots = ['reps', 'seconds', 'loss'];
    const satisfiable = CUE_CATALOG.set_complete;
    const cycle = satisfiable.map(() => selector.pick('set_complete', slots));
    expect(new Set(cycle).size).toBe(satisfiable.length);
  });

  it('never returns a weight-referencing template when only ordinal is available', () => {
    const selector = new CueSelector({ rng: sequenceRng([0.1, 0.9, 0.5, 0.3, 0.7]) });
    for (let i = 0; i < 40; i++) {
      const template = selector.pick('set_intro', ['ordinal']);
      expect(templateSlots(template)).not.toContain('weight');
    }
  });

  it('every returned template only references available slots', () => {
    const selector = new CueSelector({ rng: sequenceRng([0.2, 0.8, 0.4, 0.6]) });
    const available = ['reps', 'seconds']; // no `loss`
    for (let i = 0; i < 30; i++) {
      const template = selector.pick('set_complete', available);
      for (const slot of templateSlots(template)) {
        expect(available).toContain(slot);
      }
    }
  });
});

describe('CUE_CATALOG slot contract', () => {
  it('every template references only slots allowed for its category', () => {
    for (const category of CATEGORIES) {
      for (const template of CUE_CATALOG[category]) {
        for (const slot of templateSlots(template)) {
          expect(ALLOWED_SLOTS[category].has(slot)).toBe(true);
        }
      }
    }
  });

  it('set_intro offers at least one ordinal-only-or-simpler option', () => {
    const playable = CUE_CATALOG.set_intro.filter((t) => !templateSlots(t).includes('weight'));
    expect(playable.length).toBeGreaterThan(0);
  });
});
