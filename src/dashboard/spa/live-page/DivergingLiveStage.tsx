/**
 * The diverging dual-Voltra live stage (VMCP-04.05).
 *
 * Replaces the stacked stage that preceded it — two full `LiveView`s in a
 * `ScrollView`, one per slot. That was never the design: it duplicated every
 * shared read-out, and on a height-restricted wall it scrolled, which is the one
 * thing a wall dashboard must not do. The designed stage is a diverging hero, and
 * `DualVelocityStrip` (titan) has carried all three variants since titan #131
 * while having zero consumers here.
 *
 * WHAT IS PER-LIMB AND WHAT IS NOT. Only two things genuinely differ between arms
 * mid-set: the per-rep velocities, and the asymmetry between them. Both live in
 * the hero. Tempo is prescribed per SET, and the exertion verdict describes the
 * ATHLETE — `LiveFatigueModel` says so outright ("there is exactly ONE of these
 * cards even when two devices are live; the only per-limb thing on it is
 * asymmetry"). So the controls row is shared with the single view rather than
 * repeated per side, and sets/reps/load stays on the page-level `ExerciseHeader`
 * where it already sits for both variants.
 *
 * A `null` side is an UNBOUND SLOT, and it renders as an explicit awaiting wing —
 * never a mirrored or fabricated limb. That rule comes from VW-71 and it is the
 * reason the model's sides are nullable at all.
 */
import { useState } from 'react';
import { View, Text, type LayoutChangeEvent } from 'react-native';
import { DualVelocityStrip, LiveAuraFrame, useOnSurfaceColor } from '@titan-design/react-ui';
import { LiveControlsRow } from './LiveView';
import { exertionMessage } from './live-copy';
import { type LiveDashboardModel, verdictFromLoss } from './model';
import type { DivergingHeroModel, LimbAsymmetry } from './fatigue-model';
import { toStream, missingSides } from './diverging-stage-model';

/** Fallback hero height before the first layout pass, matching the single view's dual case. */
const HERO_FALLBACK_H = 260;

/**
 * The L/R callout under the axis — the one read only the dual stage can give.
 *
 * Absent whenever it cannot be computed honestly (single Voltra, both devices on
 * the same side or on no side, a side with no usable mean velocity). The mapper
 * already encodes that as `null`; this just declines to draw. A gap beats a guess.
 */
function AsymmetryCallout({ asymmetry }: { asymmetry: LimbAsymmetry | null }) {
  const strongColor = useOnSurfaceColor('secondary');
  const mutedColor = useOnSurfaceColor('tertiary');
  if (asymmetry === null) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, alignSelf: 'center' }}>
      <Text style={{ color: mutedColor, fontSize: 12, fontWeight: '700', letterSpacing: 2 }}>
        L/R
      </Text>
      <Text style={{ color: strongColor, fontSize: 20, fontWeight: '700' }}>
        {asymmetry.pct.toFixed(0)}%
      </Text>
      <Text style={{ color: mutedColor, fontSize: 14 }}>{asymmetry.strongerLabel} leading</Text>
    </View>
  );
}

/** "Awaiting" note naming any slot that has no device bound, so a gap is legible as a gap. */
function AwaitingSides({ hero }: { hero: DivergingHeroModel }) {
  const color = useOnSurfaceColor('tertiary');
  const missing = missingSides(hero);
  if (missing.length === 0) return null;
  return (
    <Text style={{ color, fontSize: 13, alignSelf: 'center' }}>
      {`awaiting ${missing.join(' + ')} Voltra`}
    </Text>
  );
}

export function DivergingLiveStage({
  model,
  hero,
  asymmetry,
}: {
  model: LiveDashboardModel;
  hero: DivergingHeroModel;
  asymmetry: LimbAsymmetry | null;
}) {
  const { live, session } = model;
  const [contentW, setContentW] = useState(0);
  const [heroH, setHeroH] = useState(0);

  // The verdict floods the whole stage, exactly as the single view does — one athlete,
  // one aura, regardless of how many devices are reporting into it.
  const verdict = verdictFromLoss(live.velocityLossPct);
  const message = exertionMessage(live.velocityLossPct);

  return (
    <LiveAuraFrame category={verdict} style={{ flex: 1, borderRadius: 0, borderWidth: 0 }}>
      <View
        onLayout={(e: LayoutChangeEvent) => setContentW(e.nativeEvent.layout.width)}
        style={{ flex: 1, padding: 24, gap: 10 }}
      >
        <LiveControlsRow
          tempo={session.tempo}
          verdict={verdict}
          message={message}
          containerWidth={contentW}
          livePhase={live.phase}
          phaseElapsedMs={live.phaseElapsedMs}
        />

        <View
          style={{ flex: 1 }}
          onLayout={(e: LayoutChangeEvent) => setHeroH(e.nativeEvent.layout.height)}
        >
          <DualVelocityStrip
            variant="hero"
            left={toStream(hero.left)}
            right={toStream(hero.right)}
            targetReps={hero.targetReps ?? undefined}
            liveRepIndex={hero.liveRepIndex ?? undefined}
            height={heroH > 0 ? heroH : HERO_FALLBACK_H}
            // `scale="peak"` is the pair's shared max plus headroom — which is exactly
            // what the model's `scaleMaxMps` describes. There is no numeric `scale` prop
            // to hand it to (the shipped prop is 'peak' | 'fixed'), and letting the
            // component derive the shared ceiling keeps ONE definition of it rather than
            // two that can disagree. The model field stays useful as the asymmetry datum.
            scale="peak"
            // Per-wing loss colouring: arms fatigue independently, so each wing reads
            // against ITS OWN best. Side is never encoded by hue either way.
            barColor="loss"
          />
        </View>

        <AsymmetryCallout asymmetry={asymmetry} />
        <AwaitingSides hero={hero} />
      </View>
    </LiveAuraFrame>
  );
}
