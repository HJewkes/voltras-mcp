// Font mapping: font-heading=Space Grotesk, font-body=Nunito Sans (UI), font-sans=Inter (body)
import { useState, type ReactElement } from 'react';
import { View, Text, type LayoutChangeEvent } from 'react-native';
import {
  LiveAuraFrame,
  VelocityStrip,
  TempoDisplay,
  SetsRepsLoad,
  ActivityIcon,
  AlertTriangleIcon,
  CircleSlashIcon,
  Tooltip,
  getSemanticColors,
  alpha,
  neumorphicShadows,
  type IconProps,
} from '@titan-design/react-ui';
import { type DashboardModel, type LiveDashboardModel, verdictFromLoss } from './model';

const t = getSemanticColors('dark');

/** Raised-card elevation shared by the alert + tempo cards. */
const CARD_SHADOW = neumorphicShadows.charcoal.raised.medium;
/** One row height for the tempo + alert cards, so they line up regardless of tempo font size. */
const CONTROL_HEIGHT = 34;
/** The tempo card ground — mirrors TempoDisplay's own charcoal so a shorter inner pill reads seamless. */
const TEMPO_GROUND = '#1C1C1C';

/** Clamped linear interpolation of `v` between `vLo..vHi` as `w` runs `wLo..wHi`. */
function clampLerp(w: number, wLo: number, wHi: number, vLo: number, vHi: number): number {
  if (w <= wLo) return vLo;
  if (w >= wHi) return vHi;
  return vLo + ((w - wLo) / (wHi - wLo)) * (vHi - vLo);
}

// --- Voltra slot --------------------------------------------------------------

/** Which Voltra a live view is reading from — for dual mode and multi-device sessions. */
export type VoltraSlot = 'L' | 'R';

const SLOT_META: Record<VoltraSlot, { label: string }> = {
  L: { label: 'LEFT VOLTRA' },
  R: { label: 'RIGHT VOLTRA' },
};

/** The voltra name set vertically down the far-left edge of a layer (dual / multi-device). */
function VerticalSlotLabel({ slot }: { slot: VoltraSlot }) {
  const { label } = SLOT_META[slot];
  return (
    <View
      className="border-border"
      style={{ width: 34, alignItems: 'center', justifyContent: 'center', borderRightWidth: 1 }}
    >
      {/* Fixed width holds the full label before rotation (a bare rotate clips to the strip). */}
      <Text
        className="text-text-tertiary"
        style={{
          width: 150,
          textAlign: 'center',
          fontSize: 12,
          fontWeight: '700',
          letterSpacing: 3,
          transform: [{ rotate: '-90deg' }],
        }}
      >
        {label}
      </Text>
    </View>
  );
}

// --- Alert cue ----------------------------------------------------------------

type Verdict = 'productive' | 'threshold' | 'stop';
const STATUS_COLOR: Record<Verdict, string> = {
  productive: t['status-success'],
  threshold: t['status-warning'],
  stop: t['status-error'],
};
const VERDICT_LABEL: Record<Verdict, string> = {
  productive: 'Productive',
  threshold: 'Threshold',
  stop: 'Stop',
};
// A CONTEXTUAL glyph keyed on proximity to the velocity-loss threshold (replaces the flat
// colour dot): a healthy pulse well under, a warning triangle at the threshold band, a
// slashed circle once past it.
const STATUS_ICON: Record<Verdict, (props: IconProps) => ReactElement> = {
  productive: ActivityIcon,
  threshold: AlertTriangleIcon,
  stop: CircleSlashIcon,
};

/** How much of the alert survives at the current width. */
export type AlertMode = 'full' | 'compact' | 'icon';

/** The tinted alert surface (border + wash + raised shadow) shared by the card and the icon pill. */
function alertSurface(tone: string) {
  return {
    borderWidth: 1,
    borderColor: alpha(tone, 0.45),
    backgroundColor: alpha(tone, 0.14),
    ...CARD_SHADOW,
  };
}

/**
 * The single status element — a tinted alert card carrying the exertion message. It sheds
 * detail as space tightens: `full` shows the contextual icon + verdict + inline message
 * (capped at `availWidth` so it ellipsises + keeps a hover tip rather than running off-page);
 * `compact` drops the message to the tip; `icon` collapses to just the contextual glyph,
 * verdict + message on hover.
 */
function AlertCue({
  status,
  message,
  mode,
  availWidth,
}: {
  status: Verdict;
  message: string;
  mode: AlertMode;
  /** Pixels the alert may occupy (row width − tempo − gap); caps the card so the message clips. */
  availWidth?: number;
}) {
  const tone = STATUS_COLOR[status];
  const Icon = STATUS_ICON[status];
  const meaningful = status === 'threshold' || status === 'stop';

  // Tightest: icon-only pill. Verdict + message live in the hover tip.
  if (mode === 'icon') {
    const pill = (
      <View
        style={{
          width: CONTROL_HEIGHT,
          height: CONTROL_HEIGHT,
          borderRadius: 9,
          alignItems: 'center',
          justifyContent: 'center',
          ...alertSurface(tone),
        }}
      >
        <Icon size={17} color={tone} />
      </View>
    );
    return meaningful ? (
      <Tooltip label={`${VERDICT_LABEL[status]} · ${message}`} placement="bottom">
        {pill}
      </Tooltip>
    ) : (
      pill
    );
  }

  const card = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        height: CONTROL_HEIGHT,
        // Concrete px cap (not %) so the single-line message ellipsises through the wrapper chain.
        maxWidth: availWidth,
        borderRadius: 10,
        paddingHorizontal: 12,
        ...alertSurface(tone),
      }}
    >
      <Icon size={15} color={tone} />
      <Text style={{ color: tone, fontSize: 13, fontWeight: '700', flexShrink: 0 }}>
        {VERDICT_LABEL[status]}
      </Text>
      {mode === 'full' && meaningful && (
        // Bounded + single-line: ellipsises instead of pushing off the page (full text on hover).
        <Text
          numberOfLines={1}
          style={{ color: tone, fontSize: 13, fontWeight: '600', flexShrink: 1, minWidth: 0 }}
        >
          · {message}
        </Text>
      )}
    </View>
  );
  // Keep the full message a hover away whenever it isn't fully spelled out (compact) or may be
  // clipped (full → ellipsis).
  return meaningful ? (
    <Tooltip label={message} placement="bottom">
      {card}
    </Tooltip>
  ) : (
    card
  );
}

// --- Live tempo phase mapping -------------------------------------------------

/** Map the model's movement phase onto TempoDisplay's live-fill phase key. */
function mapLivePhase(
  phase: NonNullable<DashboardModel['live']>['phase'],
): 'eccentric' | 'pauseBottom' | 'concentric' | null {
  switch (phase) {
    case 'concentric':
      return 'concentric';
    case 'eccentric':
      return 'eccentric';
    case 'hold':
      return 'pauseBottom';
    default:
      return null;
  }
}

// --- Page-level exercise header -----------------------------------------------

/** Below this header width the targets line wraps under the name (at the set-heading ratio). */
const HEADER_WRAP = 480;
/** At/above this header width the targets render at full size. */
const HEADER_WIDE = 760;
/** Targets:name size ratio on the wrapped second line — matches ExerciseHeading (11 / 14). */
const SET_HEADING_RATIO = 11 / 14;
const HEADER_NAME_SIZE = 30;

/**
 * The prescription line's values, or null when the store cannot supply them.
 *
 * All three must be real: `SetsRepsLoad` takes plain numbers and renders them as a
 * confident `4 × 8 @ 140 lb` prescription, so a missing piece cannot be shown as blank —
 * it would read as a prescribed zero. Partial data therefore hides the whole line
 * (VW-41/42 wire the missing pieces; the weight-seed gap leaves load null under mock).
 */
function resolveTargets(
  session: DashboardModel['session'],
): { sets: number; reps: number; load: number } | null {
  const { plannedSets, targetReps, weightLbs } = session;
  if (plannedSets === null || targetReps === null || weightLbs === null) return null;
  return { sets: plannedSets, reps: targetReps, load: weightLbs };
}

/**
 * The workout title + targets — the exercise being performed, independent of how many
 * voltras drive it, so it lives at the TOP OF THE PAGE (above the live stage) and stays
 * visible across single/dual. The targets shrink with width and only wrap under the name
 * (at the set-heading size ratio) once too tight to shrink further. NOT a published component.
 */
export function ExerciseHeader({ session }: { session: DashboardModel['session'] }) {
  const [w, setW] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width);
  const targets = resolveTargets(session);
  const wrap = w > 0 && w < HEADER_WRAP;
  const targetSize = wrap
    ? Math.round(HEADER_NAME_SIZE * SET_HEADING_RATIO) // set-heading ratio on the second line
    : Math.round(clampLerp(w || HEADER_WIDE, HEADER_WRAP, HEADER_WIDE, 22, 28));

  return (
    <View
      onLayout={onLayout}
      className="border-border"
      style={{
        flexDirection: wrap ? 'column' : 'row',
        alignItems: wrap ? 'flex-start' : 'baseline',
        justifyContent: 'space-between',
        gap: wrap ? 4 : 22,
        paddingHorizontal: 24,
        paddingTop: 20,
        paddingBottom: 16,
        borderBottomWidth: 1,
      }}
    >
      <Text
        className="text-text-primary"
        style={{
          fontSize: HEADER_NAME_SIZE,
          fontFamily: '"Space Grotesk", sans-serif',
          fontWeight: '700',
        }}
      >
        {session.exerciseName}
      </Text>
      {/* targets: pinned right when inline, tucked under the name (smaller) when wrapped.
          Hidden outright when the prescription is unknown — SetsRepsLoad needs real
          sets/reps/load, and a `0 × — @ 0` line is worse than no line. */}
      {targets && (
        <SetsRepsLoad
          sets={targets.sets}
          reps={targets.reps}
          load={targets.load}
          unit={session.unit}
          fontSize={targetSize}
        />
      )}
    </View>
  );
}

// --- Live stage ---------------------------------------------------------------

/** Below this content width the alert drops its inline message to a hover tip. */
const ALERT_COMPACT = 620;
/** Below this content width the alert collapses to just its contextual icon. */
const ALERT_ICON = 430;
/** Tempo digit size at rest — matched to sit within {@link CONTROL_HEIGHT}. */
const TEMPO_BASE_FONT = 18;
/** Content width at which the tempo has shrunk as far as it goes (near the panel min). */
const TEMPO_SHRINK_FLOOR = 300;

/**
 * Lab specimen — the LIVE (mid-set) stage of one voltra. The exercise identity + targets
 * are the PAGE header ({@link ExerciseHeader}); this layer carries only per-voltra live
 * data: an optional vertical slot label (far left), the alert + live tempo in a row, and
 * the velocity hero. NOT a published component.
 *
 * `side` renders this as one LAYER of a dual-mode set; `slot` names the active voltra in a
 * single-view multi-device session. Either shows the vertical slot label.
 */
export function LiveView({
  model,
  side,
  slot,
}: {
  model: LiveDashboardModel;
  side?: 'left' | 'right';
  slot?: VoltraSlot;
}) {
  const { live, session } = model;
  const verdict = verdictFromLoss(live.velocityLossPct);
  const dual = side != null;
  const badgeSlot: VoltraSlot | null = side ? (side === 'left' ? 'L' : 'R') : (slot ?? null);

  const [contentW, setContentW] = useState(0);
  const onContentLayout = (e: LayoutChangeEvent) => setContentW(e.nativeEvent.layout.width);
  const [rowW, setRowW] = useState(0);
  const onRowLayout = (e: LayoutChangeEvent) => setRowW(e.nativeEvent.layout.width);
  const [tempoW, setTempoW] = useState(0);
  const onTempoLayout = (e: LayoutChangeEvent) => setTempoW(e.nativeEvent.layout.width);
  // The alert sheds detail first (message → verdict → icon); the tempo holds its full size
  // until the alert can't shrink any further, then it takes over shrinking.
  const alertMode: AlertMode =
    contentW === 0 || contentW >= ALERT_COMPACT
      ? 'full'
      : contentW >= ALERT_ICON
        ? 'compact'
        : 'icon';
  const tempoFont =
    contentW === 0 || contentW >= ALERT_ICON
      ? TEMPO_BASE_FONT
      : Math.round(clampLerp(contentW, TEMPO_SHRINK_FLOOR, ALERT_ICON, 14, TEMPO_BASE_FONT));
  // Tempo is optional: a set may have no prescribed tempo — then the card is hidden entirely
  // and the alert takes the whole row.
  const hasTempo = session.tempo != null;
  // Width the alert may take — measured off the ROW (inside the panel padding) so a long
  // message ellipsises at the side margin rather than running to the panel edge. With no tempo
  // card the alert gets the full row; otherwise it's the row minus the (measured) tempo + gap.
  const CONTROLS_GAP = 16;
  const alertAvail =
    rowW > 0
      ? hasTempo
        ? tempoW > 0
          ? Math.max(0, rowW - tempoW - CONTROLS_GAP)
          : undefined
        : rowW
      : undefined;

  const [heroH, setHeroH] = useState(0);
  const onHeroLayout = (e: LayoutChangeEvent) => setHeroH(e.nativeEvent.layout.height);
  const heroHeight = heroH > 0 ? heroH : dual ? 200 : 320;

  const activePhase = mapLivePhase(live.phase);
  const message = `VL${live.velocityLossPct} · approaching threshold — 1–2 productive reps left`;

  return (
    // head verdict → full-surface aura flood; fills its section edge-to-edge — squared off
    // (no radius/border), since it's the section background, not a card within it.
    <LiveAuraFrame category={verdict} style={{ flex: 1, borderRadius: 0, borderWidth: 0 }}>
      <View style={{ flex: 1, flexDirection: 'row' }}>
        {badgeSlot && <VerticalSlotLabel slot={badgeSlot} />}
        <View
          onLayout={onContentLayout}
          style={{ flex: 1, padding: dual ? 18 : 24, gap: dual ? 8 : 10 }}
        >
          {/* controls row: tempo upper-left (when prescribed), alert upper-right. With no tempo
              the alert simply pins right (flex-end); otherwise they split (space-between). */}
          <View
            onLayout={onRowLayout}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: CONTROLS_GAP,
              justifyContent: hasTempo ? 'space-between' : 'flex-end',
            }}
          >
            {/* tempo card — locked to the alert's height (this view only); the inner TempoDisplay
                shrinks its font but stays centred on the shared charcoal ground so it reads seamless. */}
            {session.tempo != null && (
              <View
                onLayout={onTempoLayout}
                style={{
                  height: CONTROL_HEIGHT,
                  justifyContent: 'center',
                  alignItems: 'flex-start',
                  backgroundColor: TEMPO_GROUND,
                  borderRadius: 9,
                  overflow: 'hidden',
                  ...CARD_SHADOW,
                }}
              >
                <TempoDisplay
                  tempo={session.tempo}
                  fontSize={tempoFont}
                  live={
                    activePhase ? { activePhase, phaseElapsedMs: live.phaseElapsedMs } : undefined
                  }
                  showLabel={false}
                  showInfo={false}
                />
              </View>
            )}
            <AlertCue status={verdict} message={message} mode={alertMode} availWidth={alertAvail} />
          </View>

          {/* the velocity hero fills the rest. */}
          <View style={{ flex: 1 }} onLayout={onHeroLayout}>
            <VelocityStrip
              variant="hero"
              velocities={live.repVelocities}
              liveRepIndex={live.repVelocities.length - 1}
              targetReps={session.targetReps ?? undefined}
              height={heroHeight}
              scale="peak"
            />
          </View>
        </View>
      </View>
    </LiveAuraFrame>
  );
}
