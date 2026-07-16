// Deterministic coaching-cue template catalog and selector (VMCP-02.79, PR2).
//
// Pure module: no runtime deps, no SDK, no Node APIs — so it is trivial to unit
// test and safe to import from any layer. A later PR wires the CueSelector into
// the live set pipeline, so the public interface here is pinned.

export type CueCategory = 'set_intro' | 'target_hit' | 'slowdown' | 'set_complete';

// Static, hand-authored catalog. Spoken coaching cues — natural and concise
// (<= ~12 words each). Slot names per category follow the fixed contract:
//   set_intro:    weight (optional), ordinal (optional)
//   target_hit:   target, actual
//   slowdown:     pct, rep
//   set_complete: reps, seconds, loss (optional)
// set_intro intentionally mixes both-slot, ordinal-only, and no-slot phrasings
// so a set that has no weight still has playable options.
export const CUE_CATALOG: Record<CueCategory, readonly string[]> = {
  set_intro: [
    'Set ${ordinal}, ${weight} pounds — let’s go.',
    'Set ${ordinal} at ${weight} pounds. Send it.',
    '${weight} pounds this set. Own it.',
    'Rack’s loaded to ${weight}. Go.',
    'Set ${ordinal} — bring the intensity.',
    'This is set ${ordinal}. Lock in.',
    'Next set — let’s go.',
    'Fresh set. Make it count.',
  ],
  target_hit: [
    'That’s your ${target} — bonus reps now.',
    'Target ${target} hit at ${actual}. Keep going.',
    '${actual} reps — you cleared ${target}.',
    'Goal reached: ${target}. Everything now is extra.',
    'You hit ${target}. Free reps from here.',
    '${target} down. Push for more.',
    'Past ${target} now — ${actual} and climbing.',
  ],
  slowdown: [
    'Velocity down ${pct} percent. Stay tight.',
    'That rep was ${pct} percent slower. Reset.',
    'Down ${pct} percent — make each rep count.',
    'Rep ${rep} slowed — control it.',
    'Losing speed on rep ${rep}. Brace.',
    'Speed’s dropping — one clean rep left.',
    'Bar speed fading. Finish strong.',
  ],
  set_complete: [
    'Nice — ${reps} reps, done.',
    '${reps} reps in ${seconds} seconds. Solid.',
    'Done in ${seconds} seconds. ${reps} strong reps.',
    'Set done — ${reps} reps, ${loss} percent drop.',
    '${reps} reps, ${loss} percent velocity loss. Logged.',
    'That’s ${reps}. Rest up.',
    'Set complete — ${reps} reps banked.',
  ],
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
