// VW-306: the two fatigue axes must diverge, and neither may carry a nutrition
// label.
//
// The load-bearing fixture is the pair the research note names: a DEPRESSED
// ENTRY with FLAT DECAY (under-recovered, then the session held together) and a
// NORMAL ENTRY with STEEP DECAY (arrived fresh, then the work accumulated).
// Today's single blended decay number reads those two as near-identical; the
// axes have to separate them, in opposite directions.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { computeFatigueAxes, type FatigueAxes, type FatigueSetReading } from '../fatigue-axes.js';
import { COACHING_CONTENT } from '../../tools/coaching-content.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────

const LOAD = 100;

interface SetSpec {
  velocity: number;
  load?: number;
  rest?: number;
  eccentric?: number;
  warmup?: boolean;
}

function reading(id: string, spec: SetSpec): FatigueSetReading {
  return {
    setId: id,
    meanVelocity: spec.velocity,
    isWarmup: spec.warmup ?? false,
    loadLbs: spec.load ?? LOAD,
    ...(spec.rest !== undefined ? { restBeforeSec: spec.rest } : {}),
    ...(spec.eccentric !== undefined ? { eccentricPct: spec.eccentric } : {}),
  };
}

function sets(specs: readonly SetSpec[]): FatigueSetReading[] {
  return specs.map((spec, i) => reading(`s${String(i)}`, spec));
}

/** The lifter's norm at this load: three prior sets opening at 1.00 m/s. */
const REFERENCE = sets([
  { velocity: 1.2, warmup: true, load: 60 },
  { velocity: 1.0, rest: 180, eccentric: 0 },
  { velocity: 0.97, rest: 180, eccentric: 0 },
  { velocity: 0.94, rest: 180, eccentric: 0 },
]);

/** Opened 20% below the norm, then barely fell at all across the session. */
const DEPRESSED_ENTRY_FLAT_DECAY = sets([
  { velocity: 0.96, warmup: true, load: 60 },
  { velocity: 0.8, rest: 180, eccentric: 0 },
  { velocity: 0.79, rest: 180, eccentric: 0 },
  { velocity: 0.78, rest: 180, eccentric: 0 },
]);

/** Opened on the norm, then fell hard set over set. */
const NORMAL_ENTRY_STEEP_DECAY = sets([
  { velocity: 1.2, warmup: true, load: 60 },
  { velocity: 1.0, rest: 180, eccentric: 0 },
  { velocity: 0.9, rest: 180, eccentric: 0 },
  { velocity: 0.8, rest: 180, eccentric: 0 },
]);

function axesFor(sessionSets: readonly FatigueSetReading[]): FatigueAxes {
  return computeFatigueAxes({ sessionSets, referenceSets: REFERENCE });
}

// ─── The divergence fixture ───────────────────────────────────────────────

describe('computeFatigueAxes — the two axes diverge', () => {
  it('reports a depressed entry with flat decay and a normal entry with steep decay as opposites', () => {
    const depressed = axesFor(DEPRESSED_ENTRY_FLAT_DECAY);
    const steep = axesFor(NORMAL_ENTRY_STEEP_DECAY);

    // Depressed entry: opened ~18% below a 0.97 m/s norm, then held.
    expect(depressed.entryDepression.value).toBeCloseTo(17.53, 2);
    expect(depressed.lateSessionDecay.value).toBeCloseTo(1.25, 2);

    // Normal entry: opened ON the norm, then shed 10% of it per set.
    expect(steep.entryDepression.value).toBeCloseTo(-3.09, 2);
    expect(steep.lateSessionDecay.value).toBeCloseTo(10, 2);

    // The separation, stated as the thing the blended number could not do.
    expect(depressed.entryDepression.value!).toBeGreaterThan(steep.entryDepression.value!);
    expect(depressed.lateSessionDecay.value!).toBeLessThan(steep.lateSessionDecay.value!);
  });

  it('does not let a steep decay raise entry depression, or a depressed entry raise decay', () => {
    // Same opener as the steep session, same decay as the flat one: each axis
    // has to follow its own input, which is what a swapped implementation
    // would break.
    const mixed = axesFor(
      sets([
        { velocity: 1.2, warmup: true, load: 60 },
        { velocity: 1.0, rest: 180, eccentric: 0 },
        { velocity: 0.99, rest: 180, eccentric: 0 },
        { velocity: 0.98, rest: 180, eccentric: 0 },
      ]),
    );

    expect(mixed.entryDepression.value).toBeCloseTo(
      axesFor(NORMAL_ENTRY_STEEP_DECAY).entryDepression.value!,
      6,
    );
    expect(mixed.lateSessionDecay.value).toBeCloseTo(1, 2);
  });
});

// ─── Confounder reporting ─────────────────────────────────────────────────

describe('computeFatigueAxes — confounders', () => {
  it('reports all four as controlled when load, rest, eccentric setting and warm-up all held', () => {
    const axes = axesFor(NORMAL_ENTRY_STEEP_DECAY);

    expect(axes.entryDepression.controlledConfounders).toEqual([
      'rest',
      'load',
      'eccentricSetting',
      'warmupState',
    ]);
    expect(axes.entryDepression.uncontrolled).toEqual([]);
    expect(axes.lateSessionDecay.uncontrolled).toEqual([]);
  });

  it('moves rest to `uncontrolled` on the decay axis alone when rest varied between sets', () => {
    const axes = axesFor(
      sets([
        { velocity: 1.2, warmup: true, load: 60 },
        { velocity: 1.0, rest: 180, eccentric: 0 },
        { velocity: 0.9, rest: 300, eccentric: 0 },
        { velocity: 0.8, rest: 90, eccentric: 0 },
      ]),
    );

    expect(axes.lateSessionDecay.uncontrolled).toEqual(['rest']);
    expect(axes.lateSessionDecay.controlledConfounders).toEqual([
      'load',
      'eccentricSetting',
      'warmupState',
    ]);
    // The entry axis compares the OPENER against prior sessions, so rest
    // between later sets is not one of its terms and it still reports rest as
    // controlled. Two axes, two confounder sets.
    expect(axes.entryDepression.controlledConfounders).toContain('rest');
    // The value is unchanged either way: a confounder is reported, not applied.
    expect(axes.entryDepression.value).toBeCloseTo(-3.09, 2);
  });

  it('treats an unrecorded rest or eccentric setting as unknown, never as "the same"', () => {
    const axes = axesFor(sets([{ velocity: 1.0 }, { velocity: 0.9 }, { velocity: 0.8 }]));

    expect(axes.lateSessionDecay.uncontrolled).toEqual(['rest', 'eccentricSetting']);
    expect(axes.entryDepression.uncontrolled).toContain('rest');
    expect(axes.entryDepression.uncontrolled).toContain('eccentricSetting');
    // No warm-up recorded in this session, so warm-up state is unknown too.
    expect(axes.entryDepression.uncontrolled).toContain('warmupState');
  });

  it('lowers confidence as confounders go uncontrolled', () => {
    const controlled = axesFor(NORMAL_ENTRY_STEEP_DECAY);
    const loose = axesFor(sets([{ velocity: 1.0 }, { velocity: 0.9 }, { velocity: 0.8 }]));

    expect(controlled.lateSessionDecay.confidence).toBeGreaterThan(
      loose.lateSessionDecay.confidence,
    );
    expect(controlled.entryDepression.confidence).toBeGreaterThan(loose.entryDepression.confidence);
  });
});

// ─── Not measurable ───────────────────────────────────────────────────────

describe('computeFatigueAxes — nothing to compare', () => {
  it('leaves entry depression null with zero confidence when no prior set matched the load', () => {
    const axes = computeFatigueAxes({
      sessionSets: NORMAL_ENTRY_STEEP_DECAY,
      referenceSets: [],
    });

    expect(axes.entryDepression.value).toBeNull();
    expect(axes.entryDepression.confidence).toBe(0);
    expect(axes.entryDepression.setsCompared).toBe(0);
    // The within-session axis is unaffected — that is the point of splitting.
    expect(axes.lateSessionDecay.value).toBeCloseTo(10, 2);
  });

  it('leaves late-session decay null rather than 0 when one working set is all there is', () => {
    const axes = axesFor(sets([{ velocity: 1.2, warmup: true, load: 60 }, { velocity: 1.0 }]));

    expect(axes.lateSessionDecay.value).toBeNull();
    expect(axes.lateSessionDecay.confidence).toBe(0);
    expect(axes.entryDepression.value).toBeCloseTo(-3.09, 2);
  });

  it('excludes warm-ups and sets at another load from both comparisons', () => {
    const axes = axesFor(
      sets([
        { velocity: 1.2, warmup: true, load: 60 },
        { velocity: 1.0, rest: 180, eccentric: 0 },
        { velocity: 1.6, load: 55, rest: 180, eccentric: 0 },
        { velocity: 0.8, rest: 180, eccentric: 0 },
      ]),
    );

    // The 55 lb set would have dominated a slope that admitted it.
    expect(axes.lateSessionDecay.setsCompared).toBe(2);
    expect(axes.lateSessionDecay.value).toBeCloseTo(20, 2);
  });
});

// ─── The nutrition-label ban ──────────────────────────────────────────────

const MODULE_PATH = fileURLToPath(new URL('../fatigue-axes.ts', import.meta.url));

/**
 * Words that would turn either axis into a nutrition verdict. The research
 * note (VW-278) found no signature in this telemetry that separates a
 * fuel-limited session from an under-recovered one, so a field name or a
 * sentence that implies one is a claim the data cannot carry.
 */
const NUTRITION_WORDS = /glycogen|carbohydrate|carbs?\b|fuel(?:led|ling|s)?\b|nutrition(?:al)?/i;

/** A sentence may name one only to refuse it. */
const REFUSAL = /\b(not|never|no|neither|nor|cannot|without|refus\w*|unaffected)\b/i;

function sentencesOf(text: string): string[] {
  return text.split(/(?<=\.)\s+/).filter((sentence) => sentence.trim().length > 0);
}

describe('VW-306 — neither axis carries a nutrition label', () => {
  it("never writes one of those words into the axes module's CODE", () => {
    // Comments are stripped and checked separately below: a line-comment can
    // cite the research that forbids the label, a field name or a string
    // literal cannot — those are what a caller reads back.
    const code = readFileSync(MODULE_PATH, 'utf8').replace(/^\s*\/\/.*$/gm, '');

    expect(NUTRITION_WORDS.test(code)).toBe(false);
  });

  it("names one in the module's comments only inside a sentence that refuses it", () => {
    const comments = readFileSync(MODULE_PATH, 'utf8')
      .split('\n')
      .filter((line) => /^\s*\/\//.test(line))
      .join(' ');
    const offenders = sentencesOf(comments).filter(
      (sentence) => NUTRITION_WORDS.test(sentence) && !REFUSAL.test(sentence),
    );

    expect(offenders).toEqual([]);
  });

  it('never writes one into a computed result — field names, values or prose', () => {
    const serialised = JSON.stringify(axesFor(DEPRESSED_ENTRY_FLAT_DECAY));

    expect(NUTRITION_WORDS.test(serialised)).toBe(false);
  });

  it('names one in the coaching topic only inside a sentence that refuses it', () => {
    const content = COACHING_CONTENT['live.fatigue_axes'];
    const text = [
      content.allTiers,
      ...Object.values(content.perTier ?? {}),
      ...(content.caveats ?? []),
      ...content.sources,
    ].join(' ');

    const offenders = sentencesOf(text).filter(
      (sentence) => NUTRITION_WORDS.test(sentence) && !REFUSAL.test(sentence),
    );

    expect(offenders).toEqual([]);
  });

  it('states the refusal outright rather than only omitting it', () => {
    const caveats = (COACHING_CONTENT['live.fatigue_axes'].caveats ?? []).join(' ');

    expect(caveats).toContain('NEITHER AXIS ATTRIBUTES A CAUSE');
    expect(caveats).toMatch(/Thomassen 2025/);
    expect(caveats).toMatch(/Vargas-Molina 2024/);
  });
});
