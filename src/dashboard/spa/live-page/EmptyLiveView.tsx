// Font mapping: font-heading=Space Grotesk, font-body=Nunito Sans (UI), font-sans=Inter (body)
import { useState, type ReactElement } from 'react';
import { Text, View, type LayoutChangeEvent } from 'react-native';
import {
  BluetoothIcon,
  DumbbellIcon,
  EmptyState,
  LiveAuraFrame,
  Metric,
  MetricGroup,
  PlaceholderStrip,
  Surface,
  getSemanticColors,
  useOnSurfaceColor,
} from '@titan-design/react-ui';
import { type DashboardModel } from './model';
import {
  FATIGUE_CARD_WIDTH,
  PANEL_COLUMN_GAP,
  PANEL_PAD,
  heroPlotHeight,
  panelBodyHeight,
} from './panel-geometry';

/*
 * ⚠ PORTING RULE (see LivePage.tsx): layout via `style`, colour via className / tokens.
 * titan's own `EmptyState` expresses its padding and centring as Tailwind classes, which
 * this app silently drops (RNW's base View rules win), so every box it sits in centres it
 * through `style` here. Its COLOUR classNames resolve fine — that half is left to titan.
 *
 * The honest IDLE stage. `RestView` renders a blank padded box when nothing is streaming,
 * nothing is logged, and no rest clock is running (no-session, a session whose first set has
 * not begun, or a disconnected device). That barren view is what the operator hit. This
 * replaces it with a designed empty state — a "waiting for a set" hero plus only the device
 * facts the store can honestly source (loaded weight when the cascade reported one; hidden
 * under the mock adapter, and never a fabricated 0).
 *
 * STRUCTURALLY DERIVED FROM THE LIVE PANEL. The stage this precedes is titan's
 * `LiveFatiguePanel` (see `SingleFatigueStage`): an aura frame around a padded two-column
 * row — flexible velocity hero on the left, fixed 318-wide fatigue card on the right. The
 * idle stage reproduces that skeleton from the SAME constants (`panel-geometry.ts`), down to
 * measuring the stage height the way `SingleFatigueStage` does, so the first set of a session
 * POPULATES the panel rather than replacing a centred blob with one. What the idle skeleton
 * holds are labels and placeholder rules, never numbers: a gap must read as a gap.
 *
 * READ-ONLY WALL: sets start on the machine / via MCP, never from this mirror, so there is no
 * button — the affordance is an instruction line. Battery + the connection glyph live in the
 * shell TopBar (VW-67); this only shifts its COPY on a known disconnect (VW-68), so a wall
 * that lost its cable says "connect a Voltra" rather than "waiting for a set".
 */

const t = getSemanticColors('dark');

/** titan's `FONT_MONO` for the panel eyebrow — the token itself is not exported. */
const EYEBROW_FONT = 'monospace';

/** The panel's `VELOCITY · this set` eyebrow, reproduced at its exact type spec. */
function PanelEyebrow({ children }: { children: string }): ReactElement {
  return (
    <Text
      style={{
        fontSize: 9,
        letterSpacing: 1.2,
        fontFamily: EYEBROW_FONT,
        color: t['text-tertiary'],
      }}
    >
      {children}
    </Text>
  );
}

/**
 * One section of the fatigue card: its label over the empty region that section will occupy.
 *
 * The label names a real section of titan's `LiveFatigueCard`, and the region is an outlined
 * void with a `PlaceholderStrip` — the same "planned, not yet performed" mark the session rail
 * uses — resting in it. Reserving the AREA is what makes the card read as an outline rather
 * than a list of headings, and an outlined void cannot be mistaken for a reading the way a
 * greyed-out number or a flat zero could.
 */
function CardSectionGhost({
  label,
  height,
  grow,
}: {
  label: string;
  height?: number;
  grow?: boolean;
}): ReactElement {
  return (
    <View style={grow ? { flex: 1, gap: 8 } : { gap: 8 }}>
      <PanelEyebrow>{label}</PanelEyebrow>
      <View
        style={{
          ...(grow ? { flex: 1 } : { height }),
          borderRadius: 8,
          borderWidth: 1,
          borderColor: t['hairline-subtle'],
          justifyContent: 'center',
          paddingHorizontal: 14,
        }}
      >
        <PlaceholderStrip />
      </View>
    </View>
  );
}

/**
 * The idle right-hand column: the fatigue card's frame and section rhythm with no verdict,
 * no ROM and no rep shapes in it. Matches `LiveFatigueCard`'s own box (318 wide, 14 radius,
 * 18 padding, hairline edge, `base` plane one step above the stage) so the real card lands
 * in the same rectangle, and lays its sections out in the same order: the exertion group at
 * the top, then ROM, then the rep-shape spark, the lower two sharing the leftover height.
 */
function IdleFatigueCard({ height }: { height: number }): ReactElement {
  return (
    <Surface
      level="base"
      testID="idle-fatigue-card"
      style={{
        width: FATIGUE_CARD_WIDTH,
        height,
        borderRadius: 14,
        padding: 18,
        borderWidth: 1,
        borderColor: t['hairline-default'],
        gap: 18,
      }}
    >
      {/* Top group — where the RPE/verdict hero and its three why-lights sit. `FATIGUE` is
          the live card's OWN eyebrow (titan's `VerdictHero`), reused verbatim so the word
          in this slot does not change when the card populates. */}
      <View style={{ gap: 12 }}>
        <CardSectionGhost label="FATIGUE" height={56} />
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {['VEL', 'ROM', 'TEMPO'].map((dimension) => (
            <View key={dimension} style={{ flex: 1 }}>
              <CardSectionGhost label={dimension} height={18} />
            </View>
          ))}
        </View>
      </View>
      <CardSectionGhost label="ROM · PER REP" grow />
      <CardSectionGhost label="REP SHAPE · TEMPO" grow />
    </Surface>
  );
}

/** The idle-copy variant for the current model — the three cases of VW-68, unchanged. */
function idleCopy(model: DashboardModel, disconnected: boolean) {
  if (disconnected) {
    return {
      icon: BluetoothIcon,
      title: 'No Voltra connected',
      description:
        'Connect a Voltra — live velocity, tempo and fatigue appear here once a set begins.',
    };
  }
  if (model.session.hasSession) {
    // A session is open — name it (a real name, or the neutral `Exercise N` ordinal;
    // the mapper never emits a bare em-dash here — VW-68).
    return {
      icon: DumbbellIcon,
      title: `Ready · ${model.session.exerciseName}`,
      description: 'Start the first set — live velocity, tempo and fatigue will appear here.',
    };
  }
  return {
    icon: DumbbellIcon,
    title: 'Waiting for a set',
    description: 'Start a set on the machine or from the MCP to see live velocity here.',
  };
}

/** The designed idle stage — replaces the blank `RestView` when `stageIsEmpty` (VW-68). */
export function EmptyLiveView({ model }: { model: DashboardModel }): ReactElement {
  const { session, connection } = model;
  // A KNOWN disconnect (the mapper folded a real connection status that says so). Undefined
  // connection = unknown ⇒ do NOT claim disconnected; the shell owns the authoritative banner.
  const disconnected = connection?.connected === false;
  const { icon, title, description } = idleCopy(model, disconnected);

  // Measured exactly as `SingleFatigueStage` measures it, so the panel that replaces this
  // stage gets the same `bodyHeight` and the geometry does not jump on the first rep.
  const [stageHeight, setStageHeight] = useState(0);
  const bodyHeight = panelBodyHeight(stageHeight);
  const heroHeight = heroPlotHeight(bodyHeight);

  const axisColor = useOnSurfaceColor('tertiary');

  return (
    <View
      style={{ flex: 1 }}
      onLayout={(e: LayoutChangeEvent) => setStageHeight(e.nativeEvent.layout.height)}
    >
      {/* `productive` = no flood: the same quiet ground the panel sits on before a verdict
          exists. Radius/border zeroed to match `SingleFatigueStage`'s full-bleed panel. */}
      <LiveAuraFrame
        category="productive"
        style={{ borderRadius: 0, borderWidth: 0 }}
        testID="empty-live-stage"
      >
        <View style={{ flex: 1 }}>
          <View
            style={{
              padding: PANEL_PAD,
              flexDirection: 'row',
              gap: PANEL_COLUMN_GAP,
              alignItems: 'stretch',
            }}
          >
            {/* PRIMARY — the velocity hero's footprint, holding the idle copy. */}
            <View style={{ flex: 1, gap: 8 }}>
              <PanelEyebrow>VELOCITY · this set</PanelEyebrow>
              <View style={{ height: heroHeight, justifyContent: 'space-between' }}>
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <EmptyState icon={icon} title={title} description={description} />
                  {/* Loaded weight — a real device echo (the plates currently on the cable).
                      Shown only when the settings cascade reported one; hidden under the mock
                      adapter, never a fabricated 0. Suppressed on a known disconnect (a stale
                      weight would mislead). */}
                  {!disconnected && session.weightLbs !== null && (
                    <MetricGroup>
                      <Metric
                        size="md"
                        value={String(session.weightLbs)}
                        unit={session.unit}
                        label="Loaded"
                      />
                    </MetricGroup>
                  )}
                </View>
                {/* The hero's baseline, with the reps still to come sitting on it. Segmented
                    to the PLANNED rep count when the prescription gives one; otherwise a
                    single undifferentiated rule, because we do not know how many reps. */}
                <View style={{ gap: 10 }}>
                  <PlaceholderStrip
                    mode={session.targetReps != null ? 'segmented' : 'single'}
                    segments={session.targetReps ?? undefined}
                  />
                  <View
                    style={{
                      height: 2,
                      borderRadius: 1,
                      backgroundColor: axisColor,
                      opacity: 0.35,
                    }}
                  />
                </View>
              </View>
            </View>
            {/* SECONDARY — the fatigue card's outline. */}
            <IdleFatigueCard height={bodyHeight} />
          </View>
        </View>
      </LiveAuraFrame>
    </View>
  );
}
