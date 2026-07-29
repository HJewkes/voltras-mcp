// Font mapping: font-heading=Space Grotesk, font-body=Nunito Sans (UI), font-sans=Inter (body)
import { useState, type ReactElement } from 'react';
import { View, Text, type LayoutChangeEvent } from 'react-native';
import {
  LiveAuraFrame,
  VelocityStrip,
  TempoDisplay,
  SetsRepsLoad,
  SetStrip,
  ActivityIcon,
  AlertTriangleIcon,
  CircleSlashIcon,
  Tooltip,
  getSemanticColors,
  useOnSurfaceColor,
  alpha,
  type IconProps,
} from '@titan-design/react-ui';
import {
  type DashboardModel,
  type LiveDashboardModel,
  deriveActiveSetStates,
  derivePrescription,
  verdictFromLoss,
} from './model';
import { type MassUnit } from './mass';
import { exertionMessage } from './live-copy';

// Verdict STATUS tones (success/warning/error) for the alert cue — semantic status colours,
// not on-surface text roles, so they come from the token map rather than `useOnSurfaceColor`.
// The stage sits on the LiveAuraFrame (its own verdict-flooded plane), not a charcoal Surface;
// the text below resolves via the on-surface context seeded by the LivePage Surface root.
const t = getSemanticColors('dark');

/**
 * Raised-card separation, as a HAIRLINE rather than a shadow.
 *
 * titan 0.12.0 deleted `neumorphicShadows`, and the reason matters here: the
 * treatment needs a mid-tone ground (~75-90% L) for its dark half to fall onto.
 * These cards sit near 10% L, so that half was already collapsing and the cards
 * were carrying a one-sided smudge rather than the elevation they asked for.
 *
 * An INSET ring rather than a border, deliberately — a real `borderWidth` would
 * add a pixel to a card whose height is pinned to CONTROL_HEIGHT so it lines up
 * with its neighbour, and would push the inner content on a surface that is
 * already `overflow: 'hidden'`.
 */
const CARD_EDGE = { boxShadow: `inset 0 0 0 1px ${t['hairline-default']}` } as const;
/** One row height for the tempo + alert cards, so they line up regardless of tempo font size. */
const CONTROL_HEIGHT = 34;
/** Gap between the tempo card and the alert — also subtracted from the alert's budget. */
const CONTROLS_GAP = 16;
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
export function VerticalSlotLabel({ slot }: { slot: VoltraSlot }) {
  const { label } = SLOT_META[slot];
  const labelColor = useOnSurfaceColor('tertiary');
  return (
    <View
      className="border-border"
      style={{ width: 34, alignItems: 'center', justifyContent: 'center', borderRightWidth: 1 }}
    >
      {/* Fixed width holds the full label before rotation (a bare rotate clips to the strip). */}
      <Text
        style={{
          color: labelColor,
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
    // No CARD_EDGE here: this surface already carries its own TINTED border, and
    // the tint is the point — it names the verdict. A neutral hairline on top
    // would only mute it.
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

/** Page-header strip height — the rail's 8px bar, thickened for the wall read. */
const HEADER_STRIP_HEIGHT = 10;
/** Tempo digit size in the header — the rail's compact chip, raised for the wall read. */
const HEADER_TEMPO_FONT = 13;
/**
 * The workout title + targets — the exercise being performed, independent of how many
 * voltras drive it, so it lives at the TOP OF THE PAGE (above the live stage) and stays
 * visible across single/dual. NOT a published component.
 *
 * Two rows, per the north-star lockup: the name left with the `sets × reps @ load`
 * prescription pinned right at wall scale, then the per-set {@link SetStrip} running the
 * remaining width under the name with the prescribed tempo tucked right under the lockup.
 * The prescription shrinks with width and only wraps under the name (at the set-heading
 * size ratio) once too tight to shrink further.
 *
 * The strip is the ACTIVE exercise only — the rail keeps its own per-exercise rows, and
 * both read {@link deriveActiveSetStates} so they cannot disagree. Each element hides
 * independently when its data is absent: no prescription ⇒ no lockup, no sets ⇒ no strip,
 * no prescribed tempo ⇒ no tempo (a coach may genuinely leave it unset).
 */
export function ExerciseHeader({
  model,
  displayUnit = 'lbs',
}: {
  model: DashboardModel;
  /** Client DISPLAY unit for the load readout (VW-63). Store weight stays lbs. */
  displayUnit?: MassUnit;
}) {
  const [w, setW] = useState(0);
  // Hoisted above the early return so the hook count stays stable (rules of hooks). On-surface
  // primary text from the Surface context — see the note at the heading below.
  const nameColor = useOnSurfaceColor('primary');
  const onLayout = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width);
  const { session } = model;
  const targets = derivePrescription(session, displayUnit);
  const setStates = deriveActiveSetStates(model);
  const wrap = w > 0 && w < HEADER_WRAP;
  const targetSize = wrap
    ? Math.round(HEADER_NAME_SIZE * SET_HEADING_RATIO) // set-heading ratio on the second line
    : Math.round(clampLerp(w || HEADER_WIDE, HEADER_WRAP, HEADER_WIDE, 22, 28));

  // No open session ⇒ no exercise to title (VW-68). Hide the header rather than showing the
  // `Exercise N` ordinal for a wall that is merely idle/waiting. (Hooks above run first.)
  if (!session.hasSession) return null;

  return (
    <View
      onLayout={onLayout}
      className="border-border"
      style={{
        paddingHorizontal: 24,
        paddingTop: 20,
        paddingBottom: 16,
        borderBottomWidth: 1,
        gap: 10,
      }}
    >
      <View
        style={{
          flexDirection: wrap ? 'column' : 'row',
          alignItems: wrap ? 'flex-start' : 'baseline',
          justifyContent: 'space-between',
          gap: wrap ? 4 : 22,
        }}
      >
        <Text
          style={{
            // On-surface primary text from the Surface context (LivePage's Surface root), not the
            // `text-text-primary` className — the className→CSS-var path renders black on the
            // standalone wall SPA (the var only exists inside titan's themed provider). The hook
            // returns literal hex, so the stage heading stays legible.
            color: nameColor,
            fontSize: HEADER_NAME_SIZE,
            fontFamily: '"Space Grotesk", sans-serif',
            fontWeight: '700',
          }}
        >
          {session.exerciseName}
        </Text>
        {/* targets: pinned right when inline, tucked under the name (smaller) when wrapped. */}
        {targets && (
          <SetsRepsLoad
            sets={targets.sets}
            reps={targets.reps}
            load={targets.load}
            unit={targets.unit}
            fontSize={targetSize}
          />
        )}
      </View>
      {/* Strip + tempo. The whole row goes when it would carry neither, so the header
          collapses back to its one-line form rather than leaving a hairline of padding. */}
      {(setStates.length > 0 || session.tempo) && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          <View style={{ flex: 1 }}>
            {setStates.length > 0 && <SetStrip sets={setStates} height={HEADER_STRIP_HEIGHT} />}
          </View>
          {/* The rail row's compact tempo chip verbatim (label + info off), sized up for
              the wall — the prescribed tempo, NOT the live phase-fill on the stage. */}
          {session.tempo && (
            <TempoDisplay
              tempo={session.tempo}
              size="sm"
              fontSize={HEADER_TEMPO_FONT}
              showLabel={false}
              showInfo={false}
            />
          )}
        </View>
      )}
    </View>
  );
}

// --- Shared controls row ------------------------------------------------------

/**
 * The tempo card + exertion alert that sit above a velocity hero, with all the
 * shed-detail sizing that makes them survive a narrow panel.
 *
 * Extracted when the diverging dual stage (VMCP-04.05) became a second consumer.
 * The single {@link LiveView} and the dual stage show the SAME row: tempo is
 * prescribed per set, and the exertion verdict describes the athlete, not a limb
 * (see `LiveFatigueModel` — "there is exactly ONE of these cards even when two
 * devices are live"). Duplicating the sizing logic would have been two things to
 * keep in step for no gain.
 *
 * `containerWidth` is passed IN rather than measured here on purpose: the caller
 * already measures its content box, and re-measuring inside the row would shift
 * the breakpoints by the caller's padding — a silent visual change to the shipped
 * single view. The caller owns the reference width; this owns what to do with it.
 */
export function LiveControlsRow({
  tempo,
  verdict,
  message,
  containerWidth,
  livePhase,
  phaseElapsedMs,
}: {
  tempo: DashboardModel['session']['tempo'];
  verdict: Verdict;
  message: string;
  containerWidth: number;
  /** The model's raw movement phase — mapped to TempoDisplay's key HERE, so no caller
   *  has to know the mapping (and none can quietly pass `null` and lose the live fill). */
  livePhase: NonNullable<DashboardModel['live']>['phase'];
  phaseElapsedMs: number;
}) {
  const activePhase = mapLivePhase(livePhase);
  const [rowW, setRowW] = useState(0);
  const [tempoW, setTempoW] = useState(0);

  // The alert sheds detail first (message → verdict → icon); the tempo holds its full size
  // until the alert can't shrink any further, then it takes over shrinking.
  const alertMode: AlertMode =
    containerWidth === 0 || containerWidth >= ALERT_COMPACT
      ? 'full'
      : containerWidth >= ALERT_ICON
        ? 'compact'
        : 'icon';
  const tempoFont =
    containerWidth === 0 || containerWidth >= ALERT_ICON
      ? TEMPO_BASE_FONT
      : Math.round(clampLerp(containerWidth, TEMPO_SHRINK_FLOOR, ALERT_ICON, 14, TEMPO_BASE_FONT));

  // Tempo is optional: a set may have no prescribed tempo — then the card is hidden
  // entirely and the alert takes the whole row.
  const hasTempo = tempo != null;
  // Width the alert may take — measured off the ROW (inside the panel padding) so a long
  // message ellipsises at the side margin rather than running to the panel edge.
  const alertAvail =
    rowW > 0
      ? hasTempo
        ? tempoW > 0
          ? Math.max(0, rowW - tempoW - CONTROLS_GAP)
          : undefined
        : rowW
      : undefined;

  return (
    <View
      onLayout={(e: LayoutChangeEvent) => setRowW(e.nativeEvent.layout.width)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: CONTROLS_GAP,
        justifyContent: hasTempo ? 'space-between' : 'flex-end',
      }}
    >
      {/* tempo card — locked to the alert's height; the inner TempoDisplay shrinks its font
          but stays centred on the shared charcoal ground so it reads seamless. */}
      {tempo != null && (
        <View
          onLayout={(e: LayoutChangeEvent) => setTempoW(e.nativeEvent.layout.width)}
          style={{
            height: CONTROL_HEIGHT,
            justifyContent: 'center',
            alignItems: 'flex-start',
            backgroundColor: TEMPO_GROUND,
            borderRadius: 9,
            overflow: 'hidden',
            ...CARD_EDGE,
          }}
        >
          <TempoDisplay
            tempo={tempo}
            fontSize={tempoFont}
            live={activePhase ? { activePhase, phaseElapsedMs } : undefined}
            showLabel={false}
            showInfo={false}
          />
        </View>
      )}
      <AlertCue status={verdict} message={message} mode={alertMode} availWidth={alertAvail} />
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

  const [heroH, setHeroH] = useState(0);
  const onHeroLayout = (e: LayoutChangeEvent) => setHeroH(e.nativeEvent.layout.height);
  const heroHeight = heroH > 0 ? heroH : dual ? 200 : 320;

  const message = exertionMessage(live.velocityLossPct);

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
          {/* controls row: tempo upper-left (when prescribed), alert upper-right. Shared with
              the diverging dual stage — see {@link LiveControlsRow}. */}
          <LiveControlsRow
            tempo={session.tempo}
            verdict={verdict}
            message={message}
            containerWidth={contentW}
            livePhase={live.phase}
            phaseElapsedMs={live.phaseElapsedMs}
          />

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
