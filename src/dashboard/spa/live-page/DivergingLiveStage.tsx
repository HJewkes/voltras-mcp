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
 * WHAT IS PER-LIMB AND WHAT IS NOT. Only the velocity story genuinely differs
 * between arms mid-set: the per-rep trend (`DualVelocityStrip`), the per-sample rep
 * SHAPE (`DualGhostSpark`, VMCP-04.06), and the asymmetry between the two. All
 * three live in the hero column. Tempo is prescribed per SET, and the exertion
 * verdict describes the
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
import {
  DualGhostSpark,
  DualVelocityStrip,
  LiveAuraFrame,
  useOnSurfaceColor,
} from '@titan-design/react-ui';
import { LiveControlsRow } from './LiveView';
import { exertionMessage } from './live-copy';
import { type LiveDashboardModel, verdictFromLoss } from './model';
import type { DivergingHeroModel, LimbAsymmetry } from './fatigue-model';
import { toStream, toGhostCurves, missingSides, hasGhostCurves } from './diverging-stage-model';

/** Fallback hero height before the first layout pass, matching the single view's dual case. */
const HERO_FALLBACK_H = 260;

/**
 * How the stage splits its plot height between the per-rep strip and the per-sample
 * spark. The strip is the primary read (it answers "is the set holding up?" at a
 * glance from across a gym), so it keeps the larger share; the spark is the detail
 * read you walk up to. Flex rather than fixed px so a short wall shrinks both.
 */
const STRIP_FLEX = 3;
const SPARK_FLEX = 2;

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

/**
 * The per-sample half of the bilateral story (VMCP-04.06): each limb's velocity-time
 * curves, left blooming up and right blooming down off a shared phase band.
 *
 * The strip above it plots one number per rep — the trend. This plots the SHAPE of
 * each rep, which is where a unilateral grind actually shows up: two arms can post
 * near-identical mean velocities while one of them stalls mid-concentric and claws
 * back. That difference has no representation in the strip at all.
 *
 * Sized off its OWN layout box rather than the stage's, so the width handed to the
 * component is the real plot width and not the stage width minus a padding constant
 * that has to be kept in sync by hand. Nothing draws until that first measurement
 * lands — a chart at width 0 is a garbage frame, not an early one.
 *
 * `showDeviceLabels` is off deliberately. The component's captions default to the
 * literal `LEFT`/`RIGHT`, which is the hardcoded L/R this codebase moved away from
 * (VMCP-04.12) — a slot's name has to come from its binding or not exist. The wings
 * of the strip directly above already carry the real per-slot labels, so repeating
 * them here would be duplication even where they are known.
 */
function GhostSparkBlock({
  hero,
  targetTempoSeconds,
}: {
  hero: DivergingHeroModel;
  targetTempoSeconds: [number, number, number, number] | null;
}) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  return (
    <View
      style={{ flex: SPARK_FLEX }}
      onLayout={(e: LayoutChangeEvent) =>
        setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
      }
    >
      {box.w > 0 && box.h > 0 ? (
        <DualGhostSpark
          left={toGhostCurves(hero.left)}
          right={toGhostCurves(hero.right)}
          width={box.w}
          height={box.h}
          showDeviceLabels={false}
          targetTempoSeconds={targetTempoSeconds}
        />
      ) : null}
    </View>
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
          style={{ flex: STRIP_FLEX }}
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

        {/* Only when there is real per-sample shape to draw. A summary-only rep stream
            yields sample-less curves, and spending a fifth of the stage on a bare axis
            would be worse than leaving the strip full height. */}
        {hasGhostCurves(hero) ? (
          <GhostSparkBlock hero={hero} targetTempoSeconds={session.tempo ?? null} />
        ) : null}

        <AsymmetryCallout asymmetry={asymmetry} />
        <AwaitingSides hero={hero} />
      </View>
    </LiveAuraFrame>
  );
}
