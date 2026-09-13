// Font mapping: font-heading=Space Grotesk, font-body=Nunito Sans (UI), font-sans=Inter (body)
import { type ReactElement } from 'react';
import { Text, View } from 'react-native';
import { Surface, useOnSurfaceColor } from '@titan-design/react-ui';
import type { IsometricVerdictCardModel } from './isometric-verdict-model';

// Both labels name the SAME comparison — this athlete's own trial-to-trial spread on this
// test — because that, not a fixed percentage, is what makes an asymmetry a finding.
const VERDICT_LABEL: Record<'flagged' | 'meaningful', string> = {
  meaningful: 'LARGER THAN TRIAL-TO-TRIAL SPREAD',
  flagged: 'WITHIN TRIAL-TO-TRIAL SPREAD',
};

/** One side's peak, printed as the assessment reported it. */
function SidePeak({ label, peakForceLbs }: { label: string; peakForceLbs: number | null }) {
  const labelColor = useOnSurfaceColor('tertiary');
  const valueColor = useOnSurfaceColor('primary');
  return (
    <View style={{ alignItems: 'center', gap: 4 }}>
      <Text style={{ color: labelColor, fontSize: 11, fontWeight: '700', letterSpacing: 2 }}>
        {label}
      </Text>
      <Text style={{ color: valueColor, fontSize: 28, fontWeight: '700' }}>
        {peakForceLbs === null ? '—' : `${peakForceLbs.toFixed(1)} lb`}
      </Text>
    </View>
  );
}

/**
 * The isometric imbalance verdict card (VW-264): what the hold the walkthrough just
 * narrated measured, shown on the wall for `VERDICT_CARD_DWELL_MS`.
 *
 * Before this the assessment's numbers went back to the MCP client and nowhere else — a
 * lifter standing at the rig learned their own asymmetry only if the model chose to speak
 * it. The card puts the peaks, the percentage and the verdict where they were measured.
 *
 * Pure prop-driven, same technique as {@link IsometricWalkthrough}: every decision about
 * WHETHER to show and for how long lives in `isometric-verdict-model.ts`, so `card ===
 * null` renders nothing and this file only draws.
 *
 * Visual language follows `DivergingLiveStage`'s `AsymmetryCallout` — the same L/R
 * percentage read-out the live stage already uses — so the wall says asymmetry one way
 * whether the source is a set or an assessment.
 */
export function IsometricVerdictCard({
  card,
}: {
  card: IsometricVerdictCardModel | null;
}): ReactElement | null {
  // Hooks run unconditionally (rules of hooks) — the `null` guard is below, after.
  const mutedColor = useOnSurfaceColor('tertiary');
  const strongColor = useOnSurfaceColor('secondary');
  const headlineColor = useOnSurfaceColor('primary');
  if (card === null) return null;
  return (
    <Surface
      raise={2}
      rounded
      testID="isometric-verdict-card"
      // Occupies the walkthrough overlay's corner deliberately: it is the same
      // conversation, and the model never shows both (a hold in progress dismisses this).
      style={{
        position: 'absolute',
        top: 24,
        right: 24,
        zIndex: 10,
        paddingHorizontal: 24,
        paddingVertical: 20,
        maxWidth: 420,
        alignItems: 'center',
        gap: 14,
      }}
    >
      <Text style={{ color: mutedColor, fontSize: 11, fontWeight: '700', letterSpacing: 2 }}>
        ISOMETRIC RESULT
      </Text>
      <View style={{ flexDirection: 'row', gap: 28 }}>
        {card.sides.map((side) => (
          <SidePeak key={side.label} label={side.label} peakForceLbs={side.peakForceLbs} />
        ))}
      </View>
      {card.asymmetryPct !== null && (
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
          <Text style={{ color: mutedColor, fontSize: 12, fontWeight: '700', letterSpacing: 2 }}>
            L/R
          </Text>
          <Text
            testID="isometric-verdict-asymmetry"
            style={{ color: headlineColor, fontSize: 34, fontWeight: '700' }}
          >
            {`${card.asymmetryPct.toFixed(1)}%`}
          </Text>
        </View>
      )}
      {card.withheldReason !== null ? (
        <Text
          testID="isometric-verdict-withheld"
          style={{ color: mutedColor, fontSize: 13, textAlign: 'center' }}
        >
          {`Verdict withheld: ${card.withheldReason}`}
        </Text>
      ) : (
        <>
          {card.verdict !== null && (
            <Text
              testID="isometric-verdict-label"
              style={{ color: strongColor, fontSize: 12, fontWeight: '700', letterSpacing: 1.5 }}
            >
              {VERDICT_LABEL[card.verdict]}
            </Text>
          )}
          <Text style={{ color: mutedColor, fontSize: 13, textAlign: 'center' }}>
            {card.reason}
          </Text>
        </>
      )}
    </Surface>
  );
}
