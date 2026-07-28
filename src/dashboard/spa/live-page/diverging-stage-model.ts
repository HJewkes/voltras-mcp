/**
 * Pure projections for the diverging dual stage (VMCP-04.05).
 *
 * Separate from `DivergingLiveStage.tsx` for a concrete reason, not tidiness: the
 * component imports `react-native`, and the node-side vitest run cannot parse it
 * (real RN ships Flow syntax — `import typeof`). Anything living in the `.tsx` is
 * therefore UNTESTABLE here, which is why every other projection in this app sits
 * in a `*-view.ts` / `*-model.ts` beside its component. These two functions carry
 * the stage's one load-bearing rule, so they belong on the testable side of that
 * line.
 *
 * The rule: an unbound slot is shown as a GAP. Never mirrored from the bound side,
 * never quietly dropped so a bilateral view masquerades as a solo one.
 */
import type { DualVelocityStream } from '@titan-design/react-ui';
import type { DivergingHeroModel, DivergingHeroSide } from './fatigue-model';

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
