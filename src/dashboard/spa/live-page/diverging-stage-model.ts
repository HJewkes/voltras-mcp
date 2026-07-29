/**
 * Pure projections for the diverging dual stage (VMCP-04.05).
 *
 * Separate from `DivergingLiveStage.tsx` for a concrete reason, not tidiness: the
 * component imports `react-native`, and the node-side vitest run cannot parse it
 * (real RN ships Flow syntax — `import typeof`). Anything living in the `.tsx` is
 * therefore UNTESTABLE here, which is why every other projection in this app sits
 * in a `*-view.ts` / `*-model.ts` beside its component. These functions carry the
 * stage's load-bearing rules, so they belong on the testable side of that line.
 *
 * Rule 1 — an unbound slot is shown as a GAP. Never mirrored from the bound side,
 * never quietly dropped so a bilateral view masquerades as a solo one.
 *
 * Rule 2 (VMCP-04.06) — a chart only earns stage height when it has something to
 * draw. Per-sample curves can arrive empty from a summary-only rep stream, and an
 * empty ghost spark is a bare axis where the diverging hero could have been.
 */
import type { DualVelocityStream } from '@titan-design/react-ui';
import type { DivergingHeroModel, DivergingHeroSide, RepVelocityCurve } from './fatigue-model';

/**
 * A model side → the component's stream.
 *
 * A null (unbound) side still renders a wing: an empty one. `DualVelocityStrip`
 * requires both `left` and `right`, and empty is the honest rendering — the axis
 * stays centred and the bound side keeps its true scale, so one bound Voltra reads
 * as "one arm reporting" rather than as a solo chart that hides the second slot.
 */
export function toStream(side: DivergingHeroSide | null): DualVelocityStream {
  return {
    velocities: side?.repVelocitiesMps ?? [],
    // `label ?? undefined`: the component treats absent as "render no label", and
    // there is deliberately no hardcoded LEFT/RIGHT fallback on either side of this
    // boundary — an unnamed slot stays unnamed rather than acquiring a guessed name.
    label: side?.label ?? undefined,
  };
}

/**
 * Which slots have no device bound, in stable left-then-right order.
 *
 * Stable because the awaiting note should read the same way every time rather than
 * reordering as slots bind and drop.
 */
export function missingSides(hero: DivergingHeroModel): ('left' | 'right')[] {
  const missing: ('left' | 'right')[] = [];
  if (hero.left === null) missing.push('left');
  if (hero.right === null) missing.push('right');
  return missing;
}

/**
 * Whether the diverging stage has anything at all to draw.
 *
 * Neither slot bound is the ordinary single-Voltra case — a bench session runs on
 * the `primary` slot, so both `left` and `right` come back null. Rendering the
 * diverging stage then produces an empty axis with an "awaiting both" note and no
 * telemetry, while the athlete IS lifting and the single view would have shown it.
 * The page uses this to fall back rather than show a screen of nothing.
 *
 * ONE bound side is different and still renders: that is a genuine bilateral
 * session with a slot missing, and the gap is the message.
 */
export function hasBoundSide(hero: DivergingHeroModel): boolean {
  return hero.left !== null || hero.right !== null;
}

/**
 * A model side → the wing of curves `DualGhostSpark` plots (VMCP-04.06).
 *
 * An unbound side contributes NO curves rather than a mirrored copy of the bound
 * one — the same gap rule {@link toStream} follows. The spark draws one wing then,
 * which reads as "one arm reporting" instead of a fabricated symmetry.
 */
export function toGhostCurves(side: DivergingHeroSide | null): RepVelocityCurve[] {
  return side?.velocityCurves ?? [];
}

/**
 * Whether the ghost spark has any real SHAPE to draw.
 *
 * Not the same question as `hasBoundSide`. A rep can cross `/api/snapshot` as a
 * SUMMARY — counts and peaks but no per-sample stream — which is a legitimate wire
 * state (older firmware, a driver that reports counts but not curves), and the
 * mapper honestly degrades it to a curve with zero samples. Those curves plot as
 * nothing: a pair of empty wings and a bare axis eating a third of the stage while
 * the athlete is mid-set. So the stage asks for at least one sample somewhere
 * before it spends the height, and otherwise leaves the diverging hero full-size.
 */
export function hasGhostCurves(hero: DivergingHeroModel): boolean {
  return [...toGhostCurves(hero.left), ...toGhostCurves(hero.right)].some(
    (curve) => curve.samples.length > 0,
  );
}
