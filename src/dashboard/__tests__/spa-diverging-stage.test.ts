/**
 * The diverging dual stage's two pure decisions (VMCP-04.05).
 *
 * The SPA has no render-test harness — every other test here asserts on mappers —
 * so the parts of the stage worth holding to their behaviour were split out as pure
 * functions rather than left inline where nothing could reach them. Both encode the
 * same rule, which is the one that matters for a bilateral view: an unbound slot is
 * shown as a GAP, never mirrored from the bound side and never silently dropped.
 */
import { describe, it, expect } from 'vitest';
import {
  toStream,
  toGhostCurves,
  missingSides,
  hasBoundSide,
  hasGhostCurves,
} from '../spa/live-page/diverging-stage-model';
import type {
  DivergingHeroModel,
  DivergingHeroSide,
  RepVelocityCurve,
} from '../spa/live-page/fatigue-model';

/** A curve with real per-sample shape — what a streaming device produces. */
const curve = (repNumber: number, velocityMps = 0.5): RepVelocityCurve => ({
  repNumber,
  samples: [
    { tMs: 0, velocityMps, phase: 'concentric' },
    { tMs: 400, velocityMps: velocityMps * 0.8, phase: 'concentric' },
    { tMs: 900, velocityMps: velocityMps * 0.4, phase: 'eccentric' },
  ],
  phaseSegments: [
    { phase: 'concentric', startMs: 0, endMs: 400 },
    { phase: 'eccentric', startMs: 900, endMs: 900 },
  ],
  tempoDeviation: 0.1,
  grindSignature: 0.2,
});

/** A curve for a SUMMARY-only rep: the rep landed, the sample stream never arrived. */
const sampleLessCurve = (repNumber: number): RepVelocityCurve => ({
  repNumber,
  samples: [],
  phaseSegments: [],
  tempoDeviation: null,
  grindSignature: 0,
});

const side = (over: Partial<DivergingHeroSide> = {}): DivergingHeroSide => ({
  repVelocitiesMps: [0.52, 0.48],
  velocityCurves: [curve(1, 0.52), curve(2, 0.48)],
  label: 'Left Arm',
  bestVelocityMps: 0.52,
  velocityLossPct: 8,
  ...over,
});

const hero = (over: Partial<DivergingHeroModel> = {}): DivergingHeroModel => ({
  left: side(),
  right: side({ label: 'Right Arm' }),
  scaleMaxMps: 0.52,
  targetReps: 8,
  liveRepIndex: 1,
  ...over,
});

describe('toStream — model side → DualVelocityStrip stream', () => {
  it('passes the per-rep velocities and label straight through', () => {
    expect(toStream(side())).toEqual({ velocities: [0.52, 0.48], label: 'Left Arm' });
  });

  it('renders an UNBOUND side as an empty wing, not a mirror of the bound one', () => {
    // The whole point of the nullable side. An empty array keeps the axis centred and
    // leaves the bound side's scale honest; anything copied across would invent a limb.
    expect(toStream(null)).toEqual({ velocities: [], label: undefined });
  });

  it('maps a null label to undefined so the component draws no edge label', () => {
    // The component treats absent/empty as "no label" and has no LEFT/RIGHT fallback —
    // an unnamed slot must stay unnamed rather than acquire a guessed limb name.
    expect(toStream(side({ label: null })).label).toBeUndefined();
  });

  it('keeps a bound side with zero reps distinct from an unbound one only by label', () => {
    // Pre-first-rep is NOT the same state as unbound, and the label is what carries it.
    expect(toStream(side({ repVelocitiesMps: [] }))).toEqual({
      velocities: [],
      label: 'Left Arm',
    });
  });
});

describe('toGhostCurves — model side → DualGhostSpark wing (VMCP-04.06)', () => {
  it('passes the side its own curves through untouched', () => {
    expect(toGhostCurves(side()).map((c) => c.repNumber)).toEqual([1, 2]);
  });

  it('gives an UNBOUND side no curves rather than mirroring the bound one', () => {
    // Same gap rule as `toStream`: one wing means one arm is reporting. A mirrored
    // copy would draw a limb that is not on the machine.
    expect(toGhostCurves(null)).toEqual([]);
  });
});

describe('hasGhostCurves — is there per-sample shape worth spending stage height on', () => {
  it('is true when either side has a curve with samples', () => {
    expect(hasGhostCurves(hero())).toBe(true);
    expect(hasGhostCurves(hero({ right: null }))).toBe(true);
    expect(hasGhostCurves(hero({ left: null }))).toBe(true);
  });

  it('is FALSE when the reps arrived as summaries with no sample stream', () => {
    // A legitimate wire state (older firmware, a driver that reports counts but not
    // curves). Those curves plot as nothing, so the stage must not hand a fifth of its
    // height to a bare axis while the athlete is mid-set.
    const summary = { velocityCurves: [sampleLessCurve(1), sampleLessCurve(2)] };
    expect(hasGhostCurves(hero({ left: side(summary), right: side(summary) }))).toBe(false);
  });

  it('draws as soon as ONE rep carries shape, even alongside sample-less ones', () => {
    // Mixed streams are the realistic mid-set case — a rep can summarize while the next
    // streams. Waiting for all of them would leave the chart off for the whole set.
    expect(
      hasGhostCurves(
        hero({ left: side({ velocityCurves: [sampleLessCurve(1), curve(2)] }), right: null }),
      ),
    ).toBe(true);
  });

  it('is false before the first rep lands on either side', () => {
    expect(hasGhostCurves(hero({ left: side({ velocityCurves: [] }), right: null }))).toBe(false);
    expect(hasGhostCurves(hero({ left: null, right: null }))).toBe(false);
  });
});

describe('hasBoundSide — does the diverging stage have anything to draw', () => {
  it('is true when either slot is bound', () => {
    expect(hasBoundSide(hero())).toBe(true);
    expect(hasBoundSide(hero({ right: null }))).toBe(true);
    expect(hasBoundSide(hero({ left: null }))).toBe(true);
  });

  it('is FALSE when neither is bound — the ordinary single-Voltra case', () => {
    // A bench session runs on the `primary` slot, so both sides come back null. The
    // page falls back to the single view on this; drawing the diverging stage would
    // give an empty axis and an "awaiting both" note mid-lift.
    expect(hasBoundSide(hero({ left: null, right: null }))).toBe(false);
  });

  it('stays true for a bound side that has not landed a rep yet', () => {
    // Bound-with-no-reps is the start of every set. Falling back there would swap the
    // stage out from under the athlete on rep 1.
    expect(hasBoundSide(hero({ left: side({ repVelocitiesMps: [] }), right: null }))).toBe(true);
  });
});

describe('missingSides — which slots are unbound', () => {
  it('is empty when both slots are bound', () => {
    expect(missingSides(hero())).toEqual([]);
  });

  it('names a single unbound slot', () => {
    expect(missingSides(hero({ right: null }))).toEqual(['right']);
    expect(missingSides(hero({ left: null }))).toEqual(['left']);
  });

  it('names both, left first, when neither is bound', () => {
    // Stable order: the note reads the same way every time rather than reordering as
    // slots bind and drop.
    expect(missingSides(hero({ left: null, right: null }))).toEqual(['left', 'right']);
  });

  it('does not treat a bound-but-repless side as missing', () => {
    // A bound Voltra that has not landed a rep yet is present, not awaiting — calling it
    // missing would tell the athlete to go plug in a device that is already connected.
    expect(missingSides(hero({ left: side({ repVelocitiesMps: [] }) }))).toEqual([]);
  });
});

describe('exertionMessage — the alert text shared by both stages', () => {
  it('ROUNDS the loss percent', async () => {
    // REGRESSION: the inline template interpolated the raw ratio, so a real set put
    // `VL23.958333333333336` on the wall.
    const { exertionMessage } = await import('../spa/live-page/live-copy');
    expect(exertionMessage(23.958333333333336)).toContain('VL24%');
    expect(exertionMessage(23.958333333333336)).not.toContain('.9583');
  });

  it('says WARMING UP rather than "VLnull" before a loss can be measured', async () => {
    // REGRESSION: velocityLossPct is null until rep 2, and the template stringified
    // that to the literal `VLnull`.
    const { exertionMessage } = await import('../spa/live-page/live-copy');
    const msg = exertionMessage(null);
    expect(msg).not.toContain('null');
    expect(msg).toMatch(/warming up/i);
  });
});
