// Deterministic coaching-cue template catalog and selector (VMCP-02.79, PR2).
//
// Pure module: no runtime deps, no SDK, no Node APIs — so it is trivial to unit
// test and safe to import from any layer. A later PR wires the CueSelector into
// the live set pipeline, so the public interface here is pinned.

import { CUE_FRAGMENTS } from '../coach-copy/cues.js';
import type { Fragment } from '../coach-copy/fragments.js';

export type CueCategory = 'set_intro' | 'target_hit' | 'slowdown' | 'set_complete';

function texts(fragments: readonly Fragment[]): readonly string[] {
  return fragments.map((fragment) => fragment.text);
}

// Static, hand-authored catalog, sourced in `src/coach-copy/cues.ts`. Spoken
// coaching cues — natural and concise (<= ~12 words each). Slot names per
// category follow the fixed contract:
//   set_intro:    weight (optional), ordinal (optional)
//   target_hit:   target, actual
//   slowdown:     pct, rep
//   set_complete: reps, seconds, loss (optional)
// set_intro intentionally mixes both-slot, ordinal-only, and no-slot phrasings
// so a set that has no weight still has playable options.
export const CUE_CATALOG: Record<CueCategory, readonly string[]> = {
  set_intro: texts(CUE_FRAGMENTS.setIntro),
  target_hit: texts(CUE_FRAGMENTS.targetHit),
  slowdown: texts(CUE_FRAGMENTS.slowdown),
  set_complete: texts(CUE_FRAGMENTS.setComplete),
};

// Single source of truth for the `${name}` slot syntax. templateSlots and the
// CueSelector must agree on it, so both go through this pattern.
const SLOT_PATTERN = /\$\{(\w+)\}/g;

// Parse the unique `${name}` slot references out of a template string, in
// first-appearance order.
export function templateSlots(template: string): string[] {
  const seen = new Set<string>();
  for (const match of template.matchAll(SLOT_PATTERN)) {
    seen.add(match[1]);
  }
  return [...seen];
}

// Interpolate ${name} from slots. Throws if a referenced slot is missing —
// callers guarantee presence via the selector's satisfiability filter, so a
// missing slot is a programming error we want to surface loudly.
export function slotFill(template: string, slots: Record<string, string | number>): string {
  return template.replace(SLOT_PATTERN, (_, name: string) => {
    const value = slots[name];
    if (value === undefined) {
      throw new Error(`slotFill: missing slot "${name}" for template: ${template}`);
    }
    return String(value);
  });
}

export class CueSelector {
  private readonly rng: () => number;
  // Per-category set of templates returned since the last exhaustion reset.
  private readonly used = new Map<CueCategory, Set<string>>();

  constructor(opts?: { rng?: () => number }) {
    this.rng = opts?.rng ?? Math.random;
  }

  // Filter the category to templates fully satisfiable by availableSlots, then
  // return one with no-repeat-until-exhausted rotation. Returns the raw
  // template string.
  //
  // Fallback: if no template is satisfiable (should not happen for the
  // required-slot categories, whose callers guarantee slots), return the
  // least-demanding template so pick() never throws; the caller's slotFill
  // will then surface any genuinely missing slot.
  pick(category: CueCategory, availableSlots: string[]): string {
    const available = new Set(availableSlots);
    const satisfiable = CUE_CATALOG[category].filter((t) =>
      templateSlots(t).every((slot) => available.has(slot)),
    );
    if (satisfiable.length === 0) {
      return this.leastDemanding(category);
    }
    return this.rotate(category, satisfiable);
  }

  private rotate(category: CueCategory, satisfiable: readonly string[]): string {
    const used = this.usedFor(category);
    let candidates = satisfiable.filter((t) => !used.has(t));
    if (candidates.length === 0) {
      used.clear();
      candidates = [...satisfiable];
    }
    const index = Math.min(candidates.length - 1, Math.floor(this.rng() * candidates.length));
    const chosen = candidates[index];
    used.add(chosen);
    return chosen;
  }

  private usedFor(category: CueCategory): Set<string> {
    let set = this.used.get(category);
    if (!set) {
      set = new Set<string>();
      this.used.set(category, set);
    }
    return set;
  }

  private leastDemanding(category: CueCategory): string {
    return CUE_CATALOG[category].reduce((best, t) =>
      templateSlots(t).length < templateSlots(best).length ? t : best,
    );
  }
}
